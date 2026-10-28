import { expect, it, vi } from "vitest";
import { makeCore } from "../helpers";

function setup() {
  const core = makeCore();
  const roles = ["actor", "watcher"] as const;
  for (const taskId of ["first", "second"]) {
    core.state.tasks.push({
      id: taskId,
      title: taskId,
      kind: "feature",
      created: new Date().toISOString(),
    });
    for (const role of roles)
      core.connectChat(
        taskId,
        role,
        `https://chatgpt.com/c/${taskId}-${role}`,
      ).connected = true;
  }
  core.state.activeTaskId = "first";
  const actor = core
    .taskAgents("first")
    .find((agent) => agent.role === "actor")!;
  const watcher = core
    .taskAgents("first")
    .find((agent) => agent.role === "watcher")!;
  core.transport = vi.fn(() => true);
  return { core, actor, watcher };
}

it("rejects an Actor-first send before storing or submitting anything", () => {
  const { core, actor } = setup();
  expect(() => core.send(actor.id, "Start this task")).toThrow(
    "first task message to the Watcher",
  );
  expect(core.state.messages).toEqual([]);
  expect(core.transport).not.toHaveBeenCalled();
});

it.each(["pending", "failed", "uncertain"] as const)(
  "keeps the Actor blocked after a %s Watcher send and unlocks after confirmed delivery",
  (status) => {
    const { core, actor, watcher } = setup();
    const first = core.send(watcher.id, "Start this task");
    if (status !== "pending") core.delivery(first.id, status);
    expect(() => core.send(actor.id, "Continue")).toThrow(
      "first task message to the Watcher",
    );
    expect(core.transport).toHaveBeenCalledTimes(1);
    let confirmed = first;
    if (status === "failed") {
      core.retry(first.id);
      confirmed = core.state.messages.at(-1)!;
    }
    core.delivery(confirmed.id, "submitted");
    expect(core.send(actor.id, "Continue").agentId).toBe(actor.id);
  },
);

it("does not let another task's Watcher delivery unlock a new task", () => {
  const { core, watcher } = setup();
  core.delivery(core.send(watcher.id, "Start first task").id, "submitted");
  core.state.activeTaskId = "second";
  const actor = core
    .taskAgents("second")
    .find((agent) => agent.role === "actor")!;
  expect(() => core.send(actor.id, "Start second task")).toThrow(
    "first task message to the Watcher",
  );
});

it("retains confirmed startup after recovery and Watcher replacement", () => {
  const { core, actor, watcher } = setup();
  core.delivery(core.send(watcher.id, "Start task").id, "submitted");
  core.recover();
  core.remove(watcher.id);
  actor.connected = true;
  expect(core.send(actor.id, "Continue existing task").agentId).toBe(actor.id);
});
