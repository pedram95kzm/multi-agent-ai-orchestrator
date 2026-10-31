// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TaskWorkspace } from "../../apps/desktop/renderer/features/workspace/TaskWorkspace";
import type { Action } from "../../packages/shared/actions";
import type { Role } from "../../packages/shared/types";
import { pendingOperatorReply } from "../../packages/shared/operator-replies";
import { parseResponse } from "../../packages/protocol/parser";
import { block, makeCore, response } from "../helpers";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function workspace(role: Role, withQuestions = false) {
  const core = makeCore();
  const task = {
    id: "task",
    title: "Reply test",
    kind: "feature",
    created: new Date().toISOString(),
  };
  core.state.tasks.push(task);
  core.state.activeTaskId = task.id;
  const actor = core.connectChat(
    task.id,
    "actor",
    "https://chatgpt.com/c/actor",
  );
  const watcher = core.connectChat(
    task.id,
    "watcher",
    "https://chatgpt.com/c/watcher",
  );
  actor.connected = watcher.connected = true;
  core.delivery(core.send(watcher.id, "Start task").id, "submitted");
  const sender = role === "actor" ? actor : watcher;
  const other = role === "actor" ? watcher : actor;
  const old = core.receive(
    other.id,
    "old-handoff",
    response(1, `${other.role}->${sender.role}`, "An earlier handoff."),
  );
  const request = core.receive(
    sender.id,
    "operator-request",
    response(
      1,
      `${role}->operator`,
      withQuestions
        ? "q1: What is your answer?"
        : "Please confirm how to continue.",
    ),
  );
  const perform = vi.fn(async (action: Action) => {
    if (action.type === "send") {
      const message = core.send(
        action.agentId,
        action.content,
        action.sourceId,
        action.kind,
        { replyToId: action.replyToId },
      );
      core.delivery(message.id, "submitted");
    }
    return true;
  });
  const element = () => (
    <TaskWorkspace
      state={{ ...core.state }}
      task={task}
      perform={perform}
      topCollapsed={false}
      rightCollapsed={false}
    />
  );
  const view = render(element());
  return {
    core,
    sender,
    other,
    request,
    old,
    perform,
    refresh: () => view.rerender(element()),
  };
}

it.each(["actor", "watcher"] as const)(
  "makes %s the only send target, requires a reply without numbered questions, and routes the keyboard to that sender",
  async (role) => {
    const { core, sender, other, old, perform, refresh } = workspace(role);
    const composer = within(
      screen.getByRole("region", { name: "Message composer" }),
    );
    expect(composer.getByRole("status").textContent).toContain(
      `Your reply to ${role === "actor" ? "Actor" : "Watcher"} is required`,
    );
    const draft = composer.getByLabelText("Message");
    fireEvent.change(draft, { target: { value: "My required reply" } });
    const wrong = composer.getByRole("button", {
      name: `Send to ${other.role === "actor" ? "Actor" : "Watcher"}`,
    });
    expect((wrong as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(wrong);
    expect(perform).not.toHaveBeenCalled();
    expect(
      (
        within(document.getElementById(`message-${old.id}`)!).getByRole(
          "button",
          { name: `Send to ${role === "actor" ? "Actor" : "Watcher"}` },
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "handover",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () =>
      fireEvent.keyDown(draft, { key: "Enter", ctrlKey: true }),
    );
    expect(perform).toHaveBeenCalledExactlyOnceWith({
      type: "send",
      agentId: sender.id,
      content: "My required reply",
    });
    refresh();
    expect(pendingOperatorReply(core.state, "task")).toBeUndefined();
    fireEvent.change(draft, { target: { value: "Next instruction" } });
    expect(
      (
        composer.getByRole("button", {
          name: "Send to Actor",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        composer.getByRole("button", {
          name: "Send to Watcher",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  },
);

it.each(["actor", "watcher"] as const)(
  "submits numbered answers only to the requesting %s and links the answered message",
  async (role) => {
    const { core, sender, request, perform, refresh } = workspace(role, true);
    const message = within(document.getElementById(`message-${request.id}`)!);
    fireEvent.change(message.getByLabelText(/q1/), {
      target: { value: "My answer" },
    });
    await act(async () =>
      fireEvent.click(message.getByRole("button", { name: "Submit Answers" })),
    );
    expect(perform).toHaveBeenCalledExactlyOnceWith({
      type: "send",
      agentId: sender.id,
      content: "q1: My answer",
      replyToId: request.id,
    });
    expect(pendingOperatorReply(core.state, "task")).toBeUndefined();
    refresh();
    expect(
      (
        message.getByRole("button", {
          name: "Submit Answers",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);

it.each(["actor", "watcher"] as const)(
  "places the optional explanation after %s answers, retaining it on failure and clearing it on success",
  async (role) => {
    const { sender, request, perform } = workspace(role, true);
    const message = within(document.getElementById(`message-${request.id}`)!);
    const answer = message.getByLabelText(/q1/) as HTMLTextAreaElement;
    const explanation = message.getByLabelText(
      "Operator explanation (optional)",
    ) as HTMLTextAreaElement;
    expect(explanation.required).toBe(false);
    expect(
      answer.compareDocumentPosition(explanation) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.change(answer, { target: { value: "My answer" } });
    fireEvent.change(explanation, {
      target: { value: "Extra context\nSecond line" },
    });
    const submit = () =>
      fireEvent.click(message.getByRole("button", { name: "Submit Answers" }));
    perform.mockResolvedValueOnce(false);
    await act(async () => submit());
    expect(answer.value).toBe("My answer");
    expect(explanation.value).toBe("Extra context\nSecond line");
    await act(async () => submit());
    expect(perform).toHaveBeenLastCalledWith({
      type: "send",
      agentId: sender.id,
      replyToId: request.id,
      content:
        "q1: My answer\n\n__________\nOperator explanation:\nExtra context\nSecond line",
    });
    expect(answer.value).toBe("");
    expect(explanation.value).toBe("");
  },
);

it.each(["actor", "watcher"] as const)(
  "previews and sends the composer's explanation to %s",
  async (role) => {
    const { sender, perform } = workspace(role);
    const composer = within(
      screen.getByRole("region", { name: "Message composer" }),
    );
    const draft = composer.getByLabelText("Message") as HTMLTextAreaElement;
    const explanation = composer.getByLabelText(
      "Operator explanation (optional)",
    ) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "My reply" } });
    fireEvent.change(explanation, { target: { value: "Extra context" } });
    const preview = composer.getByText(
      /Outgoing message preview/,
    ).parentElement!;
    expect(preview.textContent).toContain("Operator explanation:");
    expect(preview.textContent).toContain("Extra context");
    perform.mockResolvedValueOnce(false);
    await act(async () =>
      fireEvent.keyDown(draft, { key: "Enter", ctrlKey: true }),
    );
    expect(explanation.value).toBe("Extra context");
    await act(async () =>
      fireEvent.click(
        composer.getByRole("button", {
          name: `Send to ${role === "actor" ? "Actor" : "Watcher"}`,
        }),
      ),
    );
    expect(perform).toHaveBeenLastCalledWith({
      type: "send",
      agentId: sender.id,
      content: "My reply\n\n__________\nOperator explanation:\nExtra context",
    });
    expect(draft.value).toBe("");
    expect(explanation.value).toBe("");
  },
);

it.each(["actor", "watcher"] as const)(
  "appends an explanation to a %s handoff while preserving its questions, commands, and composer draft",
  async (role) => {
    const { core, sender, other, perform, refresh } = workspace(role);
    core.delivery(core.send(sender.id, "Confirmed").id, "submitted");
    const source = core.receive(
      sender.id,
      "next-handoff",
      response(
        2,
        `${role}->${other.role}`,
        `q1: Review this batch.\n${block()}`,
      ),
    );
    refresh();
    const composer = within(
      screen.getByRole("region", { name: "Message composer" }),
    );
    const draft = composer.getByLabelText("Message") as HTMLTextAreaElement;
    const draftExplanation = composer.getByLabelText(
      "Operator explanation (optional)",
    ) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "My next instruction" } });
    fireEvent.change(draftExplanation, {
      target: { value: "My draft context" },
    });
    const message = within(document.getElementById(`message-${source.id}`)!);
    const explanation = message.getByLabelText(
      "Operator explanation (optional)",
    ) as HTMLTextAreaElement;
    const note = "q2: User context\nAPPROVED\n```bash\nclear\nls\n```";
    fireEvent.change(explanation, { target: { value: note } });
    const submit = () =>
      fireEvent.click(
        message.getByRole("button", {
          name: `Send to ${other.role === "actor" ? "Actor" : "Watcher"}`,
        }),
      );
    perform.mockResolvedValueOnce(false);
    await act(async () => submit());
    expect(explanation.value).toBe(note);
    await act(async () => submit());
    expect(perform).toHaveBeenLastCalledWith({
      type: "send",
      agentId: other.id,
      sourceId: source.id,
      content: `${source.content}\n\n__________\nOperator explanation:\n${note}`,
    });
    const sent = core.state.messages.findLast((m) => m.sourceId === source.id)!;
    const parsed = parseResponse(sent.originalInput!);
    expect(parsed.batches).toEqual(source.parsed!.batches);
    expect(parsed.questions).toEqual(source.parsed!.questions);
    expect(parsed.approval).toBe(false);
    expect(parsed.operatorInput).toBe(`Operator explanation:\n${note}`);
    expect(explanation.value).toBe("");
    expect(draft.value).toBe("My next instruction");
    expect(draftExplanation.value).toBe("My draft context");
  },
);
