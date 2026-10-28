import { describe, expect, it, vi } from "vitest";
import { makeCore, response } from "../helpers";
import { migrateTaskChats } from "../../packages/orchestration/migrate";

function tasks() {
  const core = makeCore();
  for (const id of ["first", "second"])
    core.state.tasks.push({
      id,
      kind: "feature",
      title: id,
      created: new Date().toISOString(),
    });
  core.state.activeTaskId = "first";
  return core;
}
describe("task chat assignments", () => {
  it("cascades task deletion through every batch state and run while preserving another task", () => {
    const core = tasks();
    const actor = core.connectChat("first", "actor", "https://chatgpt.com/c/a");
    core.receive(actor.id, "reply", response(1, "actor->watcher"));
    const proposalId = core.state.messages[0].id;
    for (const state of [
      "proposed",
      "reviewed",
      "ready",
      "executed",
      "rejected",
    ] as const) {
      core.state.batches.push({
        id: state,
        command: "clear\npwd",
        actorId: actor.id,
        requesterId: actor.id,
        proposalId,
        state,
        inspection: false,
      });
    }
    for (const [id, taskId] of [
      ["executed", "first"],
      ["orphan", "first"],
      ["other", "second"],
    ]) {
      core.state.runs.push({
        id,
        batchId: id,
        agentId: id === "other" ? "other-agent" : actor.id,
        taskId,
        command: "clear\npwd",
        cwd: "workspace",
        started: "2026-10-24T00:00:00Z",
        status: "completed",
        stdout: "result",
        stderr: "",
        exitCode: 0,
        truncated: false,
        logPath: `logs/${id}`,
      });
    }
    core.state.batches.push({
      id: "other",
      command: "clear\nls",
      requesterId: "other-agent",
      proposalId: "other-proposal",
      state: "executed",
      inspection: true,
    });
    const persisted = vi.spyOn(core, "changed");
    core.removeTask("first");
    expect(core.state.tasks.map((task) => task.id)).toEqual(["second"]);
    expect(core.state.batches.map((batch) => batch.id)).toEqual(["other"]);
    expect(core.state.runs.map((run) => run.id)).toEqual(["other"]);
    expect(core.state.messages).toEqual([]);
    expect(core.state.agents).toEqual([]);
    expect(persisted).toHaveBeenCalledOnce();
  });
  it.each(["batch", "run"])(
    "preserves the entire task atomically while its %s is running",
    (active) => {
      const core = tasks();
      const actor = core.connectChat(
        "first",
        "actor",
        "https://chatgpt.com/c/a",
      );
      core.state.batches.push({
        id: "active",
        command: "clear\npwd",
        requesterId: actor.id,
        proposalId: "missing",
        state: active === "batch" ? "running" : "executed",
        inspection: true,
      });
      if (active === "run")
        core.state.runs.push({
          id: "active-run",
          batchId: "active",
          agentId: actor.id,
          taskId: "first",
          command: "clear\npwd",
          cwd: "workspace",
          started: "2026-10-24T00:00:00Z",
          status: "running",
          stdout: "",
          stderr: "",
          exitCode: null,
          truncated: false,
          logPath: "logs/active",
        });
      const before = structuredClone(core.state);
      expect(() => core.removeTask("first")).toThrow("running execution");
      expect(core.state).toEqual(before);
    },
  );
  it("gives each task its own actor and watcher without sharing roles or messages", () => {
    const core = tasks();
    const a = core.connectChat("first", "actor", "https://chatgpt.com/c/a");
    const watcher = core.connectChat(
      "first",
      "watcher",
      "https://chat.z.ai/c/w",
    );
    core.connectChat("second", "actor", "https://chat.qwen.ai/c/b");
    core.connectChat(
      "second",
      "watcher",
      "https://chat.deepseek.com/a/chat/s/x",
    );
    expect(core.taskAgents("first")).toHaveLength(2);
    expect(core.taskAgents("second")).toHaveLength(2);
    expect(() => core.connectChat("second", "actor", a.conversation)).toThrow(
      "assigned elsewhere",
    );
    a.connected = true;
    watcher.connected = true;
    core.delivery(
      core.send(watcher.id, "Start the first task").id,
      "submitted",
    );
    const first = core.send(a.id, "first task only");
    core.state.activeTaskId = "second";
    expect(() => core.send(a.id, "wrong task")).toThrow(
      "Select this chat's task",
    );
    expect(
      core.receive(a.id, "reply", response(1, "actor->watcher"), first.taskId!)
        ?.taskId,
    ).toBe("first");
  });
  it("reuses an unchanged URL and removes a task's connections together with its messages", () => {
    const core = tasks();
    const agent = core.connectChat("first", "actor", "https://chatgpt.com/c/a");
    expect(core.connectChat("first", "actor", agent.conversation).id).toBe(
      agent.id,
    );
    core.receive(agent.id, "reply", response(1, "actor->operator"));
    core.removeTask("first");
    expect(core.state.agents).toHaveLength(0);
    expect(core.state.messages).toHaveLength(0);
    expect(
      core.receive(agent.id, "late", "discarded", "first"),
    ).toBeUndefined();
  });
  it("preserves query-based conversation identities", () => {
    const core = tasks();
    const a = core.connectChat(
      "first",
      "actor",
      "https://example.com/?chat=one",
    );
    const b = core.connectChat(
      "second",
      "actor",
      "https://example.com/?chat=two",
    );
    expect(a.conversation).not.toBe(b.conversation);
  });
  it("blocks another send while a submitted message is still waiting for its assistant reply", () => {
    const core = tasks();
    const actor = core.connectChat("first", "actor", "https://chatgpt.com/c/a");
    actor.connected = true;
    const watcher = core.connectChat(
      "first",
      "watcher",
      "https://chatgpt.com/c/w",
    );
    watcher.connected = true;
    core.delivery(core.send(watcher.id, "Start the task").id, "submitted");
    const message = core.send(actor.id, "one message");
    core.delivery(message.id, "submitted");
    actor.awaitingResponse = true;
    expect(() =>
      core.send(actor.id, "do not replace the pending delivery"),
    ).toThrow("previous assistant response");
    expect(core.state.messages).toHaveLength(2);
  });
  it("makes older unassigned messages visible in an imported task", () => {
    const core = tasks();
    core.append({
      sender: "Operator",
      recipient: "operator",
      conversationId: "old",
      type: "operator",
      content: "Older history",
      status: "submitted",
    });
    core.state.messages[0].taskId = undefined;
    migrateTaskChats(core.state);
    expect(
      core.state.tasks.some((task) => task.id === "imported-workspace"),
    ).toBe(true);
    expect(core.state.messages[0].taskId).toBe("imported-workspace");
  });
  it("migrates global connections into tasks without discarding their history", () => {
    const core = tasks();
    const a = core.register({
      name: "Old actor",
      role: "actor",
      provider: "browser",
      conversation: "https://chatgpt.com/c/a",
      lastNumber: 0,
      automation: "old",
    });
    core.receive(a.id, "old", response(1, "actor->operator"));
    migrateTaskChats(core.state);
    expect(core.state.agents[0].taskId).toBe("first");
    expect(core.state.messages[0].content).toContain("RESPONSE NUMBER 1");
    migrateTaskChats(core.state);
    expect(core.state.agents).toHaveLength(1);
  });
});
