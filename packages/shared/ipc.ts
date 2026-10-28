import type { Action } from "./actions";
import type { Snapshot } from "./types";
export interface ActionResult {
  ok: boolean;
  data?: Snapshot;
  error?: string;
}
export interface RelayAPI {
  copy?: (content: string) => Promise<void>;
  invoke: (action: Action) => Promise<ActionResult>;
  subscribe: (listener: (state: Snapshot) => void) => () => void;
}
