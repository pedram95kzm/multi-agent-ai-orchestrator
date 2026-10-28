import {
  ipcMain,
  clipboard,
  dialog,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { now, type Orchestrator } from "../../../packages/orchestration/core";
import type { Terminal } from "../../../packages/orchestration/terminal";
import { actionSchema, type Action } from "../../../packages/shared/actions";
import type { ActionResult } from "../../../packages/shared/ipc";
import type { Snapshot } from "../../../packages/shared/types";
import type { ChatConnections } from "./chrome/ChatConnections";
import type { InstructionFiles } from "./InstructionFiles";
import { terminalShell } from "../../../packages/orchestration/terminal";

interface Services {
  core: Orchestrator;
  terminal: Terminal;
  connections: ChatConnections;
  instructions: InstructionFiles;
  dataPath: string;
  extensionPath: string;
  getWindow: () => BrowserWindow | undefined;
  snapshot: () => Snapshot;
  log: (event: string, detail?: unknown) => void;
}
function trusted(event: IpcMainInvokeEvent, win?: BrowserWindow) {
  return (
    !!win &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame
  );
}
export function registerIPC(services: Services) {
  const { getWindow, snapshot, log } = services;
  ipcMain.handle("relay:copy", (event, content: unknown) => {
    if (!trusted(event, getWindow()))
      throw new Error("Untrusted clipboard sender.");
    if (typeof content !== "string" || content.length > 8_000_000)
      throw new Error("Invalid clipboard text.");
    clipboard.writeText(content);
  });
  ipcMain.handle("relay:action", async (event, raw): Promise<ActionResult> => {
    if (!trusted(event, getWindow())) throw new Error("Untrusted IPC sender.");
    try {
      const action = actionSchema.parse(raw);
      if (action.type !== "snapshot")
        log("operator-action", { type: action.type });
      await dispatchAction(action, services);
      return { ok: true, data: snapshot() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("action-error", message);
      return { ok: false, error: message };
    }
  });
}
async function dispatchAction(action: Action, services: Services) {
  const {
    core,
    terminal,
    connections,
    instructions,
    dataPath,
    extensionPath,
    getWindow,
  } = services;
  switch (action.type) {
    case "snapshot":
      break;
    case "send": {
      const message = core.send(
        action.agentId,
        action.content,
        action.sourceId,
        action.kind,
        { replyToId: action.replyToId },
      );
      if (message.status === "failed") throw new Error(message.error);
      break;
    }
    case "connectChat":
      await connections.connectChat(action.taskId, action.role, action.url);
      break;
    case "openChat":
      await connections.bridge.request({
        type: "focus",
        agentId: action.agentId,
      });
      break;
    case "disconnectChat":
      core.remove(action.agentId);
      await connections.discardConnection(action.agentId);
      break;
    case "openExtensionFolder": {
      const error = await shell.openPath(extensionPath);
      if (error) throw new Error(error);
      break;
    }
    case "handover":
      core.handover(action.taskId, action.targetRole);
      break;
    case "task": {
      const task = {
        id: randomBytes(8).toString("hex"),
        kind: action.kind,
        title: action.title.trim(),
        operatingSystem: action.operatingSystem,
        created: now(),
      };
      if (!task.title) throw new Error("Enter a task title.");
      core.state.tasks.push(task);
      core.state.activeTaskId = task.id;
      connections.selectedTaskId = task.id;
      core.changed();
      break;
    }
    case "activateTask": {
      if (!core.state.tasks.some((task) => task.id === action.taskId))
        throw new Error("Unknown task.");
      core.state.activeTaskId = action.taskId;
      connections.selectedTaskId = action.taskId;
      core.changed();
      void connections.connectSelectedTask();
      break;
    }
    case "removeTask": {
      const agents = core.state.agents.filter(
        (agent) => agent.taskId === action.taskId,
      );
      core.removeTask(action.taskId);
      for (const agent of agents) await connections.discardConnection(agent.id);
      if (connections.selectedTaskId === action.taskId)
        connections.selectedTaskId = undefined;
      break;
    }
    case "settings": {
      terminalShell(action.settings.shell);
      if (terminal.active)
        throw new Error(
          "Finish the active terminal run before changing settings.",
        );
      core.state.settings = action.settings;
      core.changed();
      break;
    }
    case "instructions":
      await instructions.handle(action, getWindow()!);
      break;
    case "run":
      terminal.execute(action.batchId, action.approved);
      break;
    case "rejectBatch": {
      const batch = core.state.batches.find(
        (batch) => batch.id === action.batchId,
      );
      if (!batch || ["running", "executed"].includes(batch.state))
        throw new Error("Only a batch that has not started can be rejected.");
      batch.state = "rejected";
      core.changed();
      break;
    }
    case "cancelRun":
      terminal.cancel(action.runId);
      break;
    case "returnRun": {
      const run = core.state.runs.find((run) => run.id === action.runId);
      if (!run) throw new Error("Unknown run.");
      core.returnRun(run);
      break;
    }
    case "retry":
      core.retry(action.messageId);
      break;
    case "recheckReview":
      core.recheckReview(action.messageId);
      break;
    case "refreshCapturedCode":
      await connections.refreshCapturedCode(action.messageId);
      break;
    case "confirmSubmission":
      core.delivery(action.messageId, "submitted");
      break;
    case "export": {
      const file = await dialog.showSaveDialog(getWindow()!, {
        defaultPath: "relay-history.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (file.filePath)
        writeFileSync(
          file.filePath,
          JSON.stringify(core.state, null, 2),
          "utf8",
        );
      break;
    }
    case "openFolder": {
      const error = await shell.openPath(dataPath);
      if (error) throw new Error(error);
      break;
    }
  }
}
