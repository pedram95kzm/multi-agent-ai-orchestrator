import type { RelayAPI } from "../../../packages/shared/ipc";
declare global {
  interface Window {
    relay: RelayAPI;
  }
}
