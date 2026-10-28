import { expect, it } from "vitest";
import { makeCore, register, response } from "../helpers";
import {
  contextCheckFooter,
  responseOneForAgent,
  withContextCheck,
} from "../../packages/shared/context-health";
import { outgoingPayload } from "../../packages/shared/outgoing";
import { manualHandoverPacket } from "../../packages/orchestration/handover";
import { parseResponse } from "../../packages/protocol/parser";
import { Store } from "../../packages/orchestration/store";

it.each(["actor", "watcher"] as const)(
  "ends every message kind and retry with one context question for %s",
  (role) => {
    const core = makeCore();
    const agent = register(core, role);
    const footer = contextCheckFooter(role);
    const first = core.send(agent.id, "Start task");
    expect(first.content.endsWith(footer)).toBe(true);
    core.delivery(first.id, "submitted");
    agent.onboarding = "ready";
    const body = "Original body\n```bash\nclear\npwd\n```";
    for (const kind of ["operator", "terminal"] as const) {
      const payload = outgoingPayload(
        core.state,
        agent,
        body,
        kind === "operator" ? "source" : undefined,
        kind,
      );
      expect(payload).toContain(body);
      expect(payload.endsWith(footer)).toBe(true);
      expect(payload.split(footer)).toHaveLength(2);
    }
    const failed = core.send(agent.id, "Retry me");
    core.delivery(failed.id, "failed");
    core.retry(failed.id);
    expect(core.state.messages.at(-1)!.content.split(footer)).toHaveLength(2);
    expect(withContextCheck("body", agent)).toBe(
      withContextCheck(withContextCheck("body", agent), agent),
    );
  },
);

it("recognizes only current standalone metadata outside quoted code and Operator text", () => {
  const parsed = parseResponse(
    response(1, "watcher->actor", "CONTEXT CHECK: RESPONSE 1 = READABLE"),
  );
  expect(parsed.contextCheck).toBe("readable");
  expect(parsed.summary).toBe("Test summary.");
  expect(parsed.questions).toEqual([]);
  expect(parsed.issues).toEqual([]);
  for (const quoted of [
    "```text\nCONTEXT CHECK: RESPONSE 1 = UNAVAILABLE\n```",
    "> CONTEXT CHECK: RESPONSE 1 = UNAVAILABLE",
    "__________\nCONTEXT CHECK: RESPONSE 1 = UNAVAILABLE",
  ]) {
    expect(
      parseResponse(response(1, "actor->watcher", quoted)).contextCheck,
    ).toBeUndefined();
  }
  const conflicting = parseResponse(
    response(
      1,
      "actor->watcher",
      "CONTEXT CHECK: RESPONSE 1 = READABLE\nCONTEXT CHECK: RESPONSE 1 = UNAVAILABLE",
    ),
  );
  expect(conflicting.contextCheck).toBeUndefined();
  expect(conflicting.issues.join(" ")).toContain("Conflicting context-check");
});

it.each(["actor", "watcher"] as const)(
  "retains a %s onboarding recommendation after lost context, subsequent checks, persistence, and restart",
  (role) => {
    const core = makeCore();
    const agent = register(core, role);
    const route = `${role}->${role === "actor" ? "watcher" : "actor"}`;
    core.receive(
      agent.id,
      "one",
      response(1, route, "CONTEXT CHECK: RESPONSE 1 = READABLE"),
    );
    expect(agent.contextHealth?.needsOnboarding).toBe(false);
    const lost = core.receive(
      agent.id,
      "two",
      response(2, route, "CONTEXT CHECK: RESPONSE 1 = UNAVAILABLE"),
    );
    expect(agent.contextHealth).toMatchObject({
      needsOnboarding: true,
      status: "unavailable",
      messageId: lost.id,
    });
    core.receive(
      agent.id,
      "three",
      response(3, route, "CONTEXT CHECK: RESPONSE 1 = READABLE"),
    );
    expect(agent.contextHealth?.needsOnboarding).toBe(true);
    const store = new Store(":memory:");
    try {
      store.save(core.state);
      expect(store.load()!.agents[0].contextHealth).toEqual(
        agent.contextHealth,
      );
    } finally {
      store.close();
    }
    core.recover();
    expect(agent.contextHealth?.needsOnboarding).toBe(true);
  },
);

it("does not treat an initial or continued chat without a reference as full, but detects a lost established reference", () => {
  const core = makeCore();
  const initial = register(core, "actor");
  core.receive(
    initial.id,
    "first",
    response(
      1,
      "actor->watcher",
      "CONTEXT CHECK: RESPONSE 1 = NOT_ESTABLISHED",
    ),
  );
  expect(initial.contextHealth).toMatchObject({
    baselineEstablished: true,
    needsOnboarding: false,
  });
  core.receive(
    initial.id,
    "lost",
    response(
      2,
      "actor->watcher",
      "CONTEXT CHECK: RESPONSE 1 = NOT_ESTABLISHED",
    ),
  );
  expect(initial.contextHealth?.needsOnboarding).toBe(true);
  const replacement = register(core, "actor", 2);
  replacement.lastNumber = 7;
  core.receive(
    replacement.id,
    "continued",
    response(
      8,
      "actor->watcher",
      "CONTEXT CHECK: RESPONSE 1 = NOT_ESTABLISHED",
    ),
  );
  expect(replacement.contextHealth).toMatchObject({
    baselineEstablished: false,
    needsOnboarding: false,
  });
});

it("does not accept context claims from another role, a counter gap, or missing metadata", () => {
  const core = makeCore();
  const actor = register(core, "actor");
  core.receive(
    actor.id,
    "wrong-role",
    response(1, "watcher->operator", "CONTEXT CHECK: RESPONSE 1 = UNAVAILABLE"),
  );
  expect(actor.contextHealth).toBeUndefined();
  core.receive(
    actor.id,
    "wrong-counter",
    response(9, "actor->watcher", "CONTEXT CHECK: RESPONSE 1 = UNAVAILABLE"),
  );
  expect(actor.contextHealth).toBeUndefined();
  core.receive(
    actor.id,
    "valid",
    response(1, "actor->watcher", "No context check reported."),
  );
  expect(actor.contextHealth?.needsOnboarding).toBe(false);
});

it("provides the original role response 1 once in a replacement packet without resetting its counter or copying it into follow-ups", () => {
  const core = makeCore();
  core.state.tasks.push({
    id: "task",
    title: "Task",
    kind: "feature",
    created: new Date().toISOString(),
  });
  const old = core.connectChat("task", "actor", "https://chatgpt.com/c/old");
  const original = core.receive(
    old.id,
    "one",
    response(1, "actor->watcher", "Original exact requirements."),
    "task",
  );
  const replacement = {
    ...old,
    id: "replacement",
    lastNumber: 7,
    conversation: "https://chatgpt.com/c/new",
    contextHealth: undefined,
  };
  expect(responseOneForAgent(core.state, replacement)?.id).toBe(original.id);
  core.state.agents = [replacement];
  const report = core.append(
    {
      sender: "Watcher",
      recipient: "operator",
      conversationId: "report",
      type: "response",
      purpose: "handover",
      content: "Recorded task handover.",
      status: "received",
    },
    "task",
  );
  const packet = manualHandoverPacket(core.state, "task", report, "actor");
  expect(packet).toContain(JSON.stringify(original.content));
  expect(packet).toContain(
    "Your first actual project reply AFTER the next Relay message must be RESPONSE NUMBER 8",
  );
  replacement.onboarding = "ready";
  expect(outgoingPayload(core.state, replacement, "Continue")).not.toContain(
    "Original exact requirements.",
  );
});
