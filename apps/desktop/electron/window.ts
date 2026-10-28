import { BrowserWindow } from "electron";
import { join } from "node:path";
export function createWindow(
  dev: boolean,
  log: (event: string, detail?: unknown) => void,
) {
  const win = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1000,
    minHeight: 720,
    backgroundColor: "#101416",
    title: "Relay Orchestrator",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("render-process-gone", (_event, details) =>
    log("renderer-process-gone", details),
  );
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  if (dev) void win.loadURL("http://127.0.0.1:5173");
  else void win.loadFile(join(__dirname, "../desktop/index.html"));
  return win;
}
