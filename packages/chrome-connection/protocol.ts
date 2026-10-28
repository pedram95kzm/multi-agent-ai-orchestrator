import { z } from "zod";

import { tokenPattern } from "./constants";
export { BRIDGE_PORT, EXTENSION_ID, tokenPattern } from "./constants";
const url = z.string().url().max(2048);
const id = z.string().min(1).max(200);
export const extensionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string().regex(tokenPattern) }),
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("result"),
    id,
    ok: z.boolean(),
    error: z.string().max(4000).optional(),
    data: z
      .object({
        ready: z.boolean().optional(),
        url: url.optional(),
        lastNumber: z.number().int().nonnegative().optional(),
        lastRole: z.enum(["actor", "watcher", "setup"]).optional(),
        response: z.string().max(2_000_000).optional(),
        status: z.enum(["submitted", "failed", "uncertain"]).optional(),
        error: z.string().max(4000).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("response"),
    agentId: id,
    taskId: id,
    deliveryId: id,
    content: z.string().min(1).max(2_000_000),
    sourceId: id,
    url,
  }),
  z.object({
    type: z.literal("status"),
    agentId: id,
    ready: z.boolean(),
    error: z.string().max(4000).optional(),
    url: url.optional(),
  }),
]);
export type ExtensionEvent = z.infer<typeof extensionEventSchema>;
export type BridgeResult = Extract<ExtensionEvent, { type: "result" }>["data"];
export interface ChatBinding {
  agentId: string;
  taskId: string;
  url: string;
  role: "actor" | "watcher";
  lastNumber: number;
  resumeDeliveryId?: string;
  activeAgentIds?: string[];
}
export type BridgeCommand =
  | ({ type: "connect" } & ChatBinding)
  | {
      type: "send";
      agentId: string;
      deliveryId: string;
      content: string;
      expectedNumber?: number;
    }
  | { type: "focus"; agentId: string }
  | { type: "disconnect"; agentId: string };
