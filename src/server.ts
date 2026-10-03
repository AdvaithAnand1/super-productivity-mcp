import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { AppConfig } from './config.js';
import { AppError, toPublicError } from './errors.js';
import { addGithubMarker, findGithubIssueTask, parseGithubIssueRef } from './github.js';
import type { Logger } from './logger.js';
import type { ListTasksOptions, SuperProductivityClient, TaskSource } from './sp-client.js';
import { SpTaskAttachmentSchema, type SpTask, type SpTaskAttachment } from './types.js';
import { queryTaskQueue, type TaskQueueKind } from './task-queue.js';

const MAX_TASK_ID_LENGTH = 256;
const prioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable();
const taskIdSchema = z.string().trim().min(1).max(MAX_TASK_ID_LENGTH);
const semanticPositionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['top', 'bottom']) }).strict(),
  z.object({ type: z.enum(['before', 'after']), referenceTaskId: taskIdSchema }).strict(),
  z.object({ type: z.literal('index'), index: z.number().int().min(0).max(100_000) }).strict(),
]);
const setTaskParentInputSchema = z
  .object({
    taskId: taskIdSchema,
    parentTaskId: taskIdSchema.nullable(),
    position: semanticPositionSchema.optional(),
  })
  .strict();
const moveTaskInOrderInputSchema = z
  .object({
    taskId: taskIdSchema,
    scope: z.enum(['project', 'backlog', 'tag', 'subtasks']),
    scopeId: taskIdSchema,
    position: semanticPositionSchema,
  })
  .strict();
const limitSchema = z.number().int().min(1).max(100).optional().default(50);

const emptyInputSchema = z.object({}).strict();

const searchTasksInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    projectName: z.string().trim().min(1).max(200).optional(),
    tagId: z.string().trim().min(1).max(256).optional(),
    tagName: z.string().trim().min(1).max(200).optional(),
    includeDone: z.boolean().optional().default(false),
    source: z.enum(['active', 'archived', 'all']).optional().default('active'),
    limit: limitSchema,
  })
  .strict()
  .refine((input) => !(input.projectId && input.projectName), {
    message: 'Provide projectId or projectName, not both',
  })
  .refine((input) => !(input.tagId && input.tagName), {
    message: 'Provide tagId or tagName, not both',
  });

const listTodayInputSchema = z
  .object({
    includeDone: z.boolean().optional().default(false),
    limit: limitSchema,
  })
  .strict();

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format')
  .refine((value) => {
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }, 'Date is invalid');

const adjustTaskTimeInputSchema = z
  .object({
    taskId: taskIdSchema,
    operation: z.enum(['add', 'remove']),
    date: dateStringSchema,
    durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const safeLinkUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Only HTTP(S) URLs without embedded credentials are allowed');
const addTaskLinkAttachmentInputSchema = z
  .object({
    taskId: taskIdSchema,
    url: safeLinkUrlSchema,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const renameTaskAttachmentInputSchema = z
  .object({
    taskId: taskIdSchema,
    attachmentId: taskIdSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict();
const detachTaskAttachmentInputSchema = z
  .object({
    taskId: taskIdSchema,
    attachmentId: taskIdSchema,
  })
  .strict();

const manageProjectInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), title: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      operation: z.literal('rename'),
      projectId: taskIdSchema,
      title: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ operation: z.literal('delete_empty'), projectId: taskIdSchema }).strict(),
]);

const manageTagInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      title: z.string().trim().min(1).max(200),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('update'),
      tagId: taskIdSchema,
      title: z.string().trim().min(1).max(200).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .strict()
    .refine((input) => input.title !== undefined || input.color !== undefined),
  z.object({ operation: z.literal('delete_empty'), tagId: taskIdSchema }).strict(),
]);

const taskQueueInputSchema = z
  .object({
    kind: z.enum(['overdue', 'upcoming', 'unscheduled']),
    asOfDate: dateStringSchema.optional(),
    withinDays: z.number().int().min(0).max(90).optional().default(7),
    projectId: z.string().trim().min(1).max(256).optional(),
    projectName: z.string().trim().min(1).max(200).optional(),
    tagId: z.string().trim().min(1).max(256).optional(),
    tagName: z.string().trim().min(1).max(200).optional(),
    limit: limitSchema,
  })
  .strict()
  .refine((input) => !(input.projectId && input.projectName), {
    message: 'Provide projectId or projectName, not both',
  })
  .refine((input) => !(input.tagId && input.tagName), {
    message: 'Provide tagId or tagName, not both',
  });

const taskActionInputSchema = z
  .object({
    taskId: taskIdSchema,
  })
  .strict();

const createTaskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    notes: z.string().max(100_000).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    projectName: z.string().trim().min(1).max(200).optional(),
    tagIds: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
    tagNames: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    parentId: taskIdSchema.optional(),
    timeEstimate: z.number().finite().min(0).optional(),
    isDone: z.boolean().optional(),
    dueDay: dateStringSchema.nullable().optional(),
    dueWithTime: z.number().finite().positive().nullable().optional(),
    deadlineDay: dateStringSchema.nullable().optional(),
    deadlineWithTime: z.number().finite().positive().nullable().optional(),
    deadlineRemindAt: z.number().finite().positive().nullable().optional(),
  })
  .strict()
  .refine((input) => !(input.dueDay && input.dueWithTime), {
    message: 'dueDay and dueWithTime cannot both be set',
  })
  .refine((input) => !(input.deadlineDay && input.deadlineWithTime), {
    message: 'deadlineDay and deadlineWithTime cannot both be set',
  })
  .refine((input) => !(input.projectId && input.projectName), {
    message: 'Provide projectId or projectName, not both',
  })
  .refine((input) => !(input.tagIds && input.tagNames), {
    message: 'Provide tagIds or tagNames, not both',
  });

const updateTaskInputSchema = z
  .object({
    taskId: taskIdSchema,
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(100_000).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    projectName: z.string().trim().min(1).max(200).optional(),
    tagIds: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
    tagNames: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    timeEstimate: z.number().finite().min(0).optional(),
    isDone: z.boolean().optional(),
    priority: prioritySchema.optional(),
    dueDay: dateStringSchema.nullable().optional(),
    dueWithTime: z.number().finite().positive().nullable().optional(),
    deadlineDay: dateStringSchema.nullable().optional(),
    deadlineWithTime: z.number().finite().positive().nullable().optional(),
    deadlineRemindAt: z.number().finite().positive().nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== 'taskId'), {
    message: 'Provide at least one field to update',
  })
  .refine((input) => !(input.dueDay && input.dueWithTime), {
    message: 'dueDay and dueWithTime cannot both be set',
  })
  .refine((input) => !(input.deadlineDay && input.deadlineWithTime), {
    message: 'deadlineDay and deadlineWithTime cannot both be set',
  })
  .refine((input) => !(input.projectId && input.projectName), {
    message: 'Provide projectId or projectName, not both',
  })
  .refine((input) => !(input.tagIds && input.tagNames), {
    message: 'Provide tagIds or tagNames, not both',
  });

const listProjectsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    includeTaskOrder: z.boolean().optional().default(false),
  })
  .strict();

const listTagsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    includeTaskOrder: z.boolean().optional().default(false),
  })
  .strict();

const getTaskInputSchema = z
  .object({
    taskId: taskIdSchema,
    includeRelated: z.boolean().optional().default(true),
    includeIssueUrl: z.boolean().optional().default(false),
  })
  .strict();

const updateTaskTagsInputSchema = z
  .object({
    taskId: taskIdSchema,
    addTagNames: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    removeTagNames: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  })
  .strict()
  .refine((input) => (input.addTagNames?.length ?? 0) + (input.removeTagNames?.length ?? 0) > 0, {
    message: 'Provide at least one tag name to add or remove',
  });

const startAtSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      /T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)),
    'startAt must be an ISO-8601 timestamp with an explicit timezone offset',
  );

const bulkTaskChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(100_000).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    tagIds: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
    timeEstimate: z.number().finite().min(0).optional(),
    isDone: z.boolean().optional(),
    priority: prioritySchema.optional(),
    dueDay: dateStringSchema.nullable().optional(),
    dueWithTime: z.number().finite().positive().nullable().optional(),
    deadlineDay: dateStringSchema.nullable().optional(),
    deadlineWithTime: z.number().finite().positive().nullable().optional(),
    deadlineRemindAt: z.number().finite().positive().nullable().optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: 'Provide at least one field to update',
  })
  .refine((changes) => !(changes.dueDay && changes.dueWithTime), {
    message: 'dueDay and dueWithTime cannot both be set',
  })
  .refine((changes) => !(changes.deadlineDay && changes.deadlineWithTime), {
    message: 'deadlineDay and deadlineWithTime cannot both be set',
  });

const bulkUpdateTasksInputSchema = z
  .object({
    updates: z
      .array(z.object({ taskId: taskIdSchema, changes: bulkTaskChangesSchema }).strict())
      .min(1)
      .max(25),
    dryRun: z.boolean().optional().default(true),
  })
  .strict()
  .refine(
    (input) => new Set(input.updates.map(({ taskId }) => taskId)).size === input.updates.length,
    {
      message: 'Each taskId may appear only once in a batch',
    },
  );

const planTaskTodayInputSchema = z
  .object({
    taskId: taskIdSchema,
    startAt: startAtSchema.optional(),
  })
  .strict();

const ensureGithubIssueInputSchema = z
  .object({
    issue: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().trim().max(10_000).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    planToday: z.boolean().optional().default(false),
  })
  .strict();

type SearchTasksInput = z.infer<typeof searchTasksInputSchema>;
type ListTodayInput = z.infer<typeof listTodayInputSchema>;
type TaskActionInput = z.infer<typeof taskActionInputSchema>;
type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
type GetTaskInput = z.infer<typeof getTaskInputSchema>;
type UpdateTaskTagsInput = z.infer<typeof updateTaskTagsInputSchema>;
type BulkUpdateTasksInput = z.infer<typeof bulkUpdateTasksInputSchema>;
type TaskQueueInput = z.infer<typeof taskQueueInputSchema>;
type PlanTaskTodayInput = z.infer<typeof planTaskTodayInputSchema>;
type EnsureGithubIssueInput = z.infer<typeof ensureGithubIssueInputSchema>;

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly client: SuperProductivityClient;
  readonly semanticApiClient?: SuperProductivityClient;
  readonly logger: Logger;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const STATE_CHANGE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const todayDateString = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isToday = (task: SpTask, date = new Date()): boolean => {
  if (typeof task.dueWithTime === 'number') {
    return todayDateString(new Date(task.dueWithTime)) === todayDateString(date);
  }
  return task.dueDay === todayDateString(date);
};

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly isDone: boolean;
  readonly projectId: string | null;
  readonly plannedForToday: boolean;
  readonly dueDay: string | null;
  readonly dueWithTime: number | null;
  readonly timeEstimate: number;
  readonly timeSpent: number;
  readonly parentId: string | null;
  readonly subTaskIds: readonly string[];
  readonly notes: string | null;
  readonly tagIds: readonly string[];
  readonly deadlineDay: string | null;
  readonly deadlineWithTime: number | null;
  readonly deadlineRemindAt: number | null;
  readonly created: number | null;
  readonly updated: number | null;
  readonly priority: number | null;
  readonly issue: {
    readonly provider: string;
    readonly id: string;
    readonly providerId: string | null;
  } | null;
}

export const summarizeTask = (task: SpTask, date = new Date()): TaskSummary => ({
  id: task.id,
  title: task.title,
  isDone: task.isDone ?? false,
  projectId: task.projectId ?? null,
  plannedForToday: isToday(task, date),
  dueDay: task.dueDay ?? null,
  dueWithTime: task.dueWithTime ?? null,
  timeEstimate: task.timeEstimate ?? 0,
  timeSpent: task.timeSpent ?? 0,
  parentId: task.parentId ?? null,
  subTaskIds: task.subTaskIds ?? [],
  notes: task.notes ?? null,
  tagIds: task.tagIds ?? [],
  deadlineDay: task.deadlineDay ?? null,
  deadlineWithTime: task.deadlineWithTime ?? null,
  deadlineRemindAt: task.deadlineRemindAt ?? null,
  created: typeof task.created === 'number' ? task.created : null,
  updated: typeof task.updated === 'number' ? task.updated : null,
  priority: typeof task.priority === 'number' ? task.priority : null,
  issue:
    task.issueType && task.issueId !== undefined && task.issueId !== null
      ? {
          provider: task.issueType,
          id: String(task.issueId),
          providerId: task.issueProviderId ?? null,
        }
      : null,
});

const readTaskAttachments = (task: SpTask): SpTaskAttachment[] => {
  const raw = task['attachments'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new AppError('SP_INVALID_RESPONSE', 'Task attachment metadata has an invalid shape');
  return raw.map((item) => {
    const parsed = SpTaskAttachmentSchema.safeParse(item);
    if (!parsed.success)
      throw new AppError('SP_INVALID_RESPONSE', 'Task attachment metadata has an invalid shape');
    return parsed.data;
  });
};

const verifyUnchangedTaskMetadata = (before: SpTask, after: SpTask): void => {
  for (const key of [
    'title',
    'notes',
    'projectId',
    'tagIds',
    'timeEstimate',
    'timeSpent',
    'priority',
    'dueDay',
    'dueWithTime',
    'deadlineDay',
    'deadlineWithTime',
    'deadlineRemindAt',
    'isDone',
    'parentId',
    'subTaskIds',
  ] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      throw new AppError(
        'SP_WRITE_NOT_CONFIRMED',
        `Attachment mutation unexpectedly changed ${key}`,
      );
  }
};

const verifyTaskFields = (task: SpTask, expected: Record<string, unknown>): void => {
  const failedFields = Object.entries(expected)
    .filter(([key, value]) => {
      if (key === 'isIgnoreShortSyntax') return false;
      const actual = task[key];
      if (value === null && actual == null) return false;
      if (Array.isArray(value)) {
        return !Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(value);
      }
      return actual !== value;
    })
    .map(([key]) => key);
  if (failedFields.length > 0) {
    throw new AppError(
      'SP_WRITE_NOT_CONFIRMED',
      `Super Productivity did not confirm the requested task fields (${failedFields.join(', ')}). Read the task before retrying.`,
      { details: { taskId: task.id, failedFields } },
    );
  }
};

const toolSuccess = <T extends Record<string, unknown>>(data: T) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

type DefinedOptional<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

const omitUndefined = <T extends object>(input: T): DefinedOptional<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as DefinedOptional<T>;

const resolveExactName = <T extends { id: string; title: string }>(
  name: string,
  candidates: readonly T[],
  kind: 'project' | 'tag',
): T => {
  const normalizedName = name.trim().toLocaleLowerCase();
  const matches = candidates.filter(
    (item) => item.title.trim().toLocaleLowerCase() === normalizedName,
  );
  const firstMatch = matches[0];
  if (!firstMatch) {
    throw new AppError(`${kind.toUpperCase()}_NOT_FOUND`, `No ${kind} exactly matches "${name}"`);
  }
  if (matches.length > 1) {
    throw new AppError('AMBIGUOUS_NAME', `More than one ${kind} is named "${name}"; use its ID`, {
      details: { kind, matches: matches.map(({ id, title }) => ({ id, title })) },
    });
  }
  return firstMatch;
};

const resolveTaskReferences = async (
  client: SuperProductivityClient,
  input: {
    readonly projectId?: string;
    readonly projectName?: string;
    readonly tagIds?: string[];
    readonly tagNames?: string[];
  },
): Promise<{ projectId?: string; tagIds?: string[] }> => {
  const [projects, tags] = await Promise.all([
    input.projectName ? client.listProjects(input.projectName) : Promise.resolve([]),
    input.tagNames ? client.listTags() : Promise.resolve([]),
  ]);
  const project = input.projectName
    ? resolveExactName(input.projectName, projects, 'project')
    : undefined;
  const resolvedTags = input.tagNames?.map((name) => resolveExactName(name, tags, 'tag').id);
  return {
    ...(input.projectId
      ? { projectId: input.projectId }
      : project
        ? { projectId: project.id }
        : {}),
    ...(input.tagIds || resolvedTags ? { tagIds: input.tagIds ?? [...new Set(resolvedTags)] } : {}),
  };
};

const toolFailure = (error: unknown, logger: Logger) => {
  const publicError = toPublicError(error);
  logger.warn('MCP tool failed', {
    code: publicError.code,
    status: publicError.status,
    message: publicError.message,
  });
  const data = { error: { code: publicError.code, message: publicError.message } };
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
};

const withToolErrors = async <T extends Record<string, unknown>>(
  action: () => Promise<T>,
  logger: Logger,
) => {
  try {
    return toolSuccess(await action());
  } catch (error) {
    return toolFailure(error, logger);
  }
};

const taskListOptions = async (
  client: SuperProductivityClient,
  input: SearchTasksInput,
): Promise<ListTasksOptions> => {
  const references = await resolveTaskReferences(client, {
    ...omitUndefined({
      projectId: input.projectId,
      projectName: input.projectName,
      tagNames: input.tagName ? [input.tagName] : undefined,
    }),
  });
  return {
    ...(input.query ? { query: input.query } : {}),
    ...(references.projectId ? { projectId: references.projectId } : {}),
    ...(input.tagId
      ? { tagId: input.tagId }
      : references.tagIds?.[0]
        ? { tagId: references.tagIds[0] }
        : {}),
    includeDone: input.includeDone,
    source: input.source as TaskSource,
  };
};

export const createMcpServer = ({
  config,
  client,
  semanticApiClient,
  logger,
}: ServerDependencies): McpServer => {
  const server = new McpServer(
    {
      name: 'super-productivity-mcp',
      version: '0.1.0',
    },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        'Task changes require an explicit taskId. Use search_tasks or get_task to identify it. update_task uses sparse PATCH semantics: omitted fields stay unchanged; null clears only supported nullable fields. Read the returned task to verify a change. Do not infer targets or retry a mutation whose outcome is unknown. ensure_github_issue_task is idempotent and plans only when planToday=true.',
    },
  );

  const checkConnection = () =>
    withToolErrors(async () => {
      try {
        const health = await client.health();
        const configured = health.server === 'up' && health.rendererReady;
        return {
          connected: configured,
          reachable: true,
          rendererReady: health.rendererReady,
          configured,
          tokenConfigured: Boolean(config.apiToken),
          apiUrl: config.apiUrl.toString(),
          semanticApi: semanticApiClient
            ? await semanticApiClient
                .semanticApiCapabilities()
                .then((capabilities) => ({
                  configured: true,
                  available: capabilities.protocolVersion === '1',
                  priorityAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.priority.set'),
                  hierarchyAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.hierarchy.set_parent'),
                  projectAdminAvailable:
                    capabilities.protocolVersion === '1' &&
                    ['project.create', 'project.rename', 'project.delete_empty'].every((feature) =>
                      capabilities.features.includes(feature),
                    ),
                  tagAdminAvailable:
                    capabilities.protocolVersion === '1' &&
                    ['tag.create', 'tag.update', 'tag.delete_empty'].every((feature) =>
                      capabilities.features.includes(feature),
                    ),
                  timeAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.time.adjust'),
                  attachmentLinkAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.attachments.add_link'),
                  attachmentRenameAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.attachments.rename'),
                  attachmentDetachAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.attachments.detach'),
                  orderingScopes:
                    capabilities.protocolVersion === '1'
                      ? ['subtasks', 'project', 'backlog', 'tag'].filter((scope) =>
                          capabilities.features.includes(`task.order.${scope}`),
                        )
                      : [],
                  ...capabilities,
                }))
                .catch(() => ({
                  configured: true,
                  available: false,
                  priorityAvailable: false,
                  hierarchyAvailable: false,
                  projectAdminAvailable: false,
                  tagAdminAvailable: false,
                  timeAvailable: false,
                  attachmentLinkAvailable: false,
                  attachmentRenameAvailable: false,
                  attachmentDetachAvailable: false,
                  orderingScopes: [],
                  features: [],
                }))
            : { available: false, configured: false },
        };
      } catch (error) {
        const publicError = toPublicError(error);
        return {
          connected: false,
          reachable: false,
          rendererReady: false,
          configured: false,
          tokenConfigured: Boolean(config.apiToken),
          apiUrl: config.apiUrl.toString(),
          error: { code: publicError.code, message: publicError.message },
          semanticApi: semanticApiClient
            ? await semanticApiClient
                .semanticApiCapabilities()
                .then((capabilities) => ({
                  configured: true,
                  available: capabilities.protocolVersion === '1',
                  priorityAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.priority.set'),
                  hierarchyAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.hierarchy.set_parent'),
                  projectAdminAvailable:
                    capabilities.protocolVersion === '1' &&
                    ['project.create', 'project.rename', 'project.delete_empty'].every((feature) =>
                      capabilities.features.includes(feature),
                    ),
                  tagAdminAvailable:
                    capabilities.protocolVersion === '1' &&
                    ['tag.create', 'tag.update', 'tag.delete_empty'].every((feature) =>
                      capabilities.features.includes(feature),
                    ),
                  timeAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.time.adjust'),
                  attachmentLinkAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.attachments.add_link'),
                  attachmentRenameAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.attachments.rename'),
                  attachmentDetachAvailable:
                    capabilities.protocolVersion === '1' &&
                    capabilities.features.includes('task.attachments.detach'),
                  orderingScopes:
                    capabilities.protocolVersion === '1'
                      ? ['subtasks', 'project', 'backlog', 'tag'].filter((scope) =>
                          capabilities.features.includes(`task.order.${scope}`),
                        )
                      : [],
                  ...capabilities,
                }))
                .catch(() => ({
                  configured: true,
                  available: false,
                  priorityAvailable: false,
                  hierarchyAvailable: false,
                  projectAdminAvailable: false,
                  tagAdminAvailable: false,
                  timeAvailable: false,
                  attachmentLinkAvailable: false,
                  attachmentRenameAvailable: false,
                  attachmentDetachAvailable: false,
                  orderingScopes: [],
                  features: [],
                }))
            : { available: false, configured: false },
        };
      }
    }, logger);

  for (const name of ['health', 'check_connection'] as const) {
    server.registerTool(
      name,
      {
        title: 'Check Super Productivity connection',
        description:
          'Check whether the local Super Productivity desktop API is reachable and ready.',
        inputSchema: emptyInputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async () => checkConnection(),
    );
  }

  server.registerTool(
    'search_tasks',
    {
      title: 'Search Super Productivity tasks',
      description:
        'Find tasks by title, project, or tag. Name filters require an exact unique project/tag name; ambiguous names fail instead of guessing. Returns task IDs for explicit follow-up actions.',
      inputSchema: searchTasksInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        const tasks = await client.listTasks(await taskListOptions(client, input));
        const limited = tasks.slice(0, input.limit);
        return {
          tasks: limited.map((task) => summarizeTask(task)),
          totalMatches: tasks.length,
          returned: limited.length,
          truncated: tasks.length > limited.length,
        };
      }, logger),
  );

  server.registerTool(
    'query_task_queue',
    {
      title: 'Find overdue, upcoming, or unscheduled tasks',
      description:
        'Query active tasks by planned date and/or deadline. Results are day-based in the MCP host local timezone; asOfDate can be supplied for a specific date. Upcoming includes today and the following withinDays calendar days.',
      inputSchema: taskQueueInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: TaskQueueInput) =>
      withToolErrors(async () => {
        const references = await resolveTaskReferences(client, {
          ...omitUndefined({
            projectId: input.projectId,
            projectName: input.projectName,
            tagNames: input.tagName ? [input.tagName] : undefined,
          }),
        });
        const tasks = await client.listTasks({
          source: 'active',
          includeDone: false,
          ...(references.projectId ? { projectId: references.projectId } : {}),
          ...(input.tagId
            ? { tagId: input.tagId }
            : references.tagIds?.[0]
              ? { tagId: references.tagIds[0] }
              : {}),
        });
        const asOfDate = input.asOfDate ?? todayDateString();
        const matches = queryTaskQueue(tasks, {
          kind: input.kind as TaskQueueKind,
          asOfDate,
          withinDays: input.withinDays,
        });
        const limited = matches.slice(0, input.limit);
        return {
          kind: input.kind,
          asOfDate,
          withinDays: input.withinDays,
          tasks: limited.map(({ task, reasons, relevantDates }) => ({
            ...summarizeTask(task),
            queueReasons: reasons,
            relevantDates,
          })),
          totalMatches: matches.length,
          returned: limited.length,
          truncated: matches.length > limited.length,
        };
      }, logger),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get a task and its context',
      description:
        'Return the full task metadata. By default, also resolve project/tag names and parent/subtask summaries in batched requests. Issue URL lookup is optional because some integrations make a provider request.',
      inputSchema: getTaskInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: GetTaskInput) =>
      withToolErrors(async () => {
        let allTasks: SpTask[] | undefined;
        let task: SpTask;
        try {
          task = await client.getTask(input.taskId, { includeIssueUrl: input.includeIssueUrl });
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'TASK_NOT_FOUND') throw error;
          allTasks = await client.listTasks({ source: 'all', includeDone: true });
          const archivedTask = allTasks.find((item) => item.id === input.taskId);
          if (!archivedTask) throw error;
          task = archivedTask;
        }
        if (!input.includeRelated) return { task };

        const [relatedTasks, projects, tags] = await Promise.all([
          allTasks ?? client.listTasks({ source: 'all', includeDone: true }),
          client.listProjects(),
          client.listTags(),
        ]);
        const taskById = new Map(relatedTasks.map((item) => [item.id, item]));
        const project = projects.find((item) => item.id === task.projectId);
        const tagById = new Map(tags.map((item) => [item.id, item]));
        const parent = task.parentId ? taskById.get(task.parentId) : undefined;
        const subtasks = (task.subTaskIds ?? [])
          .map((id) => taskById.get(id))
          .filter((item): item is SpTask => item !== undefined);

        return {
          task,
          context: {
            project: project ? { id: project.id, title: project.title } : null,
            tags: (task.tagIds ?? []).map((id) => {
              const tag = tagById.get(id);
              return tag ? { id: tag.id, title: tag.title } : { id, title: null };
            }),
            parent: parent ? summarizeTask(parent) : null,
            subtasks: subtasks.map((item) => summarizeTask(item)),
          },
        };
      }, logger),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List Super Productivity projects',
      description:
        'List project IDs and names for reliable task context and name resolution. Task ordering arrays are included only when requested.',
      inputSchema: listProjectsInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        const projects = await client.listProjects(input.query);
        return {
          projects: projects.map((project) => ({
            id: project.id,
            title: project.title,
            isArchived: project.isArchived ?? null,
            isDone: project.isDone ?? null,
            isHiddenFromMenu: project.isHiddenFromMenu ?? null,
            isEnableBacklog: project.isEnableBacklog ?? null,
            ...(input.includeTaskOrder
              ? { taskIds: project.taskIds ?? [], backlogTaskIds: project.backlogTaskIds ?? [] }
              : {}),
          })),
          total: projects.length,
        };
      }, logger),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List Super Productivity tags',
      description:
        'List tag IDs and names for reliable task context and name resolution. The Today tag is virtual and should be queried through search_tasks, not assigned as a task tag.',
      inputSchema: listTagsInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        const tags = await client.listTags(input.query);
        return {
          tags: tags.map((tag) => ({
            id: tag.id,
            title: tag.title,
            color: tag.color ?? null,
            icon: tag.icon ?? null,
            ...(input.includeTaskOrder ? { taskIds: tag.taskIds ?? [] } : {}),
          })),
          total: tags.length,
        };
      }, logger),
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create one task',
      description:
        'Create exactly one task with supplied REST-supported metadata. Omitted fields use app defaults. projectName/tagNames resolve only exact unique names; use IDs for duplicate names. For a subtask, supply parentId and omit projectId/tagIds/projectName/tagNames because those are inherited. Literal title syntax is preserved.',
      inputSchema: createTaskInputSchema,
      annotations: CREATE_ANNOTATIONS,
    },
    async (input: CreateTaskInput) =>
      withToolErrors(async () => {
        const { title, projectId, projectName, tagIds, tagNames, ...optionalFields } = input;
        const references = await resolveTaskReferences(client, {
          ...omitUndefined({ projectId, projectName, tagIds, tagNames }),
        });
        const task = await client.createTask({
          title,
          ...omitUndefined({ ...optionalFields, ...references }),
        });
        verifyTaskFields(task, { title, ...optionalFields, ...references });
        return { created: true, resolvedReferences: references, task };
      }, logger),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task metadata',
      description:
        'Apply a sparse update to exactly one task. Supported fields include title, notes, project, tags, estimate, completion, planning date/time, deadline/reminder, and priority (requires an app version with the extended semantic API route). Omitted fields are preserved; use an empty notes string to clear notes and null to clear nullable schedule/deadline fields. projectName/tagNames resolve only exact unique names; tagIds/tagNames replace the task tag list. Priority updates require the enhanced semantic API capability. Repeat rules are not writable. Use add_task_link_attachment, rename_task_attachment, and detach_task_attachment for the safe attachment operations; these also require the enhanced API. Local-file and image attachment writes remain unavailable. Use adjust_task_time for historical time and set_task_parent for hierarchy changes.',
      inputSchema: updateTaskInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: UpdateTaskInput) =>
      withToolErrors(async () => {
        const { taskId, projectId, projectName, tagIds, tagNames, priority, ...changes } = input;
        const references = await resolveTaskReferences(client, {
          ...omitUndefined({ projectId, projectName, tagIds, tagNames }),
        });
        const finalChanges = omitUndefined({ ...changes, ...references });
        let task = await client.getTask(taskId);
        if (Object.keys(finalChanges).length > 0) {
          task = await client.updateTask(taskId, finalChanges);
          verifyTaskFields(task, finalChanges);
        }
        if (priority !== undefined) {
          if (!semanticApiClient) {
            throw new AppError(
              'FEATURE_UNAVAILABLE',
              'Priority updates require a Super Productivity app version with the task.priority.set extended semantic API capability.',
            );
          }
          task = await semanticApiClient.setTaskPriority(taskId, priority);
          verifyTaskFields(task, { priority });
        }
        return {
          updated: true,
          changedFields: [
            ...Object.keys(finalChanges),
            ...(priority !== undefined ? ['priority'] : []),
          ],
          resolvedReferences: references,
          task,
        };
      }, logger),
  );

  server.registerTool(
    'adjust_task_time',
    {
      title: 'Add or correct time on a date',
      description:
        'Add or subtract a positive duration in milliseconds from one task on an explicit YYYY-MM-DD date. This edits historical task time, not the running timer or time-tracking session records. Subtraction cannot take a day below zero. Requires the enhanced semantic API.',
      inputSchema: adjustTaskTimeInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError(
            'FEATURE_UNAVAILABLE',
            'Manual time edits require the task.time.adjust enhanced API capability',
          );
        const before = await client.getTask(input.taskId);
        const getDay = (task: SpTask): number => {
          const history = task['timeSpentOnDay'];
          if (history === undefined || history === null) return 0;
          if (typeof history !== 'object' || Array.isArray(history))
            throw new AppError('SP_INVALID_RESPONSE', 'Task time history has an invalid shape');
          const value = (history as Record<string, unknown>)[input.date] ?? 0;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            throw new AppError('SP_INVALID_RESPONSE', 'Task day total is invalid');
          return value;
        };
        const beforeDay = getDay(before);
        const beforeTotal = before.timeSpent ?? 0;
        const result = await semanticApiClient.adjustTaskTime(
          input.taskId,
          input.operation,
          input.date,
          input.durationMs,
        );
        const after = await client.getTask(input.taskId);
        const applied =
          input.operation === 'add' ? input.durationMs : Math.min(input.durationMs, beforeDay);
        const expectedDay = input.operation === 'add' ? beforeDay + applied : beforeDay - applied;
        const expectedTotal =
          input.operation === 'add' ? beforeTotal + applied : beforeTotal - applied;
        const actualDay = getDay(after);
        if (
          actualDay !== expectedDay ||
          after.timeSpent !== expectedTotal ||
          result.date !== input.date ||
          result.dayTotal !== expectedDay ||
          result.total !== expectedTotal
        ) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'Persisted task time did not match the requested date adjustment',
          );
        }
        for (const key of [
          'title',
          'notes',
          'projectId',
          'tagIds',
          'timeEstimate',
          'priority',
          'dueDay',
          'deadlineDay',
          'parentId',
          'subTaskIds',
        ] as const) {
          if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
            throw new AppError(
              'SP_WRITE_NOT_CONFIRMED',
              `Time adjustment unexpectedly changed ${key}`,
            );
        }
        return {
          updated: true,
          verified: true,
          taskId: after.id,
          date: input.date,
          operation: input.operation,
          requestedDurationMs: input.durationMs,
          appliedDurationMs: applied,
          dayTotalMs: actualDay,
          totalTimeSpentMs: after.timeSpent,
          task: summarizeTask(after),
        };
      }, logger),
  );

  server.registerTool(
    'add_task_link_attachment',
    {
      title: 'Add a web link to a task',
      description:
        'Attach one HTTP(S) link to an exact live task. Requires the enhanced semantic API capability task.attachments.add_link. The app stores the URL as metadata and does not fetch it; opening the link remains a user action. Embedded URL credentials and non-web schemes are rejected. Local file paths, image sources, and binary uploads are not supported.',
      inputSchema: addTaskLinkAttachmentInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError('FEATURE_UNAVAILABLE', 'Link attachments require the enhanced API');
        const before = await client.getTask(input.taskId);
        const beforeAttachments = readTaskAttachments(before);
        const result = await semanticApiClient.addTaskLinkAttachment(
          input.taskId,
          input.url,
          input.title,
        );
        const after = await client.getTask(input.taskId);
        const afterAttachments = readTaskAttachments(after);
        const attachment = result.attachment;
        if (
          !attachment.id ||
          attachment.type !== 'LINK' ||
          attachment.path !== new URL(input.url).toString() ||
          (input.title !== undefined && attachment.title !== input.title.trim()) ||
          beforeAttachments.some(({ id }) => id === attachment.id) ||
          !afterAttachments.some(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(attachment),
          ) ||
          JSON.stringify(afterAttachments.filter(({ id }) => id !== attachment.id)) !==
            JSON.stringify(beforeAttachments)
        )
          throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Link attachment readback did not match');
        verifyUnchangedTaskMetadata(before, after);
        return { created: true, taskId: input.taskId, attachment };
      }, logger),
  );

  server.registerTool(
    'rename_task_attachment',
    {
      title: 'Rename a task attachment',
      description:
        'Requires the enhanced semantic API capability task.attachments.rename. Change only the display title of one attachment on an exact live task. Its path, type, and other metadata are preserved.',
      inputSchema: renameTaskAttachmentInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError(
            'FEATURE_UNAVAILABLE',
            'Attachment metadata edits require the enhanced API',
          );
        const before = await client.getTask(input.taskId);
        const beforeAttachments = readTaskAttachments(before);
        const prior = beforeAttachments.find(({ id }) => id === input.attachmentId);
        if (!prior) throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment is not on this task');
        const result = await semanticApiClient.renameTaskAttachment(
          input.taskId,
          input.attachmentId,
          input.title,
        );
        const after = await client.getTask(input.taskId);
        const afterAttachments = readTaskAttachments(after);
        const updated = afterAttachments.find(({ id }) => id === input.attachmentId);
        const expected = { ...prior, title: input.title.trim() };
        if (
          !updated ||
          JSON.stringify(updated) !== JSON.stringify(expected) ||
          JSON.stringify(afterAttachments.filter(({ id }) => id !== input.attachmentId)) !==
            JSON.stringify(beforeAttachments.filter(({ id }) => id !== input.attachmentId)) ||
          JSON.stringify(result.attachment) !== JSON.stringify(updated)
        )
          throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Attachment title readback did not match');
        verifyUnchangedTaskMetadata(before, after);
        return { updated: true, taskId: input.taskId, attachment: updated };
      }, logger),
  );

  server.registerTool(
    'detach_task_attachment',
    {
      title: 'Remove an attachment from a task',
      description:
        'Requires the enhanced semantic API capability task.attachments.detach. Remove one exact attachment metadata entry from a live task. This does not delete, read, or fetch the referenced file or URL.',
      inputSchema: detachTaskAttachmentInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError('FEATURE_UNAVAILABLE', 'Attachment changes require the enhanced API');
        const before = await client.getTask(input.taskId);
        const beforeAttachments = readTaskAttachments(before);
        if (!beforeAttachments.some(({ id }) => id === input.attachmentId))
          throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment is not on this task');
        const result = await semanticApiClient.detachTaskAttachment(
          input.taskId,
          input.attachmentId,
        );
        const after = await client.getTask(input.taskId);
        const afterAttachments = readTaskAttachments(after);
        const expected = beforeAttachments.filter(({ id }) => id !== input.attachmentId);
        if (
          result.attachmentId !== input.attachmentId ||
          !result.detached ||
          afterAttachments.some(({ id }) => id === input.attachmentId) ||
          JSON.stringify(afterAttachments) !== JSON.stringify(expected)
        )
          throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Attachment detach readback did not match');
        verifyUnchangedTaskMetadata(before, after);
        return { detached: true, taskId: input.taskId, attachmentId: input.attachmentId };
      }, logger),
  );

  server.registerTool(
    'manage_project',
    {
      title: 'Create, rename, or delete an empty project',
      description:
        'Manage project names. Creation and rename are explicit. delete_empty is permitted only when the project has no tasks, backlog entries, or notes because Super Productivity project deletion cascades through contained tasks and notes; the built-in Inbox is protected. Requires the enhanced semantic API.',
      inputSchema: manageProjectInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError(
            'FEATURE_UNAVAILABLE',
            'Project administration requires the enhanced API',
          );
        if (input.operation === 'create') {
          const project = await semanticApiClient.createProject(input.title);
          return { created: true, project: { id: project.id, title: project.title } };
        }
        if (input.operation === 'rename') {
          const before = await client.listProjects();
          const old = before.find((project) => project.id === input.projectId);
          if (!old) throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
          const project = await semanticApiClient.renameProject(input.projectId, input.title);
          const after = (await client.listProjects()).find(({ id }) => id === input.projectId);
          if (!after || after.title !== input.title || project.title !== input.title)
            throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Project rename readback did not match');
          return {
            updated: true,
            project: { id: after.id, title: after.title },
            previousTitle: old.title,
          };
        }
        const deleted = await semanticApiClient.deleteEmptyProject(input.projectId);
        if (!deleted.deleted || deleted.id !== input.projectId)
          throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Empty project deletion was not confirmed');
        if ((await client.listProjects()).some(({ id }) => id === input.projectId))
          throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Deleted project still appears in readback');
        return deleted;
      }, logger),
  );

  server.registerTool(
    'manage_tag',
    {
      title: 'Create, update, or delete an empty tag',
      description:
        'Manage tag names and optional hex colors. delete_empty only works when the tag has no tasks. The virtual Today tag is protected. Requires the enhanced semantic API.',
      inputSchema: manageTagInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError('FEATURE_UNAVAILABLE', 'Tag administration requires the enhanced API');
        if (input.operation === 'create') {
          const tag = await semanticApiClient.createTag({
            title: input.title,
            ...(input.color ? { color: input.color } : {}),
          });
          return { created: true, tag: { id: tag.id, title: tag.title, color: tag.color ?? null } };
        }
        if (input.operation === 'update') {
          const before = (await client.listTags()).find(({ id }) => id === input.tagId);
          if (!before) throw new AppError('TAG_NOT_FOUND', 'Tag not found');
          const tag = await semanticApiClient.updateTag(input.tagId, {
            ...(input.title ? { title: input.title } : {}),
            ...(input.color ? { color: input.color } : {}),
          });
          const after = (await client.listTags()).find(({ id }) => id === input.tagId);
          if (
            !after ||
            (input.title && after.title !== input.title) ||
            (input.color && after.color !== input.color) ||
            tag.id !== input.tagId
          )
            throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Tag update readback did not match');
          return {
            updated: true,
            previousTitle: before.title,
            tag: { id: after.id, title: after.title, color: after.color ?? null },
          };
        }
        const deleted = await semanticApiClient.deleteEmptyTag(input.tagId);
        if (!deleted.deleted || deleted.id !== input.tagId)
          throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Empty tag deletion was not confirmed');
        if ((await client.listTags()).some(({ id }) => id === input.tagId))
          throw new AppError('SP_WRITE_NOT_CONFIRMED', 'Deleted tag still appears in readback');
        return deleted;
      }, logger),
  );

  server.registerTool(
    'set_task_parent',
    {
      title: 'Set or remove a task parent',
      description:
        'Assign a top-level task to a parent, move a child to another parent, or promote a child to top-level. Super Productivity enforces a single child level and rejects tasks that cannot be converted. Position defaults to bottom. Requires the enhanced semantic API capability task.hierarchy.set_parent.',
      inputSchema: setTaskParentInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError(
            'FEATURE_UNAVAILABLE',
            'Task hierarchy requires the task.hierarchy.set_parent extended API capability',
          );
        const before = await client.getTask(input.taskId);
        const oldParent = before.parentId ? await client.getTask(before.parentId) : null;
        const mutation = await semanticApiClient.setTaskParent(
          input.taskId,
          input.parentTaskId,
          input.position,
        );
        const task = await client.getTask(input.taskId);
        const parent = input.parentTaskId ? await client.getTask(input.parentTaskId) : null;
        const priorParentAfter =
          oldParent && oldParent.id !== parent?.id ? await client.getTask(oldParent.id) : null;
        if ((task.parentId ?? null) !== input.parentTaskId || mutation.task.id !== task.id) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'Task parent readback does not match the requested parent',
          );
        }
        if (parent && parent.subTaskIds?.filter((id) => id === task.id).length !== 1) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'Parent must reference the child exactly once',
          );
        }
        if (priorParentAfter?.subTaskIds?.includes(task.id)) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'Previous parent still references the child',
          );
        }
        for (const key of ['title', 'notes', 'tagIds', 'timeEstimate', 'priority'] as const) {
          if (JSON.stringify(before[key]) !== JSON.stringify(task[key])) {
            throw new AppError(
              'SP_WRITE_NOT_CONFIRMED',
              `Hierarchy change unexpectedly changed ${key}`,
            );
          }
        }
        return {
          updated: true,
          verified: true,
          task: summarizeTask(task),
          previousParent: oldParent
            ? {
                id: oldParent.id,
                title: oldParent.title,
                childIds: priorParentAfter?.subTaskIds ?? [],
              }
            : null,
          parent: parent
            ? { id: parent.id, title: parent.title, childIds: parent.subTaskIds ?? [] }
            : null,
          siblingIds: parent?.subTaskIds ?? [],
        };
      }, logger),
  );

  server.registerTool(
    'move_task_in_order',
    {
      title: 'Move a task in an ordered list',
      description:
        'Move a task to the top, bottom, before/after a sibling, or a zero-based index within its parent subtasks, project task list, project backlog, or tag task list. The task and reference must already belong to that exact scope. Requires the enhanced semantic API capability for the selected ordering scope.',
      inputSchema: moveTaskInOrderInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input) =>
      withToolErrors(async () => {
        if (!semanticApiClient)
          throw new AppError('FEATURE_UNAVAILABLE', `Ordering requires task.order.${input.scope}`);
        const readOrder = async (): Promise<string[] | undefined> => {
          if (input.scope === 'subtasks') return (await client.getTask(input.scopeId)).subTaskIds;
          if (input.scope === 'project' || input.scope === 'backlog') {
            const projects = await client.listProjects();
            const project = projects.find(({ id }) => id === input.scopeId);
            const value =
              input.scope === 'project' ? project?.['taskIds'] : project?.['backlogTaskIds'];
            return Array.isArray(value) && value.every((id) => typeof id === 'string')
              ? value
              : undefined;
          }
          const tags = await client.listTags();
          const tag = tags.find(({ id }) => id === input.scopeId);
          const value = tag?.['taskIds'];
          return Array.isArray(value) && value.every((id) => typeof id === 'string')
            ? value
            : undefined;
        };
        const beforeTask = await client.getTask(input.taskId);
        const before = await readOrder();
        if (
          !before ||
          before.filter((id) => id === input.taskId).length !== 1 ||
          new Set(before).size !== before.length
        ) {
          throw new AppError(
            'TASK_NOT_IN_ORDERING_SCOPE',
            'Task or ordered membership is missing or inconsistent in the requested scope',
          );
        }
        const mutation = await semanticApiClient.moveTaskInOrder(
          input.taskId,
          input.scope,
          input.scopeId,
          input.position,
        );
        const after = await readOrder();
        const task = await client.getTask(input.taskId);
        if (
          !after ||
          JSON.stringify(after) !== JSON.stringify(mutation.orderedIds) ||
          after.filter((id) => id === input.taskId).length !== 1 ||
          new Set(after).size !== before.length ||
          before.some((id) => !after.includes(id))
        ) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'Ordered list readback did not confirm the move or membership preservation',
          );
        }
        for (const key of [
          'title',
          'notes',
          'projectId',
          'tagIds',
          'timeEstimate',
          'priority',
        ] as const) {
          if (JSON.stringify(beforeTask[key]) !== JSON.stringify(task[key]))
            throw new AppError('SP_WRITE_NOT_CONFIRMED', `Ordering unexpectedly changed ${key}`);
        }
        const index = after.indexOf(input.taskId);
        return {
          moved: true,
          verified: true,
          task: summarizeTask(task),
          scope: input.scope,
          scopeId: input.scopeId,
          previousTaskId: index > 0 ? after[index - 1] : null,
          nextTaskId: index + 1 < after.length ? after[index + 1] : null,
          memberCount: after.length,
        };
      }, logger),
  );

  server.registerTool(
    'bulk_update_tasks',
    {
      title: 'Update multiple tasks',
      description:
        'Preview sparse metadata changes for up to 25 explicitly identified tasks. dryRun defaults to true. Priority updates require the enhanced semantic API; other supported fields use the stock task API. Applying writes updates one at a time and stops after an uncertain write.',
      inputSchema: bulkUpdateTasksInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: BulkUpdateTasksInput) =>
      withToolErrors(async () => {
        if (input.dryRun) return { dryRun: true, updates: input.updates };
        const current = await client.listTasks({ source: 'active', includeDone: true });
        const currentById = new Map(current.map((task) => [task.id, task]));
        const currentIds = new Set(currentById.keys());
        const results: Array<Record<string, unknown>> = [];
        let stopped = false;
        for (const { taskId, changes } of input.updates) {
          if (stopped) {
            results.push({ taskId, status: 'not_attempted' });
            continue;
          }
          if (!currentIds.has(taskId)) {
            results.push({ taskId, status: 'failed', error: 'TASK_NOT_FOUND' });
            continue;
          }
          try {
            const { priority, ...rest } = changes;
            let task = currentById.get(taskId);
            if (!task) {
              results.push({ taskId, status: 'failed', error: 'TASK_NOT_FOUND' });
              continue;
            }
            if (Object.keys(rest).length > 0) {
              task = await client.updateTask(taskId, omitUndefined(rest));
              verifyTaskFields(task, rest);
            }
            if (priority !== undefined) {
              if (!semanticApiClient)
                throw new AppError(
                  'FEATURE_UNAVAILABLE',
                  'Priority updates require a Super Productivity app version with the task.priority.set extended semantic API capability.',
                );
              task = await semanticApiClient.setTaskPriority(taskId, priority);
              verifyTaskFields(task, { priority });
            }
            results.push({ taskId, status: 'updated', task: summarizeTask(task) });
          } catch (error) {
            const code = error instanceof AppError ? error.code : 'UNKNOWN_ERROR';
            results.push({
              taskId,
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
            if (code === 'SP_MUTATION_OUTCOME_UNKNOWN' || code === 'SP_WRITE_NOT_CONFIRMED')
              stopped = true;
          }
        }
        return { dryRun: false, results, stoppedAfterUncertainWrite: stopped };
      }, logger),
  );

  server.registerTool(
    'update_task_tags',
    {
      title: 'Add or remove task tags',
      description:
        'Add and/or remove tags by exact name while preserving the task’s other current tags. Duplicate names are rejected. This reads the current tag list then patches it, so simultaneous edits from another client can race.',
      inputSchema: updateTaskTagsInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: UpdateTaskTagsInput) =>
      withToolErrors(async () => {
        const [task, tags] = await Promise.all([client.getTask(input.taskId), client.listTags()]);
        const additions = (input.addTagNames ?? []).map((name) =>
          resolveExactName(name, tags, 'tag'),
        );
        const removals = (input.removeTagNames ?? []).map((name) =>
          resolveExactName(name, tags, 'tag'),
        );
        const removedIds = new Set(removals.map((tag) => tag.id));
        const nextTagIds = [
          ...new Set([
            ...(task.tagIds ?? []).filter((id) => !removedIds.has(id)),
            ...additions.map((tag) => tag.id),
          ]),
        ];
        if (
          nextTagIds.length === (task.tagIds ?? []).length &&
          nextTagIds.every((id) => task.tagIds?.includes(id))
        ) {
          return { updated: false, task, tags: nextTagIds };
        }
        const updatedTask = await client.updateTask(input.taskId, { tagIds: nextTagIds });
        const savedTagIds = updatedTask.tagIds ?? [];
        if (
          savedTagIds.length !== nextTagIds.length ||
          nextTagIds.some((id) => !savedTagIds.includes(id))
        ) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'The tag update response did not contain the requested tag set. Read the task before retrying.',
          );
        }
        return {
          updated: true,
          added: additions.map(({ id, title }) => ({ id, title })),
          removed: removals.map(({ id, title }) => ({ id, title })),
          task: updatedTask,
        };
      }, logger),
  );

  server.registerTool(
    'list_today',
    {
      title: "List today's tasks",
      description: 'List tasks explicitly planned for Today in Super Productivity.',
      inputSchema: listTodayInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: ListTodayInput) =>
      withToolErrors(async () => {
        const tasks = await client.listTasks({
          tagId: 'TODAY',
          includeDone: input.includeDone,
          source: 'active',
        });
        const limited = tasks.slice(0, input.limit);
        return {
          tasks: limited.map((task) => summarizeTask(task)),
          totalToday: tasks.length,
          returned: limited.length,
          truncated: tasks.length > limited.length,
        };
      }, logger),
  );

  server.registerTool(
    'plan_task_today',
    {
      title: 'Plan one task for Today',
      description:
        'Place exactly the supplied task ID in Today, optionally at an explicit ISO timestamp.',
      inputSchema: planTaskTodayInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: PlanTaskTodayInput) =>
      withToolErrors(async () => {
        const startAtMs = input.startAt ? Date.parse(input.startAt) : undefined;
        if (startAtMs !== undefined && todayDateString(new Date(startAtMs)) !== todayDateString()) {
          throw new AppError(
            'INVALID_INPUT',
            'startAt must fall on the current local day for plan_task_today',
          );
        }
        const task = await client.updateTask(input.taskId, {
          ...(startAtMs === undefined
            ? { dueDay: todayDateString(), dueWithTime: null }
            : { dueDay: null, dueWithTime: startAtMs }),
        });
        return {
          task: summarizeTask(task),
          plannedForToday: true,
          mode: startAtMs === undefined ? 'all-day' : 'timed',
        };
      }, logger),
  );

  server.registerTool(
    'start_task',
    {
      title: 'Start one task',
      description: 'Start tracking exactly the supplied task ID as the current task.',
      inputSchema: taskActionInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: TaskActionInput) =>
      withToolErrors(async () => {
        const current = await client.startTask(input.taskId);
        const task = await client.getTask(input.taskId);
        return { currentTaskId: current.currentTaskId, task: summarizeTask(task) };
      }, logger),
  );

  server.registerTool(
    'stop_timer',
    {
      title: 'Stop the current timer',
      description: 'Stop the Super Productivity timer without selecting or changing another task.',
      inputSchema: emptyInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async () =>
      withToolErrors(async () => {
        const result = await client.stopTimer();
        return { currentTaskId: result.currentTaskId, stopped: true };
      }, logger),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete one task',
      description: 'Mark exactly the supplied task ID as completed.',
      inputSchema: taskActionInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: TaskActionInput) =>
      withToolErrors(async () => {
        const task = await client.updateTask(input.taskId, { isDone: true });
        return { completed: true, task: summarizeTask(task) };
      }, logger),
  );

  server.registerTool(
    'archive_task',
    {
      title: 'Archive one task',
      description:
        'Move exactly the supplied task ID to the archive. This can include its subtasks.',
      inputSchema: taskActionInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: TaskActionInput) =>
      withToolErrors(async () => {
        await client.archiveTask(input.taskId);
        const archivedTasks = await client.listTasks({ source: 'archived', includeDone: true });
        const task = archivedTasks.find((item) => item.id === input.taskId);
        if (!task) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'The task was not found in the archive after the archive request. Check task state before retrying.',
          );
        }
        return { archived: true, task };
      }, logger),
  );

  server.registerTool(
    'restore_task',
    {
      title: 'Restore one archived task',
      description: 'Restore exactly the supplied archived task ID, including archived subtasks.',
      inputSchema: taskActionInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: TaskActionInput) =>
      withToolErrors(async () => ({ task: await client.restoreTask(input.taskId) }), logger),
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Permanently delete one task',
      description:
        'Permanently delete exactly the supplied task ID. The app also removes its subtasks. This cannot be undone; archive_task is safer when you only want to hide a task.',
      inputSchema: taskActionInputSchema,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (input: TaskActionInput) =>
      withToolErrors(async () => {
        const result = await client.deleteTask(input.taskId);
        const remainingTasks = await client.listTasks({ source: 'all', includeDone: true });
        if (remainingTasks.some((task) => task.id === input.taskId)) {
          throw new AppError(
            'SP_WRITE_NOT_CONFIRMED',
            'The task still appears in Super Productivity after deletion. Read its state before retrying.',
          );
        }
        return result;
      }, logger),
  );

  server.registerTool(
    'get_current_task',
    {
      title: 'Get the current task',
      description: 'Return the task currently being tracked, or null when the timer is stopped.',
      inputSchema: emptyInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      withToolErrors(async () => {
        const task = await client.getCurrentTask();
        return { task: task ? summarizeTask(task) : null };
      }, logger),
  );

  server.registerTool(
    'ensure_github_issue_task',
    {
      title: 'Ensure one task for a GitHub issue',
      description:
        'Find an existing native or Super Productivity MCP-marked task for owner/repo#number or a GitHub issue URL. Create at most one marked task if missing; it is not planned for Today unless planToday=true.',
      inputSchema: ensureGithubIssueInputSchema,
      annotations: STATE_CHANGE_ANNOTATIONS,
    },
    async (input: EnsureGithubIssueInput) =>
      withToolErrors(async () => {
        const issue = parseGithubIssueRef(input.issue);
        const tasks = await client.listTasks({ source: 'all', includeDone: true });
        const match = findGithubIssueTask(tasks, issue);
        let task: SpTask;
        let created = false;
        let matchKind: string;

        if (match) {
          task = match.task;
          matchKind = match.kind;
        } else {
          task = await client.createTask({
            title: input.title ?? `GitHub #${issue.number} — ${issue.owner}/${issue.repo}`,
            notes: addGithubMarker(input.notes, issue),
            ...(input.projectId ? { projectId: input.projectId } : {}),
          });
          created = true;
          matchKind = 'created-marker';
        }

        if (input.planToday) {
          task = await client.updateTask(task.id, {
            dueDay: todayDateString(),
            dueWithTime: null,
          });
        }

        return {
          created,
          matchKind,
          plannedForToday: input.planToday,
          issue: {
            owner: issue.owner,
            repo: issue.repo,
            number: issue.number,
            key: issue.key,
            url: issue.canonicalUrl,
          },
          task: summarizeTask(task),
        };
      }, logger),
  );

  return server;
};

export const startStdioServer = (dependencies: ServerDependencies): void => {
  // Importing here keeps the server factory usable in in-memory tests without
  // starting a process-level transport as a module side effect.
  void import('@modelcontextprotocol/server/stdio').then(({ serveStdio }) => {
    serveStdio(() => createMcpServer(dependencies), {
      onerror: (error) =>
        dependencies.logger.error('MCP stdio transport error', { message: error.message }),
    });
  });
};
