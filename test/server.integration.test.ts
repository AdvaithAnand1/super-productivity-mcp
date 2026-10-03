import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { SuperProductivityClient } from '../src/sp-client.js';
import {
  errorResponse,
  responseText,
  successResponse,
  testConfig,
  testLogger,
  testTask,
} from './helpers.js';

describe('MCP server integration over an in-memory transport', () => {
  it('exposes explicit tools and keeps selection separate from Today planning', async () => {
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const task = testTask({ id: 'task-1', title: 'Ship the feature' });
    const updatedTask = testTask({ id: 'task-1', title: 'Ship the feature', dueDay: todayString });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/health' && (init?.method ?? 'GET') === 'GET') {
        return successResponse({ server: 'up', rendererReady: true });
      }
      if (url.pathname === '/tasks' && (init?.method ?? 'GET') === 'GET') {
        return successResponse([task]);
      }
      if (url.pathname === '/tasks/task-1' && init?.method === 'PATCH') {
        expect(init.body).toBe(JSON.stringify({ dueDay: todayString, dueWithTime: null }));
        return successResponse(updatedTask);
      }
      throw new Error(`Unexpected mocked API request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const connectionResult = await mcpClient.callTool({
      name: 'check_connection',
      arguments: {},
    });
    const connection = JSON.parse(responseText(connectionResult));
    expect(connection.connected).toBe(true);
    expect(connection.configured).toBe(true);
    expect(connection.tokenConfigured).toBe(false);
    expect(connection.semanticApi).toEqual({ available: false, configured: false });

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'health',
        'check_connection',
        'search_tasks',
        'query_task_queue',
        'get_task',
        'list_projects',
        'list_tags',
        'create_task',
        'update_task',
        'add_task_link_attachment',
        'rename_task_attachment',
        'detach_task_attachment',
        'update_task_tags',
        'bulk_update_tasks',
        'list_today',
        'plan_task_today',
        'start_task',
        'stop_timer',
        'complete_task',
        'get_current_task',
        'ensure_github_issue_task',
      ]),
    );

    const searchResult = await mcpClient.callTool({
      name: 'search_tasks',
      arguments: { query: 'Ship', limit: 10 },
    });
    expect(JSON.parse(responseText(searchResult)).tasks[0].id).toBe('task-1');

    const planResult = await mcpClient.callTool({
      name: 'plan_task_today',
      arguments: { taskId: 'task-1' },
    });
    expect(JSON.parse(responseText(planResult)).plannedForToday).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    await mcpClient.close();
    await server.close();
  });

  it('reads full task metadata and resolves related names without per-child requests', async () => {
    const task = testTask({
      id: 'task-1',
      title: 'Parent',
      projectId: 'project-1',
      tagIds: ['tag-1'],
      subTaskIds: ['task-2'],
      deadlineDay: '2026-10-08',
      futureMetadata: { preserved: true },
    });
    const child = testTask({ id: 'task-2', title: 'Child', parentId: 'task-1' });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks/task-1') return successResponse(task);
      if (url.pathname === '/tasks') return successResponse([task, child]);
      if (url.pathname === '/projects') {
        return successResponse([{ id: 'project-1', title: 'Course work' }]);
      }
      if (url.pathname === '/tags') return successResponse([{ id: 'tag-1', title: 'Assignments' }]);
      throw new Error(`Unexpected mocked API request: ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const result = await mcpClient.callTool({
      name: 'get_task',
      arguments: { taskId: 'task-1' },
    });
    const data = JSON.parse(responseText(result));
    expect(data.task.deadlineDay).toBe('2026-10-08');
    expect(data.task.futureMetadata).toEqual({ preserved: true });
    expect(data.context.project).toEqual({ id: 'project-1', title: 'Course work' });
    expect(data.context.tags).toEqual([{ id: 'tag-1', title: 'Assignments' }]);
    expect(data.context.subtasks.map((item: { id: string }) => item.id)).toEqual(['task-2']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await mcpClient.close();
    await server.close();
  });

  it('falls back to the all-tasks listing when direct lookup targets an archived task', async () => {
    const archivedTask = testTask({ id: 'archived-1', title: 'Archived', archivedMetadata: true });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks/archived-1') {
        return errorResponse('TASK_NOT_FOUND', 'Task not found', 404);
      }
      if (url.pathname === '/tasks') return successResponse([archivedTask]);
      if (url.pathname === '/projects' || url.pathname === '/tags') return successResponse([]);
      throw new Error(`Unexpected mocked API request: ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const result = await mcpClient.callTool({
      name: 'get_task',
      arguments: { taskId: 'archived-1' },
    });
    expect(JSON.parse(responseText(result)).task.archivedMetadata).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await mcpClient.close();
    await server.close();
  });

  it('creates tasks and applies sparse updates while preserving unrelated metadata', async () => {
    const original = testTask({
      notes: 'Keep this',
      timeEstimate: 45,
      tagIds: ['tag-existing'],
      futureMetadata: 'untouched',
    });
    const updated = { ...original, title: 'Renamed task' };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/projects') {
        return successResponse([{ id: 'project-1', title: 'Course work' }]);
      }
      if (url.pathname === '/tags') {
        return successResponse([
          { id: 'tag-1', title: 'Assignments' },
          { id: 'tag-existing', title: 'Personal' },
        ]);
      }
      if (url.pathname === '/tasks/task-1' && init?.method === 'GET') {
        return successResponse(original);
      }
      if (init?.method === 'POST') {
        const input = JSON.parse(String(init.body));
        expect(input).toEqual({
          title: 'A title with #literal syntax',
          notes: '',
          timeEstimate: 30,
          projectId: 'project-1',
          tagIds: ['tag-1'],
          isIgnoreShortSyntax: true,
        });
        return successResponse(
          testTask({ ...input, id: 'created-task', projectId: 'project-1', tagIds: ['tag-1'] }),
          201,
        );
      }
      if (init?.method === 'PATCH') {
        if (String(init.body) === JSON.stringify({ title: 'Renamed task' })) {
          return successResponse(updated);
        }
        expect(init.body).toBe(JSON.stringify({ tagIds: ['tag-existing', 'tag-1'] }));
        return successResponse({ ...original, tagIds: ['tag-existing', 'tag-1'] });
      }
      throw new Error(`Unexpected mocked API method: ${init?.method}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const createdResult = await mcpClient.callTool({
      name: 'create_task',
      arguments: {
        title: 'A title with #literal syntax',
        notes: '',
        timeEstimate: 30,
        projectName: 'Course work',
        tagNames: ['Assignments'],
      },
    });
    expect(JSON.parse(responseText(createdResult)).task.id).toBe('created-task');

    const updatedResult = await mcpClient.callTool({
      name: 'update_task',
      arguments: { taskId: 'task-1', title: 'Renamed task' },
    });
    const update = JSON.parse(responseText(updatedResult));
    expect(update.task.title).toBe('Renamed task');
    expect(update.task.notes).toBe('Keep this');
    expect(update.task.timeEstimate).toBe(45);
    expect(update.task.futureMetadata).toBe('untouched');

    const tagResult = await mcpClient.callTool({
      name: 'update_task_tags',
      arguments: { taskId: 'task-1', addTagNames: ['Assignments'] },
    });
    const tagUpdate = JSON.parse(responseText(tagResult));
    expect(tagUpdate.task.tagIds).toEqual(['tag-existing', 'tag-1']);
    expect(tagUpdate.task.notes).toBe('Keep this');
    expect(tagUpdate.task.futureMetadata).toBe('untouched');
    expect(fetchMock).toHaveBeenCalledTimes(8);
    await mcpClient.close();
    await server.close();
  });

  it('previews bulk updates by default and applies explicit rows sequentially', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks' && (init?.method ?? 'GET') === 'GET') {
        return successResponse([testTask({ id: 'task-1' }), testTask({ id: 'task-2' })]);
      }
      if (
        (url.pathname === '/tasks/task-1' || url.pathname === '/tasks/task-2') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return successResponse(testTask({ id: url.pathname.split('/').pop() }));
      }
      if (url.pathname === '/tasks/task-1' && init?.method === 'PATCH') {
        const changes = JSON.parse(String(init.body));
        return successResponse(testTask({ id: 'task-1', ...changes }));
      }
      if (url.pathname === '/tasks/task-2' && init?.method === 'PATCH') {
        const changes = JSON.parse(String(init.body));
        return successResponse(testTask({ id: 'task-2', ...changes }));
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    const updates = [
      { taskId: 'task-1', changes: { title: 'First' } },
      { taskId: 'task-2', changes: { title: 'Second' } },
    ];
    const preview = await mcpClient.callTool({ name: 'bulk_update_tasks', arguments: { updates } });
    expect(JSON.parse(responseText(preview)).dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const applied = await mcpClient.callTool({
      name: 'bulk_update_tasks',
      arguments: { updates, dryRun: false },
    });
    expect(
      JSON.parse(responseText(applied)).results.map((row: { status: string }) => row.status),
    ).toEqual(['updated', 'updated']);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PATCH', 'PATCH']);
    await mcpClient.close();
    await server.close();
  });

  it('refuses ambiguous project names without creating a task', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/projects') {
        return successResponse([
          { id: 'project-1', title: 'Course work' },
          { id: 'project-2', title: 'Course work' },
        ]);
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const result = await mcpClient.callTool({
      name: 'create_task',
      arguments: { title: 'Do not guess', projectName: 'Course work' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(responseText(result)).error.code).toBe('AMBIGUOUS_NAME');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await mcpClient.close();
    await server.close();
  });

  it('routes priority changes through the negotiated enhanced semantic API and confirms the task', async () => {
    const restFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks/task-1' && (init?.method ?? 'GET') === 'GET') {
        return successResponse(testTask({ priority: null }));
      }
      throw new Error(`Unexpected REST request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const semanticFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/bridge/capabilities')
        return successResponse({
          protocolVersion: '1',
          superProductivityVersion: '1.0.0',
          features: ['task.priority.set'],
        });
      expect(url.pathname).toBe('/bridge/tasks/task-1/priority');
      expect(init?.method).toBe('PATCH');
      expect(init?.body).toBe(JSON.stringify({ priority: 3 }));
      return successResponse(testTask({ priority: 3 }));
    });
    const logger = testLogger();
    const config = testConfig({ semanticApiUrl: new URL('http://127.0.0.1:3876/bridge/') });
    const client = new SuperProductivityClient(config, logger, restFetch);
    const semanticApiClient = new SuperProductivityClient(config, logger, semanticFetch);
    const server = createMcpServer({ config, client, semanticApiClient, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    const result = await mcpClient.callTool({
      name: 'update_task',
      arguments: { taskId: 'task-1', priority: 3 },
    });
    expect(JSON.parse(responseText(result)).task.priority).toBe(3);
    expect(restFetch).toHaveBeenCalledTimes(1);
    expect(semanticFetch).toHaveBeenCalledTimes(2);
    await mcpClient.close();
    await server.close();
  });

  it('reports an absent app route and never falls back to a raw priority write', async () => {
    const restFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return successResponse({ server: 'up', rendererReady: true });
      if (url.pathname === '/tasks/task-1' && (init?.method ?? 'GET') === 'GET')
        return successResponse(testTask({ priority: null }));
      throw new Error(`Unexpected REST request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const semanticFetch = vi.fn<typeof fetch>(async () =>
      errorResponse('NOT_FOUND', 'Route not found', 404),
    );
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, restFetch);
    const semanticApiClient = new SuperProductivityClient(config, logger, semanticFetch);
    const server = createMcpServer({ config, client, semanticApiClient, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const connectionResult = await mcpClient.callTool({ name: 'check_connection', arguments: {} });
    const connection = JSON.parse(responseText(connectionResult));
    expect(connection.connected).toBe(true);
    expect(connection.semanticApi).toMatchObject({
      configured: true,
      available: false,
      priorityAvailable: false,
      projectAdminAvailable: false,
      tagAdminAvailable: false,
      timeAvailable: false,
      orderingScopes: [],
      features: [],
    });

    const updateResult = await mcpClient.callTool({
      name: 'update_task',
      arguments: { taskId: 'task-1', priority: 2 },
    });
    expect(updateResult.isError).toBe(true);
    expect(responseText(updateResult)).toContain('FEATURE_UNAVAILABLE');
    expect(restFetch.mock.calls.every(([, init]) => (init?.method ?? 'GET') !== 'PATCH')).toBe(
      true,
    );
    expect(
      semanticFetch.mock.calls.every(
        ([url]) => new URL(String(url)).pathname === '/bridge/capabilities',
      ),
    ).toBe(true);

    const invalidPriority = await mcpClient.callTool({
      name: 'update_task',
      arguments: { taskId: 'task-1', priority: 4 },
    });
    expect(invalidPriority.isError).toBe(true);
    expect(semanticFetch).toHaveBeenCalledTimes(2);
    await mcpClient.close();
    await server.close();
  });

  it('reports when an update response does not confirm requested field values', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks/task-1' && (init?.method ?? 'GET') === 'GET')
        return successResponse(testTask());
      if (url.pathname === '/tasks/task-1' && init?.method === 'PATCH')
        return successResponse(testTask());
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const result = await mcpClient.callTool({
      name: 'update_task',
      arguments: { taskId: 'task-1', title: 'Expected new title' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(responseText(result)).error.code).toBe('SP_WRITE_NOT_CONFIRMED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await mcpClient.close();
    await server.close();
  });

  it('exposes day-based task queue results with their matching reason', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks') {
        return successResponse([
          testTask({ id: 'late', title: 'Late', deadlineDay: '2026-10-01' }),
          testTask({ id: 'open', title: 'Open' }),
        ]);
      }
      throw new Error(`Unexpected mocked API request: ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const result = await mcpClient.callTool({
      name: 'query_task_queue',
      arguments: { kind: 'overdue', asOfDate: '2026-10-02' },
    });
    const data = JSON.parse(responseText(result));
    expect(
      data.tasks.map((task: { id: string; queueReasons: string[] }) => [
        task.id,
        task.queueReasons,
      ]),
    ).toEqual([['late', ['deadline']]]);
    await mcpClient.close();
    await server.close();
  });

  it('verifies archive and deletion by reading task lists back', async () => {
    const task = testTask();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks/task-1/archive' && init?.method === 'POST') {
        return successResponse({ id: task.id, archived: true });
      }
      if (url.pathname === '/tasks/task-1' && init?.method === 'DELETE') {
        return successResponse({ id: task.id, deleted: true });
      }
      if (url.pathname === '/tasks' && url.searchParams.get('source') === 'archived') {
        return successResponse([task]);
      }
      if (url.pathname === '/tasks' && url.searchParams.get('source') === 'all') {
        return successResponse([]);
      }
      throw new Error(`Unexpected mocked API request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const archive = await mcpClient.callTool({
      name: 'archive_task',
      arguments: { taskId: task.id },
    });
    expect(JSON.parse(responseText(archive)).archived).toBe(true);
    const deletion = await mcpClient.callTool({
      name: 'delete_task',
      arguments: { taskId: task.id },
    });
    expect(JSON.parse(responseText(deletion)).deleted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await mcpClient.close();
    await server.close();
  });

  it('sets a task parent through the semantic API and verifies both relationship sides', async () => {
    const tasks = {
      child: testTask({
        id: 'child',
        title: 'Child',
        notes: 'keep these notes',
        parentId: null,
        subTaskIds: [],
        timeEstimate: 900,
      }),
      parent: testTask({ id: 'parent', title: 'Parent', parentId: null, subTaskIds: [] }),
    };
    const restFetch = vi.fn<typeof fetch>(async (input) => {
      const id = new URL(String(input)).pathname.split('/').at(-1);
      const task = id ? tasks[id as keyof typeof tasks] : undefined;
      return task ? successResponse(task) : errorResponse('TASK_NOT_FOUND', 'Task not found', 404);
    });
    const semanticFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/bridge/capabilities')
        return successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['task.hierarchy.set_parent'],
        });
      expect(url.pathname).toBe('/bridge/tasks/child/hierarchy');
      expect(init?.body).toBe(
        JSON.stringify({ parentTaskId: 'parent', position: { type: 'bottom' } }),
      );
      tasks.child = { ...tasks.child, parentId: 'parent' };
      tasks.parent = { ...tasks.parent, subTaskIds: ['child'] };
      return successResponse({
        task: tasks.child,
        previousParent: null,
        parent: tasks.parent,
        siblingIds: ['child'],
      });
    });
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, restFetch);
    const semanticApiClient = new SuperProductivityClient(config, logger, semanticFetch);
    const server = createMcpServer({ config, client, semanticApiClient, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    const result = await mcpClient.callTool({
      name: 'set_task_parent',
      arguments: { taskId: 'child', parentTaskId: 'parent', position: { type: 'bottom' } },
    });
    const output = JSON.parse(responseText(result));
    expect(result.isError).not.toBe(true);
    expect(output).toMatchObject({
      verified: true,
      task: { id: 'child', parentId: 'parent', notes: 'keep these notes' },
      parent: { id: 'parent', childIds: ['child'] },
      siblingIds: ['child'],
    });
    await mcpClient.close();
    await server.close();
  });

  it('adjusts explicit-date time history and verifies a separate persisted read', async () => {
    let task = testTask({
      id: 'task-1',
      title: 'History entry',
      notes: 'preserve this',
      timeSpent: 30_000,
      timeSpentOnDay: { '2026-05-11': 30_000 },
    });
    const restFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks/task-1') return successResponse(task);
      throw new Error(`Unexpected REST request: ${url.pathname}`);
    });
    const semanticFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/bridge/capabilities')
        return successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['task.time.adjust'],
        });
      expect(url.pathname).toBe('/bridge/tasks/task-1/time');
      expect(init?.body).toBe(
        JSON.stringify({ operation: 'add', date: '2026-05-12', duration: 60_000 }),
      );
      task = {
        ...task,
        timeSpent: 90_000,
        timeSpentOnDay: { '2026-05-11': 30_000, '2026-05-12': 60_000 },
      };
      return successResponse({
        task,
        date: '2026-05-12',
        operation: 'add',
        duration: 60_000,
        dayTotal: 60_000,
        total: 90_000,
      });
    });
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, restFetch);
    const semanticApiClient = new SuperProductivityClient(config, logger, semanticFetch);
    const server = createMcpServer({ config, client, semanticApiClient, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const result = await mcpClient.callTool({
      name: 'adjust_task_time',
      arguments: {
        taskId: 'task-1',
        operation: 'add',
        date: '2026-05-12',
        durationMs: 60_000,
      },
    });
    const output = JSON.parse(responseText(result));
    expect(result.isError).not.toBe(true);
    expect(output).toMatchObject({
      verified: true,
      dayTotalMs: 60_000,
      totalTimeSpentMs: 90_000,
      task: { id: 'task-1', notes: 'preserve this' },
    });
    await mcpClient.close();
    await server.close();
  });

  it('moves a project task before a sibling and verifies the persisted ordered list', async () => {
    const task = testTask({ id: 'd', title: 'D', projectId: 'p1' });
    let orderedIds = ['a', 'b', 'c', 'd'];
    const restFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks/d') return successResponse(task);
      if (url.pathname === '/projects')
        return successResponse([
          { id: 'p1', title: 'Project', taskIds: orderedIds, backlogTaskIds: [] },
        ]);
      throw new Error(`Unexpected REST request: ${url.pathname}`);
    });
    const semanticFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/bridge/capabilities')
        return successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['task.order.project'],
        });
      expect(init?.body).toBe(
        JSON.stringify({
          scope: 'project',
          scopeId: 'p1',
          position: { type: 'before', referenceTaskId: 'b' },
        }),
      );
      orderedIds = ['a', 'd', 'b', 'c'];
      return successResponse({ taskId: 'd', scope: 'project', scopeId: 'p1', orderedIds });
    });
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, restFetch);
    const semanticApiClient = new SuperProductivityClient(config, logger, semanticFetch);
    const server = createMcpServer({ config, client, semanticApiClient, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    const result = await mcpClient.callTool({
      name: 'move_task_in_order',
      arguments: {
        taskId: 'd',
        scope: 'project',
        scopeId: 'p1',
        position: { type: 'before', referenceTaskId: 'b' },
      },
    });
    const output = JSON.parse(responseText(result));
    expect(result.isError).not.toBe(true);
    expect(output).toMatchObject({
      moved: true,
      verified: true,
      scope: 'project',
      scopeId: 'p1',
      previousTaskId: 'a',
      nextTaskId: 'b',
      memberCount: 4,
    });
    expect(new Set(orderedIds)).toEqual(new Set(['a', 'b', 'c', 'd']));
    await mcpClient.close();
    await server.close();
  });

  it('creates only HTTP(S) links, renames labels, and detaches exact attachment metadata', async () => {
    const original = {
      id: 'file-1',
      type: 'FILE',
      path: '/private/report.pdf',
      title: 'Report',
      icon: 'insert_drive_file',
    };
    const attachmentState: Array<Record<string, unknown>> = [original];
    const taskState = testTask({
      id: 'task-1',
      title: 'Keep task title',
      notes: 'Keep task notes',
      attachments: attachmentState,
    });
    const features = [
      'task.attachments.add_link',
      'task.attachments.rename',
      'task.attachments.detach',
    ];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/bridge/capabilities' && method === 'GET')
        return successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features,
        });
      if (url.pathname === '/tasks/task-1' && method === 'GET') return successResponse(taskState);
      if (url.pathname === '/bridge/tasks/task-1/attachments/links' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { url: string; title?: string };
        const attachment = {
          id: 'link-1',
          type: 'LINK',
          path: body.url,
          title: body.title ?? 'example.com',
          icon: 'bookmark',
        };
        attachmentState.push(attachment);
        return successResponse({ task: taskState, attachment });
      }
      if (url.pathname === '/bridge/tasks/task-1/attachments/link-1' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { title: string };
        attachmentState.splice(
          0,
          attachmentState.length,
          ...attachmentState.map((item) =>
            item.id === 'link-1' ? { ...item, title: body.title } : item,
          ),
        );
        const attachment = attachmentState.find(
          (item: Record<string, unknown>) => item.id === 'link-1',
        );
        return successResponse({ task: taskState, attachment });
      }
      if (url.pathname === '/bridge/tasks/task-1/attachments/file-1' && method === 'DELETE') {
        attachmentState.splice(
          0,
          attachmentState.length,
          ...attachmentState.filter((item) => item.id !== 'file-1'),
        );
        return successResponse({ task: taskState, attachmentId: 'file-1', detached: true });
      }
      if (url.pathname === '/bridge/tasks/task-1/attachments/missing' && method === 'DELETE')
        return errorResponse('ATTACHMENT_NOT_FOUND', 'Attachment is not on this task', 404);
      throw new Error(`Unexpected attachment API request: ${method} ${url.pathname}`);
    });
    const config = testConfig();
    const logger = testLogger();
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const semanticApiClient = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, semanticApiClient, logger });
    const mcpClient = new Client({ name: 'attachment-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const added = await mcpClient.callTool({
      name: 'add_task_link_attachment',
      arguments: { taskId: 'task-1', url: 'https://example.com/course', title: 'Course' },
    });
    expect(added.isError).toBeFalsy();
    expect(JSON.parse(responseText(added))).toEqual({
      created: true,
      taskId: 'task-1',
      attachment: {
        id: 'link-1',
        type: 'LINK',
        path: 'https://example.com/course',
        title: 'Course',
        icon: 'bookmark',
      },
    });

    const beforeBadUrl = fetchMock.mock.calls.length;
    const badUrl = await mcpClient.callTool({
      name: 'add_task_link_attachment',
      arguments: { taskId: 'task-1', url: 'file:///etc/passwd' },
    });
    expect(badUrl.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(beforeBadUrl);

    const renamed = await mcpClient.callTool({
      name: 'rename_task_attachment',
      arguments: { taskId: 'task-1', attachmentId: 'link-1', title: 'New label' },
    });
    expect(renamed.isError).toBeFalsy();
    expect(JSON.parse(responseText(renamed)).attachment.title).toBe('New label');

    const missing = await mcpClient.callTool({
      name: 'detach_task_attachment',
      arguments: { taskId: 'task-1', attachmentId: 'missing' },
    });
    expect(missing.isError).toBe(true);
    expect(attachmentState).toHaveLength(2);

    const detached = await mcpClient.callTool({
      name: 'detach_task_attachment',
      arguments: { taskId: 'task-1', attachmentId: 'file-1' },
    });
    expect(detached.isError).toBeFalsy();
    expect(JSON.parse(responseText(detached))).toEqual({
      detached: true,
      taskId: 'task-1',
      attachmentId: 'file-1',
    });
    expect(attachmentState).toHaveLength(1);
    expect(attachmentState[0]).toMatchObject({
      id: 'link-1',
      path: 'https://example.com/course',
      title: 'New label',
    });
    expect(taskState.title).toBe('Keep task title');
    expect(taskState.notes).toBe('Keep task notes');

    await mcpClient.close();
    await server.close();
  });
});
