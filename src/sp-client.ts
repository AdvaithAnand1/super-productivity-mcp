import { z } from 'zod/v4';

import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import type { Logger } from './logger.js';
import {
  SpCurrentTaskIdSchema,
  SpEnvelopeSchema,
  SpHealthSchema,
  SpHierarchyResultSchema,
  SpOrderResultSchema,
  SpProjectSchema,
  SpTagSchema,
  SpTaskSchema,
  SpTaskLinkAttachmentResultSchema,
  SpTaskAttachmentDetachResultSchema,
  SpTimeAdjustmentResultSchema,
  type SpCurrentTaskId,
  type SpHealth,
  type SpHierarchyResult,
  type SpOrderResult,
  type SpProject,
  type SpTag,
  type SpTask,
  type SpTaskAttachment,
  type SpTimeAdjustmentResult,
} from './types.js';

export type TaskSource = 'active' | 'archived' | 'all';

export interface ListTasksOptions {
  readonly query?: string;
  readonly projectId?: string;
  readonly tagId?: string;
  readonly includeDone?: boolean;
  readonly source?: TaskSource;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly notes?: string;
  readonly projectId?: string;
  readonly tagIds?: readonly string[];
  readonly parentId?: string;
  readonly timeEstimate?: number;
  readonly deadlineDay?: string | null;
  readonly deadlineWithTime?: number | null;
  readonly deadlineRemindAt?: number | null;
  readonly dueDay?: string | null;
  readonly dueWithTime?: number | null;
  readonly isDone?: boolean;
  readonly isIgnoreShortSyntax?: boolean;
}

export interface UpdateTaskInput {
  readonly title?: string;
  readonly notes?: string;
  readonly projectId?: string;
  readonly tagIds?: readonly string[];
  readonly timeEstimate?: number;
  readonly isDone?: boolean;
  readonly priority?: 1 | 2 | 3 | null;
  readonly dueDay?: string | null;
  readonly dueWithTime?: number | null;
  readonly deadlineDay?: string | null;
  readonly deadlineWithTime?: number | null;
  readonly deadlineRemindAt?: number | null;
  readonly isIgnoreShortSyntax?: boolean;
}

type FetchLike = typeof fetch;

const parseResponseJson = async (response: Response): Promise<unknown> => {
  const body = await response.text();
  if (!body.trim()) {
    throw new AppError(
      'SP_INVALID_RESPONSE',
      `Super Productivity returned an empty response (HTTP ${response.status})`,
      {
        status: response.status,
      },
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AppError(
      'SP_INVALID_RESPONSE',
      `Super Productivity returned invalid JSON (HTTP ${response.status})`,
      {
        status: response.status,
      },
    );
  }
};

const taskIdPath = (taskId: string, suffix = '') => `/tasks/${encodeURIComponent(taskId)}${suffix}`;

const redactToken = (value: unknown, token: string | undefined): unknown => {
  if (!token) return value;
  if (typeof value === 'string') return value.split(token).join('[redacted]');
  if (Array.isArray(value)) return value.map((item: unknown) => redactToken(item, token));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.split(token).join('[redacted]'),
        redactToken(entry, token),
      ]),
    );
  }
  return value;
};

export class SuperProductivityClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly semanticApiUrl: URL = config.semanticApiUrl,
  ) {}

  async health(): Promise<SpHealth> {
    return this.request('/health', SpHealthSchema, { requiresAuth: false });
  }

  async listTasks(options: ListTasksOptions = {}): Promise<SpTask[]> {
    const params = new URLSearchParams();
    if (options.query) params.set('query', options.query);
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.tagId) params.set('tagId', options.tagId);
    params.set('includeDone', String(options.includeDone ?? false));
    params.set('source', options.source ?? 'active');
    return this.request(`/tasks?${params.toString()}`, z.array(SpTaskSchema));
  }

  async getTask(
    taskId: string,
    options: { readonly includeIssueUrl?: boolean } = {},
  ): Promise<SpTask> {
    const suffix = options.includeIssueUrl ? '?include=issueUrl' : '';
    return this.request(taskIdPath(taskId) + suffix, SpTaskSchema);
  }

  async listTags(query?: string): Promise<SpTag[]> {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(`/tags${suffix}`, z.array(SpTagSchema));
  }

  async listProjects(query?: string): Promise<SpProject[]> {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(`/projects${suffix}`, z.array(SpProjectSchema));
  }

  async createTask(input: CreateTaskInput): Promise<SpTask> {
    return this.request('/tasks', SpTaskSchema, {
      method: 'POST',
      body: {
        ...input,
        isIgnoreShortSyntax: input.isIgnoreShortSyntax ?? true,
      },
    });
  }

  async semanticApiCapabilities(): Promise<{
    protocolVersion: string;
    superProductivityVersion: string;
    features: string[];
  }> {
    return this.semanticApiRequest(
      'capabilities',
      z.object({
        protocolVersion: z.string(),
        superProductivityVersion: z.string(),
        features: z.array(z.string()),
      }),
    );
  }

  async setTaskPriority(taskId: string, priority: 1 | 2 | 3 | null): Promise<SpTask> {
    return this.semanticApiRequest(`tasks/${encodeURIComponent(taskId)}/priority`, SpTaskSchema, {
      method: 'PATCH',
      body: { priority },
      requiredFeature: 'task.priority.set',
    });
  }

  async setTaskParent(
    taskId: string,
    parentTaskId: string | null,
    position?:
      | { type: 'top' | 'bottom' }
      | { type: 'before' | 'after'; referenceTaskId: string }
      | { type: 'index'; index: number },
  ): Promise<SpHierarchyResult> {
    return this.semanticApiRequest(
      `tasks/${encodeURIComponent(taskId)}/hierarchy`,
      SpHierarchyResultSchema,
      {
        method: 'PATCH',
        body: { parentTaskId, ...(position ? { position } : {}) },
        requiredFeature: 'task.hierarchy.set_parent',
      },
    );
  }

  async moveTaskInOrder(
    taskId: string,
    scope: 'project' | 'backlog' | 'tag' | 'subtasks',
    scopeId: string,
    position:
      | { type: 'top' | 'bottom' }
      | { type: 'before' | 'after'; referenceTaskId: string }
      | { type: 'index'; index: number },
  ): Promise<SpOrderResult> {
    const requiredFeature = `task.order.${scope}`;
    return this.semanticApiRequest(
      `tasks/${encodeURIComponent(taskId)}/order`,
      SpOrderResultSchema,
      {
        method: 'PATCH',
        body: { scope, scopeId, position },
        requiredFeature,
      },
    );
  }

  async adjustTaskTime(
    taskId: string,
    operation: 'add' | 'remove',
    date: string,
    duration: number,
  ): Promise<SpTimeAdjustmentResult> {
    return this.semanticApiRequest(
      `tasks/${encodeURIComponent(taskId)}/time`,
      SpTimeAdjustmentResultSchema,
      {
        method: 'PATCH',
        body: { operation, date, duration },
        requiredFeature: 'task.time.adjust',
      },
    );
  }

  async addTaskLinkAttachment(
    taskId: string,
    url: string,
    title?: string,
  ): Promise<{ task: SpTask; attachment: SpTaskAttachment }> {
    return this.semanticApiRequest(
      `tasks/${encodeURIComponent(taskId)}/attachments/links`,
      SpTaskLinkAttachmentResultSchema,
      {
        method: 'POST',
        body: { url, ...(title === undefined ? {} : { title }) },
        requiredFeature: 'task.attachments.add_link',
      },
    );
  }

  async renameTaskAttachment(
    taskId: string,
    attachmentId: string,
    title: string,
  ): Promise<{ task: SpTask; attachment: SpTaskAttachment }> {
    return this.semanticApiRequest(
      `tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      SpTaskLinkAttachmentResultSchema,
      {
        method: 'PATCH',
        body: { title },
        requiredFeature: 'task.attachments.rename',
      },
    );
  }

  async detachTaskAttachment(
    taskId: string,
    attachmentId: string,
  ): Promise<{ task: SpTask; attachmentId: string; detached: true }> {
    return this.semanticApiRequest(
      `tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      SpTaskAttachmentDetachResultSchema,
      {
        method: 'DELETE',
        requiredFeature: 'task.attachments.detach',
      },
    );
  }

  async createProject(title: string): Promise<SpProject> {
    return this.semanticApiRequest('projects', SpProjectSchema, {
      method: 'POST',
      body: { title },
      requiredFeature: 'project.create',
    });
  }

  async renameProject(projectId: string, title: string): Promise<SpProject> {
    return this.semanticApiRequest(`projects/${encodeURIComponent(projectId)}`, SpProjectSchema, {
      method: 'PATCH',
      body: { title },
      requiredFeature: 'project.rename',
    });
  }

  async deleteEmptyProject(projectId: string): Promise<{ id: string; deleted: true }> {
    return this.semanticApiRequest(
      `projects/${encodeURIComponent(projectId)}`,
      z.object({ id: z.string(), deleted: z.literal(true) }),
      { method: 'DELETE', requiredFeature: 'project.delete_empty' },
    );
  }

  async createTag(input: { title: string; color?: string }): Promise<SpTag> {
    return this.semanticApiRequest('tags', SpTagSchema, {
      method: 'POST',
      body: input,
      requiredFeature: 'tag.create',
    });
  }

  async updateTag(tagId: string, changes: { title?: string; color?: string }): Promise<SpTag> {
    return this.semanticApiRequest(`tags/${encodeURIComponent(tagId)}`, SpTagSchema, {
      method: 'PATCH',
      body: changes,
      requiredFeature: 'tag.update',
    });
  }

  async deleteEmptyTag(tagId: string): Promise<{ id: string; deleted: true }> {
    return this.semanticApiRequest(
      `tags/${encodeURIComponent(tagId)}`,
      z.object({ id: z.string(), deleted: z.literal(true) }),
      { method: 'DELETE', requiredFeature: 'tag.delete_empty' },
    );
  }

  private async semanticApiRequest<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      requiredFeature?: string;
    } = {},
  ): Promise<T> {
    const base = this.semanticApiUrl;
    const capabilities =
      path === 'capabilities'
        ? undefined
        : await this.semanticApiCapabilities().catch((error: unknown) => {
            if (error instanceof AppError && error.status === 404)
              throw new AppError(
                'FEATURE_UNAVAILABLE',
                'This Super Productivity app does not expose task priority writes',
                { status: 404 },
              );
            throw error;
          });
    if (capabilities && capabilities.protocolVersion !== '1')
      throw new AppError(
        'SEMANTIC_API_PROTOCOL_MISMATCH',
        'Unsupported Super Productivity extended semantic API protocol',
      );
    if (
      capabilities &&
      options.requiredFeature &&
      !capabilities.features.includes(options.requiredFeature)
    )
      throw new AppError(
        'FEATURE_UNAVAILABLE',
        `Super Productivity does not support ${options.requiredFeature}`,
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.apiTimeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, base), {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        redirect: 'error',
      });
      const raw = await parseResponseJson(response);
      const envelope = SpEnvelopeSchema.safeParse(raw);
      if (!envelope.success) {
        if (!response.ok)
          throw new AppError(
            'SEMANTIC_API_REQUEST_FAILED',
            `Super Productivity extended semantic API returned HTTP ${response.status}`,
            { status: response.status },
          );
        throw new AppError(
          'SEMANTIC_API_INVALID_RESPONSE',
          'Super Productivity extended semantic API returned an invalid response',
        );
      }
      if (!envelope.data.ok)
        throw new AppError(envelope.data.error.code, envelope.data.error.message, {
          status: response.status,
        });
      if (!response.ok)
        throw new AppError(
          'SEMANTIC_API_REQUEST_FAILED',
          `Super Productivity extended semantic API returned HTTP ${response.status}`,
          { status: response.status },
        );
      const parsed = schema.safeParse(envelope.data.data);
      if (!parsed.success)
        throw new AppError(
          'SEMANTIC_API_INVALID_RESPONSE',
          'Super Productivity extended semantic API returned an invalid response',
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'SEMANTIC_API_UNAVAILABLE',
        controller.signal.aborted
          ? 'Super Productivity extended semantic API timed out'
          : 'Could not reach Super Productivity extended semantic API',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async updateTask(taskId: string, input: UpdateTaskInput): Promise<SpTask> {
    return this.request(taskIdPath(taskId), SpTaskSchema, {
      method: 'PATCH',
      body: input,
    });
  }

  async startTask(taskId: string): Promise<SpCurrentTaskId> {
    return this.request(taskIdPath(taskId, '/start'), SpCurrentTaskIdSchema, { method: 'POST' });
  }

  async stopTimer(): Promise<SpCurrentTaskId> {
    return this.request('/task-control/stop', SpCurrentTaskIdSchema, { method: 'POST' });
  }

  async getCurrentTask(): Promise<SpTask | null> {
    return this.request('/task-control/current', z.union([SpTaskSchema, z.null()]));
  }

  async archiveTask(taskId: string): Promise<{ id: string; archived: boolean }> {
    return this.request(
      taskIdPath(taskId, '/archive'),
      z.object({ id: z.string(), archived: z.literal(true) }),
      {
        method: 'POST',
      },
    );
  }

  async restoreTask(taskId: string): Promise<SpTask> {
    return this.request(taskIdPath(taskId, '/restore'), SpTaskSchema, { method: 'POST' });
  }

  async deleteTask(taskId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request(
      taskIdPath(taskId),
      z.object({ deleted: z.literal(true), id: z.string() }),
      {
        method: 'DELETE',
      },
    );
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      readonly body?: unknown;
      readonly requiresAuth?: boolean;
    } = {},
  ): Promise<T> {
    const requiresAuth = options.requiresAuth ?? true;
    const method = options.method ?? 'GET';
    const isMutation = method !== 'GET';
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    // Super Productivity 18.16.0 exposes the released local API without
    // authentication. Newer builds may expose a Bearer token; send it when
    // configured while remaining compatible with the released API.
    const bearerToken = requiresAuth ? this.config.apiToken : undefined;
    if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);

    const url = `${this.config.apiUrl.toString().replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.apiTimeoutMs);
    const startedAt = Date.now();

    try {
      this.logger.debug('Calling Super Productivity API', {
        method,
        path: path.split('?')[0],
        authenticated: Boolean(bearerToken),
      });

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          redirect: 'error',
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isMutation) {
          throw new AppError(
            'SP_MUTATION_OUTCOME_UNKNOWN',
            'Super Productivity did not confirm the change; it may have already been saved. Do not retry automatically. Check the task or current timer state before retrying.',
            { details: { cause: controller.signal.aborted ? 'timeout' : 'connection_failed' } },
          );
        }
        if (controller.signal.aborted) {
          throw new AppError(
            'SP_TIMEOUT',
            `Super Productivity did not respond within ${this.config.apiTimeoutMs}ms`,
          );
        }
        throw new AppError(
          'SP_UNREACHABLE',
          'Could not reach Super Productivity on the configured local API URL',
          {
            details:
              error instanceof Error ? redactToken(error.message, this.config.apiToken) : undefined,
          },
        );
      }

      let json: unknown;
      try {
        json = await parseResponseJson(response);
      } catch (error) {
        if (isMutation) {
          throw new AppError(
            'SP_MUTATION_OUTCOME_UNKNOWN',
            'Super Productivity did not return a usable confirmation; the change may have already been saved. Do not retry automatically. Check the task or current timer state before retrying.',
            { status: response.status },
          );
        }
        if (error instanceof AppError) throw error;
        throw new AppError(
          controller.signal.aborted ? 'SP_TIMEOUT' : 'SP_UNREACHABLE',
          controller.signal.aborted
            ? `Super Productivity did not respond within ${this.config.apiTimeoutMs}ms`
            : 'Could not read the response from Super Productivity',
        );
      }
      const envelope = SpEnvelopeSchema.safeParse(json);
      if (!envelope.success) {
        throw new AppError(
          isMutation ? 'SP_MUTATION_OUTCOME_UNKNOWN' : 'SP_INVALID_RESPONSE',
          isMutation
            ? 'Super Productivity returned an unexpected confirmation; the change may have already been saved. Do not retry automatically. Check the task or current timer state before retrying.'
            : `Super Productivity returned an unexpected response (HTTP ${response.status})`,
          {
            status: response.status,
          },
        );
      }
      if (!response.ok || !envelope.data.ok) {
        if (envelope.data.ok) {
          throw new AppError(
            'SP_HTTP_ERROR',
            `Super Productivity returned HTTP ${response.status}`,
            {
              status: response.status,
            },
          );
        }
        throw new AppError(
          String(redactToken(envelope.data.error.code, this.config.apiToken)),
          String(redactToken(envelope.data.error.message, this.config.apiToken)),
          {
            status: response.status,
            details: redactToken(envelope.data.error.details, this.config.apiToken),
          },
        );
      }

      const parsed = schema.safeParse(envelope.data.data);
      if (!parsed.success) {
        throw new AppError(
          isMutation ? 'SP_MUTATION_OUTCOME_UNKNOWN' : 'SP_INVALID_RESPONSE',
          isMutation
            ? 'Super Productivity returned confirmation data with an unexpected shape; the change may have already been saved. Do not retry automatically. Check the task or current timer state before retrying.'
            : 'Super Productivity returned data with an unexpected shape',
          {
            status: response.status,
          },
        );
      }

      this.logger.debug('Super Productivity API call completed', {
        method,
        path: path.split('?')[0],
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
