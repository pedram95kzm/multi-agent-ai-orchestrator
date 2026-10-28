import { app, dialog, type BrowserWindow } from "electron";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../../packages/orchestration/store";
import { Orchestrator, now } from "../../../packages/orchestration/core";
import { initialState } from "../../../packages/orchestration/initial-state";
import { migrateTaskChats } from "../../../packages/orchestration/migrate";
import { Terminal } from "../../../packages/orchestration/terminal";
import type { Snapshot } from "../../../packages/shared/types";
import { BRIDGE_PORT } from "../../../packages/chrome-connection/protocol";
import { connectionToken } from "./chrome/extension-bridge";
import { ChatConnections } from "./chrome/ChatConnections";
import { InstructionFiles } from "./InstructionFiles";
import { registerIPC } from "./ipc";
import { createWindow } from "./window";
let win: BrowserWindow | undefined;
let core: Orchestrator;
let store: Store;
let terminal: Terminal;
let connections: ChatConnections;
let instructions: InstructionFiles;
let bridgePort = BRIDGE_PORT;
let bridgeError: string | undefined;
let token = "";
if (process.env.RELAY_TEST_DATA)
  app.setPath("userData", resolve(process.env.RELAY_TEST_DATA));
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
app.on("second-instance", () => {
  win?.show();
  win?.focus();
});
const dev = !app.isPackaged && process.env.RELAY_DEV === "1";
const resources = app.isPackaged ? process.resourcesPath : app.getAppPath();
const dataPath = app.getPath("userData");
const logsPath = join(dataPath, "logs");
const extensionPath = join(dataPath, "chrome-extension");
function log(event: string, detail?: unknown) {
  try {
    appendFileSync(
      join(logsPath, "events.ndjson"),
      JSON.stringify({ time: now(), event, detail }) + "\n",
      "utf8",
    );
  } catch {
    /* Logging must not replay an external action. */
  }
}
function snapshot(): Snapshot {
  return {
    ...core.state,
    chrome: {
      connected: connections?.bridge.connected ?? false,
      token,
      port: bridgePort,
      error: bridgeError,
      extensionPath,
    },
  };
}
function notify() {
  if (win && !win.isDestroyed())
    win.webContents.send("relay:state", snapshot());
}
app
  .whenReady()
  .then(async () => {
    mkdirSync(logsPath, { recursive: true });
    const sourceExtension = app.isPackaged
      ? join(resources, "chrome-extension")
      : join(resources, "dist", "chrome-extension");
    cpSync(sourceExtension, extensionPath, { recursive: true });
    const tokenPath = join(dataPath, "chrome-token");
    token = connectionToken(
      existsSync(tokenPath) ? readFileSync(tokenPath, "utf8") : undefined,
    );
    writeFileSync(tokenPath, token, "utf8");
    store = new Store(join(dataPath, "relay.sqlite"));
    const editable = join(dataPath, "agent.md");
    if (!existsSync(editable))
      writeFileSync(editable, readFileSync(join(resources, "agent.md")));
    const saved = store.load();
    if (saved && saved.version !== 1)
      throw new Error(
        "Unsupported database version. Restore a compatible backup.",
      );
    if (saved) {
      delete (saved.settings as unknown as Record<string, unknown>).bridgePort;
      delete (saved.settings as unknown as Record<string, unknown>).extensionId;
      migrateTaskChats(saved);
    }
    const shellPath =
      [
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        "/bin/bash",
      ].find(existsSync) ?? "";
    core = new Orchestrator(
      saved ??
        initialState(editable, readFileSync(editable, "utf8"), shellPath),
      (state) => store.save(state),
    );
    core.onChange = notify;
    core.recover();
    instructions = new InstructionFiles(core, store);
    instructions.upgradeDefault(
      readFileSync(join(resources, "agent.md"), "utf8"),
    );
    instructions.verify();
    terminal = new Terminal(core, logsPath);
    connections = new ChatConnections(core, token);
    try {
      bridgePort = await connections.bridge.listen(
        process.env.RELAY_TEST_DATA ? 0 : BRIDGE_PORT,
      );
    } catch (error) {
      bridgeError = `Chrome connection could not start: ${String(error)}`;
      log("chrome-bridge-error", bridgeError);
    }
    instructions.observe();
    registerIPC({
      core,
      terminal,
      connections,
      instructions,
      dataPath,
      extensionPath,
      getWindow: () => win,
      snapshot,
      log,
    });
    win = createWindow(dev, log);
  })
  .catch((error) => {
    dialog.showErrorBox(
      "Relay could not start",
      `${error.message}\nData was preserved at ${dataPath}.`,
    );
    app.quit();
  });
app.on("before-quit", () => {
  if (terminal?.active) terminal.cancel(terminal.active.run.id);
  instructions?.close();
  void connections?.bridge.close();
});
app.on("window-all-closed", () => app.quit());
