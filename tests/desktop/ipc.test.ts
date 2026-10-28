import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerIPC } from "../../apps/desktop/electron/ipc";
import { ChatConnections } from "../../apps/desktop/electron/chrome/ChatConnections";
import { InstructionFiles } from "../../apps/desktop/electron/InstructionFiles";
import { Store } from "../../packages/orchestration/store";
import { Terminal } from "../../packages/orchestration/terminal";
import type { ActionResult } from "../../packages/shared/ipc";
import { makeCore } from "../helpers";

const { handle, writeText } = vi.hoisted(() => ({
  handle:
    vi.fn<
      (
        channel: string,
        callback: (event: IpcMainInvokeEvent, value?: unknown) => unknown,
      ) => void
    >(),
  writeText: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle },
  clipboard: { writeText },
  dialog: {},
  shell: {},
}));

let store: Store;
beforeEach(() => vi.clearAllMocks());
afterEach(() => store?.close());

function desktop() {
  const core = makeCore();
  store = new Store(":memory:");
  const win = { webContents: { mainFrame: {} } } as BrowserWindow;
  const event = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  } as IpcMainInvokeEvent;
  const connections = new ChatConnections(core, "a".repeat(64));
  const log = vi.fn();
  registerIPC({
    core,
    terminal: new Terminal(core, "unused-logs"),
    connections,
    instructions: new InstructionFiles(core, store),
    getWindow: () => win,
    snapshot: () => core.state,
    log,
    dataPath: "unused-data",
    extensionPath: "unused-extension",
  });
  const action = handle.mock.calls.find(
    ([channel]) => channel === "relay:action",
  )![1] as (event: IpcMainInvokeEvent, value: unknown) => Promise<ActionResult>;
  const copy = handle.mock.calls.find(
    ([channel]) => channel === "relay:copy",
  )![1];
  return { core, event, connections, action, copy, log };
}

it("accepts snapshots only from the main renderer frame", async () => {
  const { action, event, core, log } = desktop();
  expect(await action(event, { type: "snapshot" })).toEqual({
    ok: true,
    data: core.state,
  });
  expect(log).not.toHaveBeenCalled();
  await expect(
    action({ ...event, senderFrame: {} } as IpcMainInvokeEvent, {
      type: "snapshot",
    }),
  ).rejects.toThrow("Untrusted IPC sender");
  await expect(
    action({ ...event, sender: {} } as IpcMainInvokeEvent, {
      type: "snapshot",
    }),
  ).rejects.toThrow("Untrusted IPC sender");
});

it("dispatches recorded-review rechecks through the validated action channel", async () => {
  const { action, event, core } = desktop();
  const recheck = vi.spyOn(core, "recheckReview").mockImplementation(() => {
    throw new Error("A matching recorded correction is required.");
  });
  expect(
    await action(event, {
      type: "recheckReview",
      messageId: "recorded-review",
    }),
  ).toMatchObject({
    ok: false,
    error: "A matching recorded correction is required.",
  });
  expect(recheck).toHaveBeenCalledExactlyOnceWith("recorded-review");
});

it("dispatches code refreshes to read-only chat inspection, without exposing capture text in IPC", async () => {
  const { action, event, connections } = desktop();
  const refresh = vi
    .spyOn(connections, "refreshCapturedCode")
    .mockResolvedValue();
  expect(
    (
      await action(event, {
        type: "refreshCapturedCode",
        messageId: "saved-review",
      })
    ).ok,
  ).toBe(true);
  expect(refresh).toHaveBeenCalledExactlyOnceWith("saved-review");
});

it.each([
  null,
  { type: "unknown" },
  { type: "run" },
  { type: "removeExecution", batchId: "" },
])("rejects invalid actions before dispatch: %j", async (raw) => {
  const { action, event, core } = desktop();
  const before = structuredClone(core.state);
  expect((await action(event, raw)).ok).toBe(false);
  expect(core.state).toEqual(before);
});

it("keeps selected-task routing in sync with task creation, activation, and deletion", async () => {
  const { action, event, core, connections } = desktop();
  const reconnect = vi
    .spyOn(connections, "connectSelectedTask")
    .mockResolvedValue();
  const created = await action(event, {
    type: "task",
    kind: "feature",
    title: "  Task  ",
    operatingSystem: "Windows",
  });
  const taskId = created.data!.activeTaskId!;
  expect(connections.selectedTaskId).toBe(taskId);
  expect(core.state.tasks[0].title).toBe("Task");
  expect(core.state.tasks[0].operatingSystem).toBe("Windows");
  await action(event, { type: "activateTask", taskId });
  expect(reconnect).toHaveBeenCalledOnce();
  await action(event, { type: "removeTask", taskId });
  expect(core.state.tasks).toEqual([]);
  expect(connections.selectedTaskId).toBeUndefined();
});

it("validates clipboard text and rejects clipboard access from subframes", () => {
  const { copy, event } = desktop();
  copy(event, "clear\npwd\n");
  expect(writeText).toHaveBeenCalledExactlyOnceWith("clear\npwd\n");
  expect(() => copy(event, { text: "invalid" })).toThrow(
    "Invalid clipboard text",
  );
  expect(() => copy(event, "x".repeat(8_000_001))).toThrow(
    "Invalid clipboard text",
  );
  expect(() =>
    copy({ ...event, senderFrame: {} } as IpcMainInvokeEvent, "blocked"),
  ).toThrow("Untrusted clipboard sender");
  expect(writeText).toHaveBeenCalledOnce();
});
