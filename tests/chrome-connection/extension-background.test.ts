import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { BridgeCommand } from "../../packages/chrome-connection/protocol";

type Reply = {
  type: string;
  id?: string;
  ok?: boolean;
  data?: { ready?: boolean };
  error?: string;
};
class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Reply[] = [];
  onopen?: () => void;
  onclose?: (event: { reason: string }) => void;
  onmessage?: (event: { data: string }) => void | Promise<void>;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = Socket.CLOSED;
    this.onclose?.({ reason: "" });
  }
  async welcome() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
    await this.receive({ type: "welcome" });
  }
  async receive(command: object) {
    await this.onmessage?.({ data: JSON.stringify(command) });
  }
  async request(id: string, command: BridgeCommand) {
    await this.receive({ id, ...command });
    return this.sent.find(
      (reply) => reply.type === "result" && reply.id === id,
    );
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const url = "https://chat.deepseek.com/a/chat/s/current";
const tab = { id: 10, url, active: true };
const binding = (agentId: string, taskId = "task") => ({
  agentId,
  taskId,
  role: "watcher" as const,
  url,
  lastNumber: 3,
});
let local: { token: string; bridgePort: number };
let session: Record<string, unknown>;
let runtimeMessage: (
  message: { type: string; token?: string },
  sender: object,
  reply: (value: unknown) => void,
) => unknown;
const query = vi.fn(async () => [tab]);
const sessionGet = vi.fn(async () => structuredClone(session));
const sessionSet = vi.fn(async (data: object) => {
  Object.assign(session, structuredClone(data));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  Socket.instances = [];
  local = { token: "a".repeat(64), bridgePort: 19432 };
  session = {};
  session.pairingKey = createHash("sha256")
    .update(`${local.bridgePort}:${local.token}`)
    .digest("hex");
  query.mockReset().mockResolvedValue([tab]);
  sessionGet
    .mockReset()
    .mockImplementation(async () => structuredClone(session));
  sessionSet.mockClear();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...local })),
        set: vi.fn(async (data: object) => {
          Object.assign(local, data);
        }),
      },
      session: { get: sessionGet, set: sessionSet },
    },
    tabs: {
      query,
      create: vi.fn(async () => tab),
      get: vi.fn(async () => tab),
      update: vi.fn(async () => tab),
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [
        {
          frameId: 0,
          result: {
            ready: true,
            composerFound: true,
            lastNumber: 3,
            lastRole: "watcher",
            turnCount: 1,
          },
        },
      ]),
    },
    runtime: {
      onMessage: {
        addListener: (listener: typeof runtimeMessage) => {
          runtimeMessage = listener;
        },
      },
      onStartup: { addListener: vi.fn() },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function start() {
  await import("../../apps/chrome-extension/background");
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const client = Socket.instances[0];
  await client.welcome();
  return client;
}
const pair = (token = local.token) =>
  new Promise((resolve) => {
    runtimeMessage({ type: "pair", token }, {}, resolve);
  });

it("releases cached tab ownership when pairing with a different Relay token", async () => {
  session.chats = [
    { ...binding("old-agent", "old-task"), tabId: tab.id, ready: true },
  ];
  await start();
  await pair("b".repeat(64));
  const client = Socket.instances.at(-1)!;
  await client.welcome();
  const result = await client.request("new", {
    type: "connect",
    ...binding("new-agent", "new-task"),
  });
  expect(result).toMatchObject({ ok: true, data: { ready: true } });
  expect(session.chats).toEqual([
    expect.objectContaining({
      agentId: "new-agent",
      taskId: "new-task",
      tabId: tab.id,
    }),
  ]);
  expect(client.sent.some((message) => message.type === "response")).toBe(
    false,
  );
});

it("does not revive a binding whose connection was cancelled while tab lookup was running", async () => {
  const client = await start();
  const lookup = deferred<(typeof tab)[]>();
  query.mockReturnValueOnce(lookup.promise);
  const old = client.request("old-connect", {
    type: "connect",
    ...binding("old-agent"),
  });
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  await client.request("remove", { type: "disconnect", agentId: "old-agent" });
  lookup.resolve([tab]);
  await old;
  const result = await client.request("new-connect", {
    type: "connect",
    ...binding("new-agent"),
  });
  expect(result).toMatchObject({ ok: true, data: { ready: true } });
  expect(session.chats).toEqual([
    expect.objectContaining({ agentId: "new-agent" }),
  ]);
});

it("preserves pending deliveries when the same Relay token is pasted again", async () => {
  const pending = {
    deliveryId: "already-sent",
    turnCount: 1,
    baselineNumber: 3,
    expectedNumber: 4,
  };
  session.chats = [
    { ...binding("current"), tabId: tab.id, ready: true, pending },
  ];
  await start();
  await pair();
  const client = Socket.instances.at(-1)!;
  await client.welcome();
  expect(
    await client.request("resume", {
      type: "connect",
      ...binding("current"),
      resumeDeliveryId: pending.deliveryId,
    }),
  ).toMatchObject({ ok: true, data: { ready: true } });
  expect(session.chats).toEqual([
    expect.objectContaining({ agentId: "current", pending }),
  ]);
  expect(query).not.toHaveBeenCalled();
});

it("continues to reject a tab genuinely assigned to another task", async () => {
  const client = await start();
  expect(
    await client.request("first", {
      type: "connect",
      ...binding("first", "first-task"),
    }),
  ).toMatchObject({ ok: true });
  expect(
    await client.request("second", {
      type: "connect",
      ...binding("second", "second-task"),
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("another task or role"),
  });
});

it("allows a new task's different URL in a tab that was used for an older chat", async () => {
  const client = await start();
  expect(
    await client.request("old", {
      type: "connect",
      ...binding("old-agent", "old-task"),
    }),
  ).toMatchObject({ ok: true });
  const newURL = "https://chat.deepseek.com/a/chat/s/new-project";
  query.mockResolvedValue([{ ...tab, url: newURL }]);
  const result = await client.request("new", {
    type: "connect",
    ...binding("new-agent", "new-task"),
    url: newURL,
  });
  expect(result).toMatchObject({ ok: true, data: { ready: true } });
  expect(session.chats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agentId: "old-agent", url, ready: false }),
      expect.objectContaining({
        agentId: "new-agent",
        url: newURL,
        tabId: tab.id,
      }),
    ]),
  );
});

it("keeps detached pending evidence and rebinds the original chat without submitting again", async () => {
  const pending = {
    deliveryId: "sent-before-navigation",
    turnCount: 1,
    expectedNumber: 4,
    baseline: "Original answer.",
  };
  session.chats = [
    {
      ...binding("old-agent", "old-task"),
      tabId: tab.id,
      ready: true,
      pending,
    },
  ];
  const client = await start();
  const newURL = "https://chat.deepseek.com/a/chat/s/another-project";
  query.mockResolvedValueOnce([{ ...tab, url: newURL }]);
  expect(
    await client.request("new", {
      type: "connect",
      ...binding("new-agent", "new-task"),
      url: newURL,
    }),
  ).toMatchObject({ ok: true });
  expect(session.chats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        agentId: "old-agent",
        tabId: undefined,
        ready: false,
        pending,
      }),
    ]),
  );
  query.mockResolvedValueOnce([{ ...tab, id: 11 }]);
  expect(
    await client.request("restore-old", {
      type: "connect",
      ...binding("old-agent", "old-task"),
      resumeDeliveryId: pending.deliveryId,
    }),
  ).toMatchObject({ ok: true });
  expect(session.chats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agentId: "old-agent", tabId: 11, pending }),
    ]),
  );
  expect(chrome.scripting.executeScript).not.toHaveBeenCalledWith(
    expect.objectContaining({
      args: [expect.objectContaining({ mode: "submit" })],
    }),
  );
});

it("removes orphaned cache bindings using the desktop's complete active assignments", async () => {
  session.chats = [
    { ...binding("deleted-agent", "deleted-task"), tabId: tab.id, ready: true },
  ];
  const client = await start();
  const command = {
    type: "connect" as const,
    ...binding("current"),
    activeAgentIds: ["current"],
  };
  expect(await client.request("new", command)).toMatchObject({ ok: true });
  expect(session.chats).toEqual([
    expect.objectContaining({ agentId: "current" }),
  ]);
});

it("does not release another active task's binding during synchronization", async () => {
  session.chats = [
    { ...binding("other-agent", "other-task"), tabId: tab.id, ready: true },
  ];
  const client = await start();
  expect(
    await client.request("new", {
      type: "connect",
      ...binding("current"),
      activeAgentIds: ["current", "other-agent"],
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("another task or role"),
  });
});

it("rebuilds legacy unscoped caches instead of inheriting an old task's tab ownership", async () => {
  delete session.pairingKey;
  session.chats = [
    { ...binding("old-agent", "old-task"), tabId: tab.id, ready: true },
  ];
  const client = await start();
  expect(
    await client.request("new", { type: "connect", ...binding("current") }),
  ).toMatchObject({ ok: true });
});

it("deduplicates concurrent connections for the same assignment", async () => {
  const client = await start();
  const lookup = deferred<(typeof tab)[]>();
  query.mockReturnValueOnce(lookup.promise);
  const first = client.request("first", {
    type: "connect",
    ...binding("current"),
  });
  const second = client.request("second", {
    type: "connect",
    ...binding("current"),
  });
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  lookup.resolve([tab]);
  expect(await first).toMatchObject({ ok: true });
  expect(await second).toMatchObject({ ok: true });
  expect(query).toHaveBeenCalledOnce();
});

it("waits for restored session data before applying a new token", async () => {
  const loaded = deferred<Record<string, unknown>>();
  sessionGet.mockReturnValueOnce(loaded.promise);
  await import("../../apps/chrome-extension/background");
  const change = pair("b".repeat(64));
  loaded.resolve({
    ...session,
    chats: [{ ...binding("old-agent"), tabId: tab.id, ready: true }],
  });
  await change;
  expect(Socket.instances).toHaveLength(1);
  const client = Socket.instances[0];
  await client.welcome();
  expect(
    await client.request("new", { type: "connect", ...binding("new-agent") }),
  ).toMatchObject({ ok: true });
});
