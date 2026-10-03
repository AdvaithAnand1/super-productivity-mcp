import { z } from 'zod/v4';

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().finite().nullable().optional();

/**
 * The local REST API deliberately returns the complete Super Productivity task
 * object. We validate the stable fields we consume and preserve unknown fields
 * so a newer Super Productivity release does not break this server.
 */
export const SpTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    isDone: z.boolean().optional(),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .nullable()
      .optional(),
    projectId: nullableString,
    tagIds: z.array(z.string()).optional(),
    notes: nullableString,
    dueDay: nullableString,
    dueWithTime: nullableNumber,
    deadlineDay: nullableString,
    deadlineWithTime: nullableNumber,
    deadlineRemindAt: nullableNumber,
    timeEstimate: z.number().finite().optional(),
    timeSpent: z.number().finite().optional(),
    parentId: nullableString,
    subTaskIds: z.array(z.string()).optional(),
    issueId: z.union([z.string(), z.number()]).nullable().optional(),
    issueType: nullableString,
    issueProviderId: nullableString,
  })
  .passthrough();

export type SpTask = z.infer<typeof SpTaskSchema>;

export const SpTaskAttachmentSchema = z
  .object({
    id: z.string().nullable(),
    path: z.string().optional(),
    type: z.enum(['FILE', 'LINK', 'IMG', 'COMMAND', 'NOTE']),
    title: z.string().optional(),
    icon: z.string().optional(),
    originalImgPath: z.string().optional(),
  })
  .passthrough();
export type SpTaskAttachment = z.infer<typeof SpTaskAttachmentSchema>;

export const SpTaskLinkAttachmentResultSchema = z.object({
  task: SpTaskSchema,
  attachment: SpTaskAttachmentSchema,
});
export const SpTaskAttachmentDetachResultSchema = z.object({
  task: SpTaskSchema,
  attachmentId: z.string(),
  detached: z.literal(true),
});

export const SpHierarchyResultSchema = z.object({
  task: SpTaskSchema,
  previousParent: SpTaskSchema.nullable(),
  parent: SpTaskSchema.nullable(),
  siblingIds: z.array(z.string()),
});
export type SpHierarchyResult = z.infer<typeof SpHierarchyResultSchema>;

export const SpOrderResultSchema = z.object({
  taskId: z.string().min(1),
  scope: z.enum(['project', 'backlog', 'tag', 'subtasks']),
  scopeId: z.string().min(1),
  orderedIds: z.array(z.string()),
});
export type SpOrderResult = z.infer<typeof SpOrderResultSchema>;

export const SpTimeAdjustmentResultSchema = z.object({
  task: SpTaskSchema,
  date: z.string(),
  operation: z.enum(['add', 'remove']),
  duration: z.number().int().positive(),
  dayTotal: z.number().finite().nonnegative(),
  total: z.number().finite().nonnegative(),
});
export type SpTimeAdjustmentResult = z.infer<typeof SpTimeAdjustmentResultSchema>;

export const SpTagSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
  })
  .passthrough();

export type SpTag = z.infer<typeof SpTagSchema>;

export const SpProjectSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
  })
  .passthrough();

export type SpProject = z.infer<typeof SpProjectSchema>;

export const SpHealthSchema = z
  .object({
    server: z.string(),
    rendererReady: z.boolean(),
  })
  .passthrough();

export type SpHealth = z.infer<typeof SpHealthSchema>;

export const SpCurrentTaskIdSchema = z.object({
  currentTaskId: z.string().nullable(),
});

export type SpCurrentTaskId = z.infer<typeof SpCurrentTaskIdSchema>;

export const SpErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export type SpError = z.infer<typeof SpErrorSchema>;

export const SpSuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
});

export const SpErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: SpErrorSchema,
});

export const SpEnvelopeSchema = z.union([SpSuccessEnvelopeSchema, SpErrorEnvelopeSchema]);

export type SpEnvelope = z.infer<typeof SpEnvelopeSchema>;
