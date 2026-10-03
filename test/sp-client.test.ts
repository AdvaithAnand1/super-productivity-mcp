import { SuperProductivityClient } from '../src/sp-client.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { errorResponse, successResponse, testConfig, testLogger, testTask } from './helpers.js';

describe('SuperProductivityClient', () => {
  it('calls health without an Authorization header', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse({ server: 'up', rendererReady: true }));
    const client = new SuperProductivityClient(loadConfig({}), testLogger(), fetchMock);

    await expect(client.health()).resolves.toEqual({ server: 'up', rendererReady: true });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('sends the token and exact filters when listing tasks', async () => {
    const task = testTask();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse([task]));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(
      client.listTasks({
        query: 'Example',
        projectId: 'project-1',
        tagId: 'TODAY',
        includeDone: true,
        source: 'all',
      }),
    ).resolves.toEqual([task]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/tasks?');
    expect(String(url)).toContain('query=Example');
    expect(String(url)).toContain('projectId=project-1');
    expect(String(url)).toContain('tagId=TODAY');
    expect(String(url)).toContain('includeDone=true');
    expect(String(url)).toContain('source=all');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('supports the released unauthenticated API when no token is configured', async () => {
    const task = testTask();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse([task]));
    const client = new SuperProductivityClient(loadConfig({}), testLogger(), fetchMock);

    await expect(client.listTasks()).resolves.toEqual([task]);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('maps official API errors to explicit application errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(errorResponse('TASK_NOT_FOUND', 'Task not found', 404));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    const error = await client.getTask('missing').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('TASK_NOT_FOUND');
    expect((error as AppError).status).toBe(404);
  });

  it('negotiates the enhanced semantic API capability before updating priority', async () => {
    const task = testTask({ priority: 3 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '1.0.0',
          features: ['task.priority.set'],
        }),
      )
      .mockResolvedValueOnce(successResponse(task));
    const config = testConfig({ semanticApiUrl: new URL('http://127.0.0.1:3876/bridge/') });
    const client = new SuperProductivityClient(config, testLogger(), fetchMock);
    await expect(client.setTaskPriority('task-1', 3)).resolves.toEqual(task);
    const [capabilityUrl] = fetchMock.mock.calls[0] ?? [];
    expect(String(capabilityUrl)).toBe('http://127.0.0.1:3876/bridge/capabilities');
    const [, capabilityInit] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(capabilityInit?.headers).get('authorization')).toBe('Bearer test-token');
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:3876/bridge/tasks/task-1/priority');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ priority: 3 }));
  });

  it('fails closed when the enhanced semantic API does not advertise priority writes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        successResponse({ protocolVersion: '1', superProductivityVersion: '1.0.0', features: [] }),
      );
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
    await expect(client.setTaskPriority('task-1', null)).rejects.toMatchObject({
      code: 'FEATURE_UNAVAILABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a priority write when capability discovery fails', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.setTaskPriority('task-1', 2)).rejects.toMatchObject({
      code: 'SEMANTIC_API_UNAVAILABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:3876/bridge/capabilities');
  });

  it('rejects malformed capability responses and protocol mismatches before writing', async () => {
    for (const capabilities of [
      { protocolVersion: '1', superProductivityVersion: '1.0.0', features: 'bad' },
      { protocolVersion: '2', superProductivityVersion: '1.0.0', features: ['task.priority.set'] },
    ]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(capabilities));
      const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
      const error = await client.setTaskPriority('task-1', 2).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code:
          capabilities.protocolVersion === '2'
            ? 'SEMANTIC_API_PROTOCOL_MISMATCH'
            : 'SEMANTIC_API_INVALID_RESPONSE',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves structured application errors from the priority route', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '1.0.0',
          features: ['task.priority.set'],
        }),
      )
      .mockResolvedValueOnce(
        errorResponse('INVALID_INPUT', 'priority must be 1, 2, 3, or null', 400),
      );
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.setTaskPriority('task-1', 2)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serializes task updates as a PATCH without leaking unrelated fields', async () => {
    const task = testTask({ isDone: true });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(task));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await client.updateTask('task-1', { isDone: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:3876/tasks/task-1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ isDone: true }));
  });

  it('creates literal titles with full task fields and preserves empty notes', async () => {
    const task = testTask({
      deadlineDay: '2026-10-07',
      deadlineWithTime: null,
      deadlineRemindAt: null,
      futureField: { supported: true },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(task));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
    const input = {
      title: 'CS 424 HW3 #literal',
      notes: '',
      projectId: 'project-1',
      tagIds: ['assignments'],
      timeEstimate: 0,
      deadlineDay: '2026-10-07',
      deadlineWithTime: null,
      deadlineRemindAt: null,
    };

    await expect(client.createTask(input)).resolves.toEqual(task);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:3876/tasks');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ ...input, isIgnoreShortSyntax: true });
    expect(init?.redirect).toBe('error');
  });

  it('supports subtasks and an explicit short syntax opt-in', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(testTask()));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await client.createTask({ title: 'Subtask', parentId: 'parent', isIgnoreShortSyntax: false });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      title: 'Subtask',
      parentId: 'parent',
      isIgnoreShortSyntax: false,
    });
  });

  it('updates deadlines separately from planning dates and allows clearing fields', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(testTask()));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
    const update = {
      title: 'Plain title #literal',
      notes: '',
      projectId: 'project-2',
      tagIds: [],
      timeEstimate: 0,
      dueDay: '2026-10-01',
      dueWithTime: null,
      deadlineDay: null,
      deadlineWithTime: 1_800_000_000_000,
      deadlineRemindAt: null,
      isIgnoreShortSyntax: true,
    };

    await client.updateTask('task/with spaces', update);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:3876/tasks/task%2Fwith%20spaces');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual(update);
  });

  it('lists tags and projects with encoded search queries and preserves ordered task IDs', async () => {
    const tag = { id: 'tag-1', title: 'Assignments', taskIds: ['task-2', 'task-1'] };
    const project = { id: 'project-1', title: 'Course work', isArchived: false, color: 'red' };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse([tag]))
      .mockResolvedValueOnce(successResponse([project]));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.listTags('Assign & work')).resolves.toEqual([tag]);
    await expect(client.listProjects()).resolves.toEqual([project]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3876/tags?query=Assign+%26+work');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:3876/projects');
  });

  it('rejects incomplete tag and project responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse([{ title: 'No ID' }]))
      .mockResolvedValueOnce(successResponse([{ id: 'no-title' }]));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.listTags()).rejects.toMatchObject({ code: 'SP_INVALID_RESPONSE' });
    await expect(client.listProjects('Course')).rejects.toMatchObject({
      code: 'SP_INVALID_RESPONSE',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:3876/projects?query=Course');
  });

  it('refuses redirects on authenticated reads so tokens cannot be forwarded', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(testTask()));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await client.getTask('task-1');
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('redacts configured tokens even when API errors echo them without labels', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      errorResponse('test-token_FAILED', 'Unlabelled test-token echo', 401, {
        'test-token': ['again test-token', { nested: 'test-token' }],
      }),
    );
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    const error = (await client.getTask('missing').catch((value: unknown) => value)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('[redacted]_FAILED');
    expect(error.message).toBe('Unlabelled [redacted] echo');
    expect(error.details).toEqual({ '[redacted]': ['again [redacted]', { nested: '[redacted]' }] });
    expect(JSON.stringify(error)).not.toContain('test-token');
  });

  it('redacts fetch error details and leaves read failures as unreachable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('Echo test-token'));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.listTasks()).rejects.toMatchObject({
      code: 'SP_UNREACHABLE',
      details: 'Echo [redacted]',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['create', 'update', 'start', 'stop'] as const)(
    'reports uncertain outcomes without retrying when a %s mutation loses connection',
    async (operation) => {
      const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('Connection reset'));
      const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
      const operationPromise =
        operation === 'create'
          ? client.createTask({ title: 'Course task' })
          : operation === 'update'
            ? client.updateTask('task-1', { isDone: true })
            : operation === 'start'
              ? client.startTask('task-1')
              : client.stopTimer();

      const error = (await operationPromise.catch((value: unknown) => value)) as AppError;
      expect(error.code).toBe('SP_MUTATION_OUTCOME_UNKNOWN');
      expect(error.message).toContain('Do not retry automatically');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps API-declared mutation rejection definitive', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(errorResponse('INVALID_TAG', 'Tag does not exist', 400));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(
      client.createTask({ title: 'Course task', tagIds: ['missing'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_TAG',
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty response', () => new Response('')],
    ['invalid JSON', () => new Response('not json')],
    ['invalid envelope', () => new Response(JSON.stringify({ saved: true }))],
    ['invalid task data', () => successResponse({ saved: true })],
  ])('reports uncertain mutation outcomes after an %s', async (_label, makeResponse) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(makeResponse());
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.createTask({ title: 'Course task' })).rejects.toMatchObject({
      code: 'SP_MUTATION_OUTCOME_UNKNOWN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes read timeout from uncertain mutation timeout without retrying', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          }),
      );
      const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
      const readResult = client.listTasks().catch((value: unknown) => value);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await readResult).toMatchObject({ code: 'SP_TIMEOUT' });

      const writeResult = client.createTask({ title: 'Task' }).catch((value: unknown) => value);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await writeResult).toMatchObject({
        code: 'SP_MUTATION_OUTCOME_UNKNOWN',
        details: { cause: 'timeout' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports uncertain mutation outcome when response body reading loses connection', async () => {
    const response = successResponse(testTask());
    vi.spyOn(response, 'text').mockRejectedValue(new Error('Connection reset'));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.createTask({ title: 'Task' })).rejects.toMatchObject({
      code: 'SP_MUTATION_OUTCOME_UNKNOWN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the app lifecycle routes for archive, restore, and permanent delete', async () => {
    const task = testTask();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse({ id: task.id, archived: true }))
      .mockResolvedValueOnce(successResponse(task))
      .mockResolvedValueOnce(successResponse({ id: task.id, deleted: true }));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.archiveTask(task.id)).resolves.toEqual({ id: task.id, archived: true });
    await expect(client.restoreTask(task.id)).resolves.toEqual(task);
    await expect(client.deleteTask(task.id)).resolves.toEqual({ id: task.id, deleted: true });

    expect(
      fetchMock.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method]),
    ).toEqual([
      ['/tasks/task-1/archive', 'POST'],
      ['/tasks/task-1/restore', 'POST'],
      ['/tasks/task-1', 'DELETE'],
    ]);
  });

  it('uses the hierarchy capability and endpoint with an explicit target parent', async () => {
    const task = testTask({ id: 'child', parentId: 'parent' });
    const result = {
      task,
      previousParent: null,
      parent: testTask({ id: 'parent', subTaskIds: ['child'] }),
      siblingIds: ['child'],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['task.hierarchy.set_parent'],
        }),
      )
      .mockResolvedValueOnce(successResponse(result));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
    await expect(client.setTaskParent('child', 'parent', { type: 'bottom' })).resolves.toEqual(
      result,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'http://127.0.0.1:3876/bridge/tasks/child/hierarchy',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ parentTaskId: 'parent', position: { type: 'bottom' } }),
    );
  });

  it('checks ordering capabilities by scope and sends semantic position intent', async () => {
    const result = {
      taskId: 'task-1',
      scope: 'project' as const,
      scopeId: 'p1',
      orderedIds: ['task-1', 'sibling'],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['task.order.project'],
        }),
      )
      .mockResolvedValueOnce(successResponse(result));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
    await expect(
      client.moveTaskInOrder('task-1', 'project', 'p1', {
        type: 'before',
        referenceTaskId: 'sibling',
      }),
    ).resolves.toEqual(result);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'http://127.0.0.1:3876/bridge/tasks/task-1/order',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        scope: 'project',
        scopeId: 'p1',
        position: { type: 'before', referenceTaskId: 'sibling' },
      }),
    );
  });

  it('negotiates semantic manual-time support and sends milliseconds on an explicit date', async () => {
    const result = {
      task: testTask({ timeSpent: 60_000, timeSpentOnDay: { '2026-05-11': 60_000 } }),
      date: '2026-05-11',
      operation: 'add' as const,
      duration: 60_000,
      dayTotal: 60_000,
      total: 60_000,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['task.time.adjust'],
        }),
      )
      .mockResolvedValueOnce(successResponse(result));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.adjustTaskTime('task-1', 'add', '2026-05-11', 60_000)).resolves.toEqual(
      result,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'http://127.0.0.1:3876/bridge/tasks/task-1/time',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ operation: 'add', date: '2026-05-11', duration: 60_000 }),
    );
  });

  it('adds, renames, and detaches link attachment metadata through explicit capabilities', async () => {
    const attachment = {
      id: 'attachment-1',
      type: 'LINK' as const,
      path: 'https://example.com/course',
      title: 'Course',
      icon: 'bookmark',
    };
    const task = testTask({ id: 'task-1', attachments: [attachment] });
    const features = [
      'task.attachments.add_link',
      'task.attachments.rename',
      'task.attachments.detach',
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({ protocolVersion: '1', superProductivityVersion: '19.1.0', features }),
      )
      .mockResolvedValueOnce(successResponse({ task, attachment }))
      .mockResolvedValueOnce(
        successResponse({ protocolVersion: '1', superProductivityVersion: '19.1.0', features }),
      )
      .mockResolvedValueOnce(successResponse({ task, attachment: { ...attachment, title: 'New' } }))
      .mockResolvedValueOnce(
        successResponse({ protocolVersion: '1', superProductivityVersion: '19.1.0', features }),
      )
      .mockResolvedValueOnce(
        successResponse({ task, attachmentId: attachment.id, detached: true }),
      );
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(
      client.addTaskLinkAttachment('task-1', attachment.path, attachment.title),
    ).resolves.toEqual({ task, attachment });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'http://127.0.0.1:3876/bridge/tasks/task-1/attachments/links',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ url: attachment.path, title: attachment.title }),
    );

    await expect(client.renameTaskAttachment('task-1', attachment.id, 'New')).resolves.toEqual({
      task,
      attachment: { ...attachment, title: 'New' },
    });
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
      'http://127.0.0.1:3876/bridge/tasks/task-1/attachments/attachment-1',
    );
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ title: 'New' }));

    await expect(client.detachTaskAttachment('task-1', attachment.id)).resolves.toEqual({
      task,
      attachmentId: attachment.id,
      detached: true,
    });
    expect(fetchMock.mock.calls[5]?.[1]?.method).toBe('DELETE');
  });

  it('uses advertised project and tag management capabilities', async () => {
    const project = { id: 'project-1', title: 'Course work' };
    const tag = { id: 'tag-1', title: 'Assignments', color: '#336699' };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['project.create'],
        }),
      )
      .mockResolvedValueOnce(successResponse(project))
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['tag.create'],
        }),
      )
      .mockResolvedValueOnce(successResponse(tag));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.createProject('Course work')).resolves.toEqual(project);
    await expect(client.createTag({ title: 'Assignments', color: '#336699' })).resolves.toEqual(
      tag,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('http://127.0.0.1:3876/bridge/projects');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(
      JSON.stringify({ title: 'Assignments', color: '#336699' }),
    );
  });

  it('deletes only through explicit empty-resource semantic routes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          protocolVersion: '1',
          superProductivityVersion: '19.1.0',
          features: ['project.delete_empty'],
        }),
      )
      .mockResolvedValueOnce(successResponse({ id: 'project-1', deleted: true }));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
    await expect(client.deleteEmptyProject('project-1')).resolves.toEqual({
      id: 'project-1',
      deleted: true,
    });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('refuses an ordering scope the app did not advertise', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successResponse({
        protocolVersion: '1',
        superProductivityVersion: '19.1.0',
        features: ['task.order.project'],
      }),
    );
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);
    await expect(
      client.moveTaskInOrder('task-1', 'tag', 'tag-1', { type: 'top' }),
    ).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
