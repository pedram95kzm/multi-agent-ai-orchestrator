import { beforeEach, expect, it, vi } from "vitest";
import { ChatConnections } from "../../apps/desktop/electron/chrome/ChatConnections";
import type {
  BridgeCommand,
  BridgeResult,
  ExtensionEvent,
} from "../../packages/chrome-connection/protocol";
import { makeCore, response } from "../helpers";
import { manualHandoverReceipt } from "../../packages/orchestration/handover";
import { needsAgentInstructions } from "../../packages/shared/outgoing";
import { documentationCapture } from "../capture-fixture";

const bridge = vi.hoisted(() => ({
  request: vi.fn<(command: BridgeCommand) => Promise<BridgeResult>>(),
  event: undefined as ((event: ExtensionEvent) => boolean | void) | undefined,
}));
vi.mock("../../apps/desktop/electron/chrome/extension-bridge", () => ({
  ExtensionBridge: class {
    connected = true;
    request = bridge.request;
    constructor(
      _token: string,
      _connection: unknown,
      event: (event: ExtensionEvent) => boolean | void,
    ) {
      bridge.event = event;
    }
  },
}));
beforeEach(() => {
  bridge.request.mockReset();
  bridge.request.mockImplementation(async (command) =>
    command.type === "send"
      ? { status: "submitted" }
      : { ready: true, lastNumber: 0 },
  );
});

it("refreshes the same captured proposal and approval through inspection without sending or consuming another response", async () => {
  const s = documentationCapture();
  bridge.request.mockImplementation(async (command) => {
    expect(command.type).toBe("connect");
    if (command.type !== "connect") throw new Error("Unexpected send.");
    return {
      ready: true,
      url: command.url,
      response: s.captures[command.role],
    };
  });
  const connections = new ChatConnections(s.core, "a".repeat(64));
  await connections.refreshCapturedCode(s.review.id);
  expect(bridge.request).toHaveBeenCalledTimes(2);
  expect(s.core.state.batches[0]).toMatchObject({
    state: "ready",
    command: s.command,
  });
  expect(s.core.state.runs).toEqual([]);
  expect(s.actor.lastNumber).toBe(1);
  expect(s.watcher.lastNumber).toBe(2);
});

it("does not refresh captures returned from a different saved chat URL", async () => {
  const s = documentationCapture();
  bridge.request.mockImplementation(async (command) =>
    command.type === "connect"
      ? {
          ready: true,
          url: "https://example.com/other",
          response: s.captures[command.role],
        }
      : undefined,
  );
  const connections = new ChatConnections(s.core, "a".repeat(64));
  const before = structuredClone(s.core.state);
  await expect(connections.refreshCapturedCode(s.review.id)).rejects.toThrow(
    "saved chat",
  );
  expect(s.core.state).toEqual(before);
});

function setup() {
  const core = makeCore();
  core.state.tasks.push({
    id: "task",
    title: "Current task",
    kind: "feature",
    created: "2026-10-27",
  });
  core.state.activeTaskId = "task";
  const actor = core.connectChat(
    "task",
    "actor",
    "https://chat.deepseek.com/a/chat/s/actor",
  );
  const watcher = core.connectChat(
    "task",
    "watcher",
    "https://chat.deepseek.com/a/chat/s/watcher",
  );
  actor.connected = watcher.connected = true;
  core.delivery(
    core.send(watcher.id, "Start the current task.").id,
    "submitted",
  );
  const briefing = core.receive(
    watcher.id,
    "briefing",
    response(
      1,
      "watcher->actor",
      "Implement the current task, not the old greeting.",
    ),
  );
  return { core, actor, watcher, briefing };
}

it("ignores a stale greeting, role, counter or URL while waiting and accepts only the current Actor reply", async () => {
  const s = setup();
  new ChatConnections(s.core, "a".repeat(64));
  const sent = s.core.send(s.actor.id, s.briefing.content, s.briefing.id);
  await vi.waitFor(() => expect(sent.status).toBe("submitted"));
  expect(bridge.request).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "send",
      content: sent.content,
      expectedNumber: 1,
    }),
  );
  expect(sent.content).toContain(s.core.state.instructions.text);
  expect(sent.originalInput).toBe(s.briefing.content);
  const event = {
    type: "response" as const,
    agentId: s.actor.id,
    taskId: "task",
    deliveryId: sent.id,
    sourceId: "new",
    url: s.actor.conversation,
    content: response(1, "actor->watcher", "Current answer."),
  };
  const count = s.core.state.messages.length;
  for (const changed of [
    { content: "Hi! How can I help you today?" },
    { content: response(1, "watcher->operator") },
    { content: response(2, "actor->watcher") },
    { url: "https://chat.deepseek.com/a/chat/s/another-task" },
  ]) {
    expect(bridge.event!({ ...event, ...changed })).toBe(false);
    expect(s.actor.awaitingResponse).toBe(true);
    expect(s.core.state.messages).toHaveLength(count);
  }
  expect(bridge.event!(event)).not.toBe(false);
  expect(s.actor.awaitingResponse).toBe(false);
  expect(s.actor.lastNumber).toBe(1);
  expect(s.actor.error).toBeUndefined();
  expect(s.core.state.messages.at(-1)?.content).toBe(event.content);
  expect(
    bridge.request.mock.calls.filter(([command]) => command.type === "send"),
  ).toHaveLength(1);
});

it("recovers a greeting captured by an older extension by inspecting the original delivery without resending it", async () => {
  const s = setup();
  const sent = s.core.send(s.actor.id, s.briefing.content, s.briefing.id);
  s.core.delivery(sent.id, "submitted");
  const old = s.core.receive(
    s.actor.id,
    `${sent.id}:old`,
    "Hi! How can I help you today?",
    "task",
    sent.id,
  );
  const connections = new ChatConnections(s.core, "a".repeat(64));
  expect(old.captureRejected).toBe(true);
  expect(s.actor.awaitingResponse).toBe(true);
  expect(() => s.core.send(s.watcher.id, old.content, old.id)).toThrow(
    "not an accepted",
  );
  await connections.connectChat("task", "actor", s.actor.conversation);
  expect(bridge.request).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "connect",
      resumeDeliveryId: sent.id,
      lastNumber: 0,
    }),
  );
  expect(
    bridge.request.mock.calls.filter(([command]) => command.type === "send"),
  ).toHaveLength(0);
  const content = response(
    1,
    "actor->watcher",
    "The actual answer to the current briefing.",
  );
  bridge.event!({
    type: "response",
    agentId: s.actor.id,
    taskId: "task",
    deliveryId: sent.id,
    sourceId: `${sent.id}:actual`,
    url: s.actor.conversation,
    content,
  });
  expect(s.core.state.messages.at(-1)?.content).toBe(content);
  expect(s.actor.lastNumber).toBe(1);
  expect(s.actor.awaitingResponse).toBe(false);
  expect(s.core.state.messages).toContain(old);
  expect(old.content).toBe("Hi! How can I help you today?");
});

it.each(["actor", "watcher"] as const)(
  "adopts the already-visible manual %s acknowledgment without sending a packet",
  async (role) => {
    const s = setup();
    const old = role === "actor" ? s.actor : s.watcher;
    old.lastNumber = 7;
    new ChatConnections(s.core, "a".repeat(64));
    bridge.request.mockResolvedValue({
      ready: true,
      lastNumber: 8,
      lastRole: role,
    });
    const connections = new ChatConnections(s.core, "a".repeat(64));
    await connections.connectChat(
      "task",
      role,
      "https://chatgpt.com/c/manually-prepared",
    );
    const replacement = s.core
      .taskAgents("task")
      .find((agent) => agent.role === role)!;
    expect(replacement.lastNumber).toBe(8);
    expect(replacement.onboarding).toBe("registered");
    expect(replacement.awaitingResponse).not.toBe(true);
    expect(
      bridge.request.mock.calls.filter(([command]) => command.type === "send"),
    ).toHaveLength(0);
  },
);

it("does not adopt a different role's response counter when a new URL is pasted", async () => {
  const s = setup();
  s.actor.lastNumber = 7;
  bridge.request.mockResolvedValue({
    ready: true,
    lastNumber: 20,
    lastRole: "watcher",
  });
  const connections = new ChatConnections(s.core, "a".repeat(64));
  await connections.connectChat(
    "task",
    "actor",
    "https://chatgpt.com/c/wrong-role",
  );
  expect(
    s.core.taskAgents("task").find((agent) => agent.role === "actor")
      ?.lastNumber,
  ).toBe(7);
});

it("does not connect an assignment removed while its previous tab was disconnecting", async () => {
  const s = setup();
  let finishDisconnect!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finishDisconnect = resolve;
  });
  bridge.request.mockImplementation(async (command) => {
    if (command.type === "disconnect" && command.agentId === s.actor.id)
      await delayed;
    return { ready: true, lastNumber: 0 };
  });
  const connections = new ChatConnections(s.core, "a".repeat(64));
  const oldConnect = connections.connectChat(
    "task",
    "actor",
    "https://chatgpt.com/c/intermediate",
  );
  await vi.waitFor(() =>
    expect(bridge.request).toHaveBeenCalledWith({
      type: "disconnect",
      agentId: s.actor.id,
    }),
  );
  const intermediate = s.core
    .taskAgents("task")
    .find((agent) => agent.role === "actor")!;
  await connections.connectChat(
    "task",
    "actor",
    "https://chatgpt.com/c/current",
  );
  finishDisconnect();
  await oldConnect;
  expect(
    bridge.request.mock.calls.some(
      ([command]) =>
        command.type === "connect" && command.agentId === intermediate.id,
    ),
  ).toBe(false);
  const current = s.core
    .taskAgents("task")
    .find((agent) => agent.role === "actor")!;
  expect(bridge.request).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "connect",
      agentId: current.id,
      activeAgentIds: s.core.state.agents.map((agent) => agent.id),
    }),
  );
});

it.each(["actor", "watcher"] as const)(
  "keeps the manual %s acknowledgment at the checkpoint and accepts the first real handoff reply without resending agent.md",
  async (role) => {
    const s = setup();
    s.core.receive(
      s.actor.id,
      "actor-started",
      response(1, "actor->watcher", "Actor project work has started."),
    );
    const old = role === "actor" ? s.actor : s.watcher;
    old.lastNumber = 7;
    const request = s.core.handover("task", role);
    s.core.delivery(request.id, "submitted");
    const report = s.core.receive(
      s.watcher.id,
      "report",
      response(
        s.watcher.lastNumber + 1,
        "watcher->operator",
        "HANDOVER PACKET\nComplete continuation report.",
      ),
      "task",
      request.id,
    );
    const checkpoint = old.lastNumber;
    const receipt = manualHandoverReceipt(
      report.id,
      role,
      s.core.state.instructions.hash,
      checkpoint,
    );
    bridge.request.mockImplementation(async (command) =>
      command.type === "send"
        ? { status: "submitted" }
        : {
            ready: true,
            lastNumber: checkpoint,
            lastRole: role,
            response: response(
              checkpoint,
              `${role}->${role === "actor" ? "watcher" : "actor"}`,
              `Complete protocol received.\n${receipt}`,
            ),
          },
    );
    const connections = new ChatConnections(s.core, "a".repeat(64));
    await connections.connectChat(
      "task",
      role,
      `https://chatgpt.com/c/manual-${role}`,
    );
    const replacement = s.core
      .taskAgents("task")
      .find((agent) => agent.role === role)!;
    expect(replacement.lastNumber).toBe(checkpoint);
    expect(replacement.manualHandover?.reportId).toBe(report.id);
    expect(needsAgentInstructions(s.core.state, replacement)).toBe(false);
    expect(
      bridge.request.mock.calls.some(([command]) => command.type === "send"),
    ).toBe(false);
    const restored = makeCore();
    restored.state = structuredClone(s.core.state);
    restored.recover();
    expect(
      needsAgentInstructions(restored.state, restored.agent(replacement.id)),
    ).toBe(false);

    const sender = role === "actor" ? s.watcher : s.actor;
    const source = s.core.receive(
      sender.id,
      "new-briefing",
      response(
        sender.lastNumber + 1,
        `${sender.role}->${role}`,
        "Continue the current project step.",
      ),
    );
    const sent = s.core.send(replacement.id, source.content, source.id);
    await vi.waitFor(() => expect(sent.status).toBe("submitted"));
    expect(sent.content).not.toContain(s.core.state.instructions.text);
    expect(sent.onboardingRole).toBeUndefined();
    expect(sent.originalInput).toBe(source.content);
    expect(bridge.request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "send", expectedNumber: checkpoint + 1 }),
    );
    bridge.event!({
      type: "response",
      agentId: replacement.id,
      taskId: "task",
      deliveryId: sent.id,
      sourceId: "continued",
      url: replacement.conversation,
      content: response(
        checkpoint + 1,
        `${role}->${sender.role}`,
        "Continued from the manual handover.",
      ),
    });
    expect(replacement.lastNumber).toBe(checkpoint + 1);
    expect(replacement.awaitingResponse).toBe(false);
    expect(s.core.state.messages.at(-1)?.parsed?.issues).toEqual([]);
    s.core.state.instructions.hash = "b".repeat(64);
    expect(needsAgentInstructions(s.core.state, replacement)).toBe(true);
  },
);

it.each([
  "missing receipt",
  "wrong role",
  "old protocol",
  "wrong task",
  "wrong report role",
  "wrong number",
  "commands",
])(
  "does not treat %s as proof of manual protocol delivery",
  async (problem) => {
    const s = setup();
    s.core.receive(
      s.actor.id,
      "actor-started",
      response(1, "actor->watcher", "Actor project work has started."),
    );
    s.actor.lastNumber = 7;
    const request = s.core.handover("task", "actor");
    s.core.delivery(request.id, "submitted");
    const report = s.core.receive(
      s.watcher.id,
      "report",
      response(2, "watcher->operator", "HANDOVER PACKET\nProject report."),
      "task",
      request.id,
    );
    if (problem === "wrong task") report.taskId = "other";
    if (problem === "wrong report role") report.handoverRole = "watcher";
    const receipt = manualHandoverReceipt(
      report.id,
      problem === "wrong role" ? "watcher" : "actor",
      problem === "old protocol"
        ? "0".repeat(64)
        : s.core.state.instructions.hash,
      7,
    );
    const content = response(
      problem === "wrong number" ? 8 : 7,
      "actor->watcher",
      problem === "missing receipt"
        ? "Ready."
        : `${receipt}${problem === "commands" ? "\n```powershell\nclear\nGet-Location\n```" : ""}`,
    );
    bridge.request.mockResolvedValue({
      ready: true,
      lastNumber: problem === "wrong number" ? 8 : 7,
      lastRole: "actor",
      response: content,
    });
    const connections = new ChatConnections(s.core, "a".repeat(64));
    await connections.connectChat(
      "task",
      "actor",
      "https://chatgpt.com/c/unverified",
    );
    const replacement = s.core
      .taskAgents("task")
      .find((agent) => agent.role === "actor")!;
    expect(replacement.manualHandover).toBeUndefined();
    expect(needsAgentInstructions(s.core.state, replacement)).toBe(true);
  },
);
