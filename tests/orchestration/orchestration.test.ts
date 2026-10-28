import { describe, expect, it } from "vitest";
import { makeCore, register, response, block } from "../helpers";
import { validateInstructions } from "../../packages/agent-instructions/instructions";
import { withContextCheck } from "../../packages/shared/context-health";

describe("roles, delivery, workflow, and exact review", () => {
  it.each(["actor", "watcher"] as const)(
    "includes full instructions in the first %s delivery even if an old record marks the role ready",
    (role) => {
      const core = makeCore();
      const agent = register(core, role);
      agent.onboarding = "ready";
      agent.lastNumber = 7;
      const outgoing = core.send(agent.id, "Use this current request.");
      expect(outgoing.content).toContain(core.state.instructions.text);
      expect(outgoing.content).toContain("Use this current request.");
      expect(outgoing.content).toContain("RESPONSE NUMBER 8");
      expect(outgoing.onboardingRole).toBe(role);
    },
  );
  it("does not treat a greeting carrying an onboarding flag as confirmed protocol delivery", () => {
    const core = makeCore();
    const actor = register(core, "actor");
    const first = core.send(actor.id, "hi");
    core.delivery(first.id, "submitted");
    first.content = "hi";
    actor.onboarding = "ready";
    expect(core.send(actor.id, "The actual new request.").content).toContain(
      core.state.instructions.text,
    );
  });
  it("rejects a handoff that substitutes an old greeting for the selected Watcher response", () => {
    const core = makeCore();
    const actor = register(core, "actor"),
      watcher = register(core, "watcher");
    const current = core.receive(
      watcher.id,
      "current",
      response(1, "watcher->actor", "Implement the current task."),
    );
    expect(() => core.send(actor.id, "hi", current.id)).toThrow(
      "selected response",
    );
    const outgoing = core.send(actor.id, current.content, current.id);
    expect(outgoing.content).toContain(core.state.instructions.text);
    expect(outgoing.originalInput).toBe(current.content);
    expect(outgoing.content).toContain("Implement the current task.");
  });
  it("deletes a task's messages, selects the newest remaining task, and keeps other task history", () => {
    const c = makeCore();
    c.state.tasks.push(
      {
        id: "older",
        kind: "feature",
        title: "Older task",
        created: "2026-01-01T00:00:00Z",
      },
      {
        id: "active",
        kind: "bug",
        title: "Active task",
        created: "2026-01-03T00:00:00Z",
      },
      {
        id: "newest",
        kind: "feature",
        title: "Newest task",
        created: "2026-01-02T00:00:00Z",
      },
    );
    c.state.activeTaskId = "active";
    const addMessage = (id: string, taskId: string) =>
      c.state.messages.push({
        id,
        sequence: c.state.messages.length + 1,
        conversationId: "test",
        sender: "Operator",
        recipient: "operator",
        type: "operator",
        content: `Message for ${taskId}`,
        timestamp: "2026-01-03T00:00:00Z",
        status: "submitted",
        taskId,
        instructionVersion: "test",
      });
    addMessage("active-message", "active");
    addMessage("newest-message", "newest");

    c.removeTask("active");

    expect(c.state.tasks.map((task) => task.id)).toEqual(["older", "newest"]);
    expect(c.state.activeTaskId).toBe("newest");
    expect(c.state.messages.map((message) => message.id)).toEqual([
      "newest-message",
    ]);
  });
  it("deletes ready command batches with their task without requiring manual rejection", () => {
    const c = makeCore();
    c.state.tasks.push({
      id: "active",
      kind: "feature",
      title: "Active task",
      created: "2026-01-03T00:00:00Z",
    });
    c.state.activeTaskId = "active";
    c.state.messages.push({
      id: "proposal",
      sequence: 1,
      conversationId: "test",
      sender: "Operator",
      recipient: "operator",
      type: "operator",
      content: "Review this",
      timestamp: "2026-01-03T00:00:00Z",
      status: "submitted",
      taskId: "active",
      instructionVersion: "test",
    });
    c.state.batches.push({
      id: "batch",
      command: "pwd",
      requesterId: "agent",
      proposalId: "proposal",
      state: "ready",
      inspection: false,
    });

    c.removeTask("active");
    expect(c.state.tasks).toEqual([]);
    expect(c.state.messages).toEqual([]);
    expect(c.state.batches).toEqual([]);
  });
  it("clears the active task when the last task is deleted", () => {
    const c = makeCore();
    c.state.tasks.push({
      id: "only",
      kind: "feature",
      title: "Only",
      created: "2026-01-01T00:00:00Z",
    });
    c.state.activeTaskId = "only";

    c.removeTask("only");

    expect(c.state.tasks).toEqual([]);
    expect(c.state.activeTaskId).toBeUndefined();
  });
  it("keeps a late browser reply with its outgoing task and drops replies after deletion", () => {
    const c = makeCore(),
      a = register(c, "actor");
    c.state.tasks.push(
      {
        id: "sent-task",
        kind: "feature",
        title: "Sent task",
        created: "2026-01-01T00:00:00Z",
      },
      {
        id: "other-task",
        kind: "feature",
        title: "Other task",
        created: "2026-01-02T00:00:00Z",
      },
    );
    c.state.activeTaskId = "sent-task";
    a.provider = "chatgpt";
    a.connected = true;
    c.transport = () => true;

    const watcher = register(c, "watcher");
    c.delivery(c.send(watcher.id, "Start task A").id, "submitted");
    const outgoing = c.send(a.id, "Question for task A");
    c.state.activeTaskId = "other-task";
    const reply = c.receive(
      a.id,
      "provider-reply",
      "Task A reply",
      outgoing.taskId!,
    );

    expect(outgoing.taskId).toBe("sent-task");
    expect(reply?.taskId).toBe("sent-task");
    c.removeTask("sent-task");
    expect(
      c.receive(
        a.id,
        "late-after-delete",
        "Should be dropped",
        outgoing.taskId!,
      ),
    ).toBeUndefined();
    expect(
      c.state.messages.some((message) => message.taskId === "sent-task"),
    ).toBe(false);
    expect(c.state.activeTaskId).toBe("other-task");
  });

  it("retains a late delivery acknowledgment after its agent has been removed", () => {
    const c = makeCore(),
      a = register(c, "actor");
    a.provider = "chatgpt";
    c.transport = () => true;
    const m = c.send(a.id, "Hello");
    c.remove(a.id);
    c.delivery(m.id, "submitted");
    expect(m.status).toBe("submitted");
    expect(c.state.messages[0].content).toContain("Hello");
  });

  it("enforces a persistent single watcher and releases it on removal", () => {
    const c = makeCore(),
      w = register(c, "watcher");
    expect(() => register(c, "watcher", 2)).toThrow("already assigned");
    c.remove(w.id);
    expect(register(c, "watcher", 2).role).toBe("watcher");
  });
  it("prevents duplicate conversations including URL fragments", () => {
    const c = makeCore(),
      a = register(c, "actor");
    const duplicate = c.register({
      ...a,
      conversation: a.conversation + "#message",
      lastNumber: 999,
      provider: "browser",
    });
    expect(duplicate.id).toBe(a.id);
    expect(duplicate.lastNumber).toBe(0);
    expect(c.state.agents).toHaveLength(1);
  });

  it("preserves response text, ordering, and independent counters; deduplicates source events", () => {
    const c = makeCore(),
      a = register(c, "actor"),
      w = register(c, "watcher");
    const text = response(1, "actor->watcher");
    const m = c.receive(a.id, "one", text);
    c.receive(a.id, "one", text);
    c.receive(w.id, "two", response(1, "watcher->operator"));
    expect(c.state.messages).toHaveLength(2);
    expect(m.content).toBe(text);
    expect(c.state.messages.map((m) => m.sequence)).toEqual([1, 2]);
    expect(a.lastNumber).toBe(1);
    expect(w.lastNumber).toBe(1);
  });
  it("flags gaps without inventing a missing number or authorizing batches", () => {
    const c = makeCore(),
      a = register(c, "actor");
    a.briefed = true;
    const m = c.receive(a.id, "gap", response(9, "actor->watcher", block()));
    expect(a.lastNumber).toBe(0);
    expect(m.parsed?.number).toBe(9);
    expect(c.state.batches).toHaveLength(0);
  });
  it("requires a watcher briefing before actor proposals", () => {
    const c = makeCore(),
      a = register(c, "actor");
    c.receive(a.id, "one", response(1, "actor->watcher", block()));
    expect(c.state.batches).toHaveLength(0);
  });
  it("routes to the exact agent, preserves a handoff, and prevents duplicate handoffs", () => {
    const c = makeCore(),
      a = register(c, "actor"),
      w = register(c, "watcher");
    a.onboarding = "ready";
    const m = c.receive(
      w.id,
      "brief",
      response(1, "watcher->actor", "Task briefing"),
    );
    const outgoing = c.send(a.id, m.content, m.id);
    expect(outgoing.content).toContain(c.state.instructions.text);
    expect(outgoing.content.endsWith(withContextCheck(m.content, a))).toBe(
      true,
    );
    c.delivery(outgoing.id, "submitted");
    expect(a.briefed).toBe(true);
    expect(() => c.send(a.id, m.content, m.id)).toThrow("already been handed");
  });
  it("will not silently reroute to the wrong role or a disconnected conversation", () => {
    const c = makeCore(),
      w = register(c, "watcher"),
      a = register(c, "actor");
    const m = c.receive(a.id, "one", response(1, "actor->watcher"));
    expect(() => c.send(a.id, m.content, m.id)).toThrow("differs");
    w.connected = false;
    expect(() => c.send(w.id, "hello")).toThrow("disconnected");
  });
  it("only makes the exact approved, forwarded batch executable", () => {
    const c = makeCore(),
      a = register(c, "actor"),
      w = register(c, "watcher");
    a.briefed = true;
    c.receive(a.id, "propose", response(1, "actor->watcher", block()));
    expect(c.state.batches[0].state).toBe("proposed");
    c.receive(
      w.id,
      "review",
      response(1, "watcher->actor", `APPROVED\n${block()}`),
    );
    expect(c.state.batches[0].state).toBe("reviewed");
    c.receive(w.id, "forward", response(2, "watcher->operator", block()));
    expect(c.state.batches[0].state).toBe("ready");
    expect(c.state.batches[0].inspection).toBe(false);
  });
  it("does not accept ambiguous approval or silently edited approved code", () => {
    const c = makeCore(),
      a = register(c, "actor"),
      w = register(c, "watcher");
    a.briefed = true;
    const m = c.receive(
      a.id,
      "proposal",
      response(1, "actor->watcher", block()),
    );
    c.receive(
      w.id,
      "review",
      response(1, "watcher->actor", `Looks good\n${block()}`),
    );
    c.receive(w.id, "forward", response(2, "watcher->operator", block()));
    expect(c.state.batches[0].state).toBe("proposed");
    c.delivery(
      c.send(w.id, "Please correct the proposed execution handoff.").id,
      "submitted",
    );
    expect(() => c.send(w.id, m.content.replace("pwd", "ls"), m.id)).toThrow(
      "Editing",
    );
  });

  it("never retries uncertain submissions and uses a new id for a confirmed failure", () => {
    const c = makeCore(),
      a = register(c, "actor");
    a.provider = "chatgpt";
    c.transport = () => true;
    const m = c.send(a.id, "hello");
    c.delivery(m.id, "uncertain");
    expect(() => c.retry(m.id)).toThrow("confirmed");
    c.delivery(m.id, "failed");
    c.retry(m.id);
    expect(c.state.messages[1].id).not.toBe(m.id);
    expect(c.state.messages[1].content).toBe(m.content);
  });
  it.each(["pending", "uncertain"] as const)(
    "blocks another send and retry for an agent with a %s delivery while keeping other agents available",
    (status) => {
      const core = makeCore();
      const actor = register(core, "actor");
      const watcher = register(core, "watcher");
      const failed = core.send(actor.id, "Confirmed pre-submission failure.");
      core.delivery(failed.id, "failed");
      const unresolved = core.send(actor.id, "Current delivery.");
      if (status === "uncertain") core.delivery(unresolved.id, status);
      const before = core.state.messages.length;
      expect(() => core.send(actor.id, "Duplicate delivery.")).toThrow(
        "pending or uncertain delivery",
      );
      expect(() => core.retry(failed.id)).toThrow(
        "Resolve another pending delivery",
      );
      expect(core.state.messages).toHaveLength(before);
      expect(() =>
        core.send(watcher.id, "Independent delivery."),
      ).not.toThrow();
      core.delivery(unresolved.id, "submitted");
      expect(() => core.send(actor.id, "Next delivery.")).not.toThrow();
    },
  );
  it("recovers pending submissions and runs honestly after restart", () => {
    const c = makeCore(),
      a = register(c, "actor");
    a.provider = "chatgpt";
    c.transport = () => true;
    const m = c.send(a.id, "hello");
    c.recover();
    expect(m.status).toBe("uncertain");
    expect(a.connected).toBe(false);
  });
  it("preserves operator input separately from its actual payload", () => {
    const c = makeCore(),
      a = register(c, "actor");
    const input = "q1: A";
    const sent = c.send(a.id, input);
    expect(sent.content).toContain(c.state.instructions.text);
    expect(sent.content).toContain("Operator message:\nq1: A");
    expect(sent.originalInput).toBe(input);
    expect(input).toBe("q1: A");
  });
  it("includes complete instructions once and only confirms onboarding after delivery", () => {
    const c = makeCore(),
      a = register(c, "actor"),
      b = register(c, "actor", 2);
    a.lastNumber = 7;
    const first = c.send(a.id, "Task type: 2. Add a feature\nInitialize Git");
    expect(first.content).toContain(c.state.instructions.text);
    expect(first.content).toContain("Target role: actor");
    expect(first.content).toContain(
      "Your next response must be RESPONSE NUMBER 8",
    );
    expect(first.onboardingRole).toBe("actor");
    expect(a.onboarding).toBe("registered");
    c.delivery(first.id, "submitted");
    expect(a.onboarding).toBe("packet-sent");
    expect(c.send(a.id, "Follow-up").content).toBe(
      withContextCheck("__________\nFollow-up", a),
    );
    expect(c.send(b.id, "Other task").content).toContain(
      c.state.instructions.text,
    );
  });
  it("preserves the original handoff inside the first message's instructions", () => {
    const c = makeCore(),
      a = register(c, "actor"),
      w = register(c, "watcher");
    const source = c.receive(
      w.id,
      "briefing",
      response(1, "watcher->actor", block()),
    );
    const sent = c.send(a.id, source.content, source.id);
    expect(sent.content).toContain(c.state.instructions.text);
    expect(sent.content.endsWith(withContextCheck(source.content, a))).toBe(
      true,
    );
    expect(sent.originalInput).toBe(source.content);
    c.delivery(sent.id, "submitted");
    expect(a.briefed).toBe(true);
  });
  it("includes edited instructions in the next message without resetting counters or changing reviewed evidence", () => {
    const c = makeCore(),
      watcher = register(c, "watcher");
    c.delivery(c.send(watcher.id, "Inspect the workspace").id, "submitted");
    c.receive(
      watcher.id,
      "inspection",
      response(1, "watcher->operator", block()),
    );
    const batch = JSON.stringify(c.state.batches[0]);
    const original = c.state.messages[0].content;
    c.state.instructions.text +=
      "\nAlways ask for execution results using q1:.\n";
    c.state.instructions.hash = validateInstructions(c.state.instructions.text);
    const updated = c.send(watcher.id, "Use the updated question format");
    expect(updated.content).toContain(c.state.instructions.text);
    expect(updated.content).toContain(
      "Your next response must be RESPONSE NUMBER 2",
    );
    expect(watcher.lastNumber).toBe(1);
    expect(JSON.stringify(c.state.batches[0])).toBe(batch);
    expect(c.state.messages[0].content).toBe(original);
    c.delivery(updated.id, "failed", "Pre-send failure");
    const again = c.send(watcher.id, "Try the updated instructions");
    expect(again.content).toContain(c.state.instructions.text);
    c.delivery(again.id, "submitted");
    expect(c.send(watcher.id, "Continue").content).toBe(
      withContextCheck("__________\nContinue", watcher),
    );
  });
  it("repairs an old failed first message when explicitly retried", () => {
    const c = makeCore(),
      a = register(c, "actor");
    a.provider = "deepseek";
    c.transport = () => true;
    const old = c.send(a.id, "Initialize Git");
    old.content = "__________\nInitialize Git";
    old.onboardingRole = undefined;
    c.delivery(old.id, "failed", "Automation is disabled");
    c.retry(old.id);
    const retry = c.state.messages.at(-1)!;
    expect(retry.content).toContain(c.state.instructions.text);
    expect(retry.content).toContain("Operator message:\nInitialize Git");
    expect(retry.originalInput).toBe("Initialize Git");
    expect(retry.onboardingRole).toBe("actor");
    c.delivery(retry.id, "submitted");
    expect(a.onboarding).toBe("packet-sent");
  });
  it("permits only one batch awaiting execution and preserves its workspace", () => {
    const c = makeCore(),
      w = register(c, "watcher");
    c.receive(
      w.id,
      "first",
      response(
        1,
        "watcher->operator",
        `Working directory: ${process.cwd()}\n${block()}`,
      ),
    );
    const second = c.receive(
      w.id,
      "second",
      response(2, "watcher->operator", block("ls")),
    );
    expect(c.state.batches).toHaveLength(1);
    expect(c.state.batches[0].cwd).toBe(process.cwd());
    expect(second.parsed?.issues.join(" ")).toContain("awaiting execution");
    expect(() => c.remove(w.id)).toThrow("Finish or reject");
  });
});
