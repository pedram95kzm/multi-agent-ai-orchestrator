import { expect, it, vi } from "vitest";
import { makeCore, response } from "../helpers";
import {
  handoverRequest,
  manualHandoverPacket,
} from "../../packages/orchestration/handover";
import { pendingOperatorReply } from "../../packages/shared/operator-replies";
import { actionSchema } from "../../packages/shared/actions";
import { migrateTaskChats } from "../../packages/orchestration/migrate";

function setup() {
  const core = makeCore();
  core.state.tasks.push(
    {
      id: "task",
      title: "Preserve the project",
      kind: "feature",
      operatingSystem: "Windows",
      created: "2026-10-27",
    },
    { id: "other", title: "Other", kind: "test", created: "2026-10-27" },
  );
  core.state.activeTaskId = "task";
  const actor = core.connectChat(
    "task",
    "actor",
    "https://chatgpt.com/c/actor",
  );
  const watcher = core.connectChat(
    "task",
    "watcher",
    "https://chat.deepseek.com/a/chat/s/watcher",
  );
  actor.connected = watcher.connected = true;
  actor.briefed = true;
  const first = core.receive(
    actor.id,
    "first",
    response(1, "actor->watcher", "Original role reference."),
  );
  actor.lastNumber = 11;
  watcher.lastNumber = 7;
  const requirements = core.send(
    watcher.id,
    "Keep the existing database and Persian labels — داده‌ها حفظ شوند.",
  );
  core.delivery(requirements.id, "submitted");
  core.append(
    {
      sender: "Operator",
      recipient: "operator",
      conversationId: "other",
      type: "operator",
      content: "OTHER TASK SECRET",
      status: "submitted",
    },
    "other",
  );
  const request = core.handover("task");
  core.delivery(request.id, "submitted");
  const report = core.receive(
    watcher.id,
    "report",
    response(
      8,
      "watcher->operator",
      "HANDOVER PACKET\nArchitecture, files, verified changes, evidence and precise next steps.\nWorking directory: C:\\history\nWorking directory: C:\\history.\nq1: Historical example.\nq1: Another protocol example.",
    ),
    "task",
    request.id,
  );
  return { core, actor, watcher, requirements, first, report, request };
}

it.each(["actor", "watcher"] as const)(
  "builds a self-contained manual %s packet containing the exact protocol, report, evidence and continued counter",
  (role) => {
    const s = setup();
    s.core.state.runs.push({
      id: "run",
      batchId: "batch",
      agentId: s.actor.id,
      taskId: "task",
      command: "clear\npython main.py",
      cwd: "C:\\project",
      started: "2026-10-27",
      finished: "2026-10-27",
      stdout: "Actual output",
      stderr: "",
      exitCode: 0,
      status: "completed",
      truncated: false,
      logPath: "logs/run",
    });
    const packet = manualHandoverPacket(s.core.state, "task", s.report, role);
    expect(packet).toContain(`Target role: ${role}`);
    expect(packet).toContain(
      `Your first actual project reply AFTER the next Relay message must be RESPONSE NUMBER ${role === "actor" ? 12 : 9}`,
    );
    expect(packet).toContain(
      `REPEAT the last confirmed number ${role === "actor" ? 11 : 8}`,
    );
    expect(packet).toContain("MANUAL HANDOVER ACK:");
    expect(packet.split(s.core.state.instructions.text)).toHaveLength(2);
    expect(packet).toContain(s.report.content);
    expect(packet).toContain(s.requirements.originalInput);
    expect(packet).toContain("Actual output");
    expect(packet).toContain('"exitCode": 0');
    expect(packet).not.toContain("OTHER TASK SECRET");
    if (role === "actor")
      expect(packet).toContain(JSON.stringify(s.first.content));
    expect(s.report.parsed?.questions).toEqual([]);
    expect(s.report.parsed?.issues).toEqual([]);
    expect(pendingOperatorReply(s.core.state, "task")).toBeUndefined();
    expect(
      handoverRequest(s.core.state, "task").match(
        /Return ONE complete self-contained handover/g,
      ),
    ).toHaveLength(1);
  },
);

it.each([undefined, "actor", "watcher"] as const)(
  "asks the current Watcher to prepare %s for the Operator and retains its selected mode",
  (targetRole) => {
    const s = setup();
    const request = s.core.handover("task", targetRole);
    expect(request.agentId).toBe(s.watcher.id);
    expect(request.handoverRole).toBe(targetRole);
    expect(request.content).toContain("watcher->operator");
    if (targetRole)
      expect(request.content).toContain(
        `From now on you are the ${targetRole === "actor" ? "Actor" : "Watcher"}`,
      );
    else expect(request.content).toContain("full PROJECT handover only");
    s.core.delivery(request.id, "submitted");
    const report = s.core.receive(
      s.watcher.id,
      `mode-${targetRole ?? "project"}`,
      response(
        9,
        "watcher->operator",
        "HANDOVER PACKET\nProject and next work.",
      ),
      "task",
      request.id,
    );
    expect(report.role).toBe("watcher");
    expect(report.parsed?.recipient).toBe("operator");
    expect(report.handoverRole).toBe(targetRole);
  },
);

it("keeps a project-only handover free of added protocol and role assignment", () => {
  const s = setup();
  const packet = manualHandoverPacket(s.core.state, "task", s.report);
  expect(packet).toContain(s.report.content);
  expect(packet).not.toContain(s.core.state.instructions.text);
  expect(packet).not.toContain("Target role:");
});

it("does not turn a handover addressed to an agent into an Operator handover packet", () => {
  const s = setup();
  const request = s.core.handover("task", "actor");
  s.core.delivery(request.id, "submitted");
  const report = s.core.receive(
    s.watcher.id,
    "wrong-recipient",
    response(9, "watcher->actor", "HANDOVER PACKET\nWrong route."),
    "task",
    request.id,
  );
  expect(report.parsed?.issues).toContain(
    "All handover reports must be prepared by the Watcher using watcher->operator.",
  );
  expect(() =>
    manualHandoverPacket(s.core.state, "task", report, "actor"),
  ).toThrow("generated handover report");
});

it.each(["actor", "watcher"] as const)(
  "replaces the %s by URL without sending, preserving counters and history and withdrawing stale batches",
  (role) => {
    const s = setup();
    const old = role === "actor" ? s.actor : s.watcher;
    const content = s.core.state.messages.map((message) => message.content);
    old.awaitingResponse = true;
    old.contextHealth = {
      baselineEstablished: true,
      status: "unavailable",
      needsOnboarding: true,
      messageId: "lost",
      checkedAt: "2026-10-27",
    };
    s.core.state.batches.push({
      id: "pending",
      requesterId: old.id,
      actorId: old.id,
      proposalId: s.requirements.id,
      command: "clear\npwd",
      state: "ready",
      inspection: false,
    });
    const transport = vi.fn(() => true);
    s.core.transport = transport;
    const replacement = s.core.connectChat(
      "task",
      role,
      `https://chatgpt.com/c/new-${role}`,
    );
    expect(replacement.id).not.toBe(old.id);
    expect(replacement.lastNumber).toBe(old.lastNumber);
    expect(replacement.briefed).toBe(old.briefed);
    expect(replacement.contextHealth).toBeUndefined();
    expect(s.core.state.agents).not.toContain(old);
    expect(s.core.state.batches[0].state).toBe("rejected");
    expect(s.core.state.messages.map((message) => message.content)).toEqual(
      content,
    );
    expect(transport).not.toHaveBeenCalled();
  },
);

it("refuses URL replacement atomically while execution is running", () => {
  const s = setup();
  s.core.state.batches.push({
    id: "running",
    requesterId: s.actor.id,
    proposalId: s.requirements.id,
    command: "clear\npwd",
    state: "running",
    inspection: false,
  });
  const before = structuredClone(s.core.state);
  expect(() =>
    s.core.connectChat("task", "actor", "https://chatgpt.com/c/new"),
  ).toThrow("running execution");
  expect(s.core.state).toEqual(before);
});

it("accepts the recorded Watcher handover as the manual replacement Actor's continuation briefing", () => {
  const s = setup();
  s.actor.briefed = false;
  const replacement = s.core.connectChat(
    "task",
    "actor",
    "https://chatgpt.com/c/prepared-actor",
  );
  expect(replacement.briefed).toBe(true);
});

it("rejects the removed onboarding IPC actions and send kind", () => {
  for (const type of ["onboard", "resumeOnboarding", "cancelOnboarding"])
    expect(
      actionSchema.safeParse({
        type,
        taskId: "task",
        role: "actor",
        url: "https://chatgpt.com/c/new",
      }).success,
    ).toBe(false);
  expect(
    actionSchema.safeParse({
      type: "send",
      agentId: "actor",
      content: "old packet",
      kind: "onboarding",
    }).success,
  ).toBe(false);
});

it("blocks every handover before a confirmed first Watcher submission and an Actor replacement until its first response", () => {
  const s = setup();
  s.core.state.messages = [];
  s.actor.lastNumber = s.watcher.lastNumber = 0;
  for (const role of [undefined, "actor", "watcher"] as const)
    expect(() => s.core.handover("task", role)).toThrow("first task message");
  const failed = s.core.send(s.watcher.id, "Start this task.");
  s.core.delivery(failed.id, "failed");
  expect(() => s.core.handover("task")).toThrow("first task message");
  const first = s.core.send(s.watcher.id, "Start this task.");
  s.core.delivery(first.id, "submitted");
  expect(() => s.core.handover("task", "actor")).toThrow(
    "Actor's first response",
  );
  s.actor.lastNumber = 7;
  expect(() => s.core.handover("task", "actor")).toThrow(
    "Actor's first response",
  );
  s.actor.lastNumber = 0;
  expect(() => s.core.handover("task")).not.toThrow();
});

it.each([false, true])(
  "retires a legacy workflow without replaying it; transfer was submitted: %s",
  (submitted) => {
    const s = setup();
    const staged = {
      ...s.actor,
      id: "staged",
      conversation: "https://chatgpt.com/c/staged",
      staged: true,
    };
    s.core.state.agents.push(staged);
    const delivery = s.core.append(
      {
        agentId: staged.id,
        sender: "Operator",
        recipient: staged.id,
        conversationId: staged.conversation,
        type: "onboarding",
        content: "Preserved historical packet",
        status: submitted ? "submitted" : "pending",
      },
      "task",
    );
    const retiredRequest = s.core.append(
      {
        agentId: s.watcher.id,
        sender: "Operator",
        recipient: s.watcher.id,
        conversationId: s.watcher.conversation,
        type: "operator",
        purpose: "onboarding",
        content: "Retired request",
        status: "pending",
      },
      "task",
    );
    s.watcher.awaitingResponse = true;
    s.core.state.tasks[0].onboarding = {
      role: "actor",
      url: staged.conversation,
      previousAgentId: s.actor.id,
      agentId: staged.id,
      deliveryId: delivery.id,
    };
    const bodies = s.core.state.messages.map((message) => message.content);
    migrateTaskChats(s.core.state);
    expect(s.core.state.tasks[0].onboarding).toBeUndefined();
    expect(
      s.core.state.agents.some(
        (agent) => agent.id === (submitted ? staged.id : s.actor.id),
      ),
    ).toBe(true);
    expect(
      s.core.state.agents.some(
        (agent) => agent.id === (submitted ? s.actor.id : staged.id),
      ),
    ).toBe(false);
    expect(s.core.state.messages.map((message) => message.content)).toEqual(
      bodies,
    );
    if (!submitted) expect(delivery.status).toBe("uncertain");
    expect(retiredRequest.status).toBe("uncertain");
    expect(s.watcher.awaitingResponse).toBe(false);
    expect(() =>
      s.core.send(
        s.watcher.id,
        "Continue after retiring the automatic workflow.",
      ),
    ).not.toThrow();
  },
);
