import { z } from "zod";
const roleSchema = z.enum(["actor", "watcher"]);
const text = z.string().min(1).max(2_000_000);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }),
  z.object({
    type: z.literal("send"),
    agentId: text,
    content: text,
    sourceId: text.optional(),
    replyToId: text.optional(),
    kind: z.enum(["operator", "terminal"]).optional(),
  }),
  z.object({
    type: z.literal("connectChat"),
    taskId: text,
    role: roleSchema,
    url: z.string().url().max(2048),
  }),
  z.object({ type: z.literal("openChat"), agentId: text }),
  z.object({ type: z.literal("disconnectChat"), agentId: text }),
  z.object({ type: z.literal("openExtensionFolder") }),
  z.object({
    type: z.literal("handover"),
    taskId: text,
    targetRole: roleSchema.optional(),
  }),
  z.object({
    type: z.literal("task"),
    kind: text,
    title: text,
    operatingSystem: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({ type: z.literal("activateTask"), taskId: text }),
  z.object({ type: z.literal("removeTask"), taskId: text }),
  z.object({
    type: z.literal("settings"),
    settings: z.object({
      shell: text,
      timeoutMs: z.number().int().min(1000).max(600000),
    }),
  }),
  z.object({
    type: z.literal("instructions"),
    operation: z.enum(["open", "reload", "save", "choose"]),
    content: z.string().optional(),
  }),
  z.object({ type: z.literal("run"), batchId: text, approved: z.boolean() }),
  z.object({ type: z.literal("rejectBatch"), batchId: text }),
  z.object({ type: z.literal("cancelRun"), runId: text }),
  z.object({ type: z.literal("returnRun"), runId: text }),
  z.object({ type: z.literal("retry"), messageId: text }),
  z.object({ type: z.literal("recheckReview"), messageId: text }),
  z.object({ type: z.literal("refreshCapturedCode"), messageId: text }),
  z.object({ type: z.literal("confirmSubmission"), messageId: text }),
  z.object({ type: z.literal("export") }),
  z.object({
    type: z.literal("openFolder"),
    folder: z.literal("data"),
  }),
]);
export type Action = z.infer<typeof actionSchema>;
