import { expect, it, vi } from "vitest";
import { pendingOperatorReply } from "../../packages/shared/operator-replies";
import type { Role } from "../../packages/shared/types";
import type { Run } from "../../packages/shared/types";
import { makeCore, response } from "../helpers";

function setup(role: Role, questions = false) {
  const core = makeCore();
  for (const id of ["first", "second"])
    core.state.tasks.push({
      id,
      title: id,
      kind: "feature",
      created: new Date().toISOString(),
    });
  core.state.activeTaskId = "first";
  const actor = core.connectChat(
    "first",
    "actor",
    "https://chatgpt.com/c/actor",
  );
  const watcher = core.connectChat(
    "first",
    "watcher",
    "https://chatgpt.com/c/watcher",
  );
  actor.connected = watcher.connected = true;
  core.delivery(core.send(watcher.id, "Start the task").id, "submitted");
  core.transport = vi.fn(() => true);
  const sender = role === "actor" ? actor : watcher;
  const other = role === "actor" ? watcher : actor;
  const request = core.receive(
    sender.id,
    "operator-request",
    response(
      1,
      `${role}->operator`,
      questions
        ? "q1: What should I do next?"
        : "Please confirm the next step.",
    ),
  );
  return { core, actor, watcher, sender, other, request };
}

it.each(["actor", "watcher"] as const)(
  "requires a personal reply to %s before sending to another agent, even without numbered questions",
  (role) => {
    const { core, sender, other, request } = setup(role);
    const before = structuredClone(core.state.messages);
    expect(() => core.send(other.id, "Bypass the question")).toThrow(
      "Your reply",
    );
    expect(() => core.send(sender.id, " ")).toThrow("empty");
    expect(core.state.messages).toEqual(before);
    expect(core.transport).not.toHaveBeenCalled();
    const answer = core.send(sender.id, "Here is my answer");
    expect(answer.replyToId).toBe(request.id);
    expect(pendingOperatorReply(core.state, "first")?.id).toBe(request.id);
    core.delivery(answer.id, "submitted");
    expect(pendingOperatorReply(core.state, "first")).toBeUndefined();
    expect(core.send(other.id, "Continue").agentId).toBe(other.id);
  },
);

it.each(["failed", "uncertain"] as const)(
  "keeps the reply requirement after %s delivery and survives a restart",
  (status) => {
    const { core, sender, other, request } = setup("actor", true);
    const answer = core.send(sender.id, "My answer");
    core.delivery(answer.id, status);
    core.recover();
    sender.connected = other.connected = true;
    expect(pendingOperatorReply(core.state, "first")?.id).toBe(request.id);
    expect(() => core.send(other.id, "Continue anyway")).toThrow("Your reply");
    if (status === "failed") {
      core.retry(answer.id);
      const retry = core.state.messages.at(-1)!;
      expect(retry.replyToId).toBe(request.id);
      core.delivery(retry.id, "submitted");
    } else core.delivery(answer.id, "submitted");
    expect(pendingOperatorReply(core.state, "first")).toBeUndefined();
  },
);

it("handles multiple Operator requests in order without accepting an answer to a later question", () => {
  const { core, sender, other, request } = setup("watcher");
  const next = core.receive(
    other.id,
    "second-request",
    response(1, "actor->operator", "q1: A second question?"),
  );
  expect(() =>
    core.send(other.id, "Second answer", undefined, "operator", {
      replyToId: next.id,
    }),
  ).toThrow("Your reply");
  expect(() =>
    core.send(sender.id, "Wrong question", undefined, "operator", {
      replyToId: next.id,
    }),
  ).toThrow("not the pending");
  core.delivery(
    core.send(sender.id, "First answer", undefined, "operator", {
      replyToId: request.id,
    }).id,
    "submitted",
  );
  expect(pendingOperatorReply(core.state, "first")?.id).toBe(next.id);
  expect(() =>
    core.send(sender.id, "Old answer", undefined, "operator", {
      replyToId: request.id,
    }),
  ).toThrow("Your reply");
  core.delivery(
    core.send(other.id, "Second answer", undefined, "operator", {
      replyToId: next.id,
    }).id,
    "submitted",
  );
  expect(pendingOperatorReply(core.state, "first")).toBeUndefined();
  expect(() =>
    core.send(other.id, "Duplicate", undefined, "operator", {
      replyToId: next.id,
    }),
  ).toThrow("not the pending");
});

it("blocks handoffs, task tools, and replacement from bypassing a required answer", () => {
  const { core, sender, other, request } = setup("watcher");
  expect(() => core.send(sender.id, request.content, request.id)).toThrow(
    "Your reply",
  );
  expect(() => core.handover("first")).toThrow("Your reply");
  expect(() =>
    core.send(sender.id, "Automatic transfer", undefined, "operator", {
      workflow: true,
      purpose: "handover",
    }),
  ).toThrow("Your reply");
  expect(() => core.remove(sender.id)).toThrow("before removing");
  expect(() => core.remove(other.id)).toThrow("before removing");
  const old = core.append(
    {
      agentId: other.id,
      conversationId: other.conversation,
      sender: "Operator",
      recipient: other.id,
      type: "operator",
      content: "Old failed send",
      status: "failed",
    },
    "first",
  );
  expect(() => core.retry(old.id)).toThrow("before retrying");
});

it("keeps reply requirements isolated by task and recognizes already answered legacy history", () => {
  const { core, sender, request } = setup("actor");
  core.state.activeTaskId = "second";
  const watcher = core.connectChat(
    "second",
    "watcher",
    "https://chatgpt.com/c/second-watcher",
  );
  watcher.connected = true;
  expect(core.send(watcher.id, "Start another task").agentId).toBe(watcher.id);
  expect(pendingOperatorReply(core.state, "first")?.id).toBe(request.id);
  core.state.activeTaskId = "first";
  const answer = core.send(sender.id, "Historical answer");
  delete answer.replyToId;
  core.delivery(answer.id, "submitted");
  expect(pendingOperatorReply(core.state, "first")).toBeUndefined();
});

it("does not let an old command result or an unfinished cancellation resolve another Operator request", () => {
  const { core, sender, request } = setup("watcher");
  core.state.batches.push({
    id: "old-batch",
    requesterId: sender.id,
    proposalId: "old",
    forwardedId: "old-request",
    command: "clear\npwd",
    state: "executed",
    inspection: true,
  });
  const run: Run = {
    id: "old-run",
    batchId: "old-batch",
    agentId: sender.id,
    taskId: "first",
    command: "clear\npwd",
    cwd: "workspace",
    started: "2026-10-26",
    finished: "2026-10-26",
    stdout: "output",
    stderr: "",
    exitCode: 0,
    status: "completed",
    truncated: false,
    logPath: "unused",
  };
  expect(() => core.returnRun(run)).toThrow("older run");
  expect(() => core.returnRun({ ...run, taskId: undefined })).toThrow(
    "older run",
  );
  core.state.batches[0].forwardedId = request.id;
  const closing = { ...run, finished: undefined, status: "cancelled" as const };
  expect(() => core.returnRun(closing)).toThrow("Wait for execution");
  const answer = core.returnRun(run);
  expect(answer.replyToId).toBe(request.id);
  expect(pendingOperatorReply(core.state, "first")?.id).toBe(request.id);
  core.delivery(answer.id, "submitted");
  expect(pendingOperatorReply(core.state, "first")).toBeUndefined();
});
