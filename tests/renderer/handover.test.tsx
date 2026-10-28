// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ProtocolTools } from "../../apps/desktop/renderer/features/workspace/ProtocolTools";
import { HandoverTransfer } from "../../apps/desktop/renderer/features/messages/HandoverTransfer";
import { ChatURL } from "../../apps/desktop/renderer/features/workspace/ChatURL";
import { makeCore, response } from "../helpers";

const writeText = vi.fn(async (_value: string) => {});
beforeEach(() => {
  writeText.mockClear();
  Reflect.deleteProperty(window, "relay");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(cleanup);

function setup(targetRole?: "actor" | "watcher") {
  const core = makeCore();
  const task = {
    id: "task",
    title: "Current work",
    kind: "feature",
    operatingSystem: "Windows",
    created: "2026-10-27",
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
  core.receive(
    actor.id,
    "actor-started",
    response(1, "actor->watcher", "Actor project work has started."),
  );
  actor.lastNumber = 4;
  core.delivery(core.send(watcher.id, "Start this task.").id, "submitted");
  const request = core.handover(task.id, targetRole);
  core.delivery(request.id, "submitted");
  const report = core.receive(
    watcher.id,
    "handover",
    response(
      1,
      "watcher->operator",
      "HANDOVER PACKET\nVerified implementation, actual tests and remaining work.",
    ),
    task.id,
    request.id,
  );
  return { core, task, actor, watcher, report };
}

it.each([undefined, "actor", "watcher"] as const)(
  "offers the three Watcher-produced handover modes and requests %s without an onboarding form",
  async (targetRole) => {
    const s = setup();
    const perform = vi.fn(async () => true);
    render(
      <ProtocolTools
        task={s.task}
        agents={[s.actor, s.watcher]}
        messages={s.core.state.messages}
        perform={perform}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /onboard/i })).toBeNull();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: targetRole ? `handover for new ${targetRole}` : "handover",
        }),
      ),
    );
    expect(perform).toHaveBeenCalledExactlyOnceWith({
      type: "handover",
      taskId: s.task.id,
      ...(targetRole ? { targetRole } : {}),
    });
    expect(screen.queryByRole("form")).toBeNull();
  },
);

it("disables handovers before task delivery and keeps new-Actor handover disabled until the Actor responds", () => {
  const s = setup();
  s.actor.lastNumber = s.watcher.lastNumber = 0;
  const props = {
    task: s.task,
    agents: [s.actor, s.watcher],
    messages: [],
    perform: vi.fn(async () => true),
  };
  const { rerender } = render(<ProtocolTools {...props} />);
  for (const button of screen.getAllByRole("button"))
    expect((button as HTMLButtonElement).disabled).toBe(true);
  rerender(<ProtocolTools {...props} messages={s.core.state.messages} />);
  expect(
    (screen.getByRole("button", { name: "handover" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "handover for new watcher",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "handover for new actor",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  s.actor.lastNumber = 1;
  rerender(<ProtocolTools {...props} messages={s.core.state.messages} />);
  expect(
    (
      screen.getByRole("button", {
        name: "handover for new actor",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it.each(["actor", "watcher"] as const)(
  "copies the exact protocol with the %s briefing and continued counter",
  async (role) => {
    const s = setup(role);
    render(
      <HandoverTransfer
        state={s.core.state}
        report={s.report}
        taskId={s.task.id}
      />,
    );
    const preview = screen.getByLabelText(
      "Complete handover packet",
    ) as HTMLTextAreaElement;
    expect(preview.value).toContain(
      s.core.state.instructions.text.replace(/\r\n?/g, "\n"),
    );
    expect(preview.value).toContain(s.report.content);
    expect(preview.value).toContain(`Target role: ${role}`);
    expect(preview.value).toContain(
      `From now on you are the ${role === "actor" ? "Actor" : "Watcher"}`,
    );
    expect(preview.value).toContain("What RESPONSE NUMBER means");
    expect(preview.value).toContain(
      `Your first actual project reply AFTER the next Relay message must be RESPONSE NUMBER ${role === "actor" ? 5 : 2}`,
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Copy complete handover" }),
      ),
    );
    expect(writeText.mock.calls.at(-1)![0]).toContain(
      s.core.state.instructions.text,
    );
    expect(writeText.mock.calls.at(-1)![0].replace(/\r\n?/g, "\n")).toBe(
      preview.value,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.getByText(
        new RegExp(
          `paste the new URL into ${role === "actor" ? "Actor" : "Watcher"} Chat URL`,
        ),
      ),
    ).toBeTruthy();
  },
);

it("copies a project-only handover without adding agent.md or assigning a new role", async () => {
  const s = setup();
  render(
    <HandoverTransfer
      state={s.core.state}
      report={s.report}
      taskId={s.task.id}
    />,
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Copy complete handover" }),
    ),
  );
  const text = writeText.mock.calls.at(-1)![0];
  expect(text).toContain(s.report.content);
  expect(text).not.toContain(s.core.state.instructions.text);
  expect(text).not.toContain("Target role:");
  expect(text).not.toContain("From now on you are");
});

it.each(["actor", "watcher"] as const)(
  "allows changing the connected %s URL manually",
  async (role) => {
    const s = setup();
    const perform = vi.fn(async () => true);
    render(
      <ChatURL
        task={s.task}
        role={role}
        agent={role === "actor" ? s.actor : s.watcher}
        perform={perform}
      />,
    );
    const field = screen.getByLabelText(
      `${role === "actor" ? "Actor" : "Watcher"} Chat URL`,
    ) as HTMLInputElement;
    expect(field.readOnly).toBe(false);
    fireEvent.change(field, {
      target: { value: "https://chatgpt.com/c/manual-new" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" })),
    );
    expect(perform).toHaveBeenCalledWith({
      type: "connectChat",
      taskId: s.task.id,
      role,
      url: "https://chatgpt.com/c/manual-new",
    });
  },
);
