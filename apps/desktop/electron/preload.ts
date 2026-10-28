import { contextBridge, ipcRenderer } from "electron";
import type { RelayAPI } from "../../../packages/shared/ipc";
import type { Snapshot } from "../../../packages/shared/types";

const relay: RelayAPI = {
  copy: (content: string) => ipcRenderer.invoke("relay:copy", content),
  invoke: (action) => ipcRenderer.invoke("relay:action", action),
  subscribe: (listener) => {
    const handle = (_event: unknown, state: Snapshot) => listener(state);
    ipcRenderer.on("relay:state", handle);
    return () => ipcRenderer.removeListener("relay:state", handle);
  },
};

contextBridge.exposeInMainWorld("relay", relay);
