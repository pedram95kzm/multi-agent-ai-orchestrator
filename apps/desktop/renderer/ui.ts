import type { Action } from "../../../packages/shared/actions";
export type Perform = (action: Action) => Promise<boolean>;
export const copy = (value: string) =>
  window.relay?.copy
    ? window.relay.copy(value)
    : navigator.clipboard.writeText(value);
export const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
