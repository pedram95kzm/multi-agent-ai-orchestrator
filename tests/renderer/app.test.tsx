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
import { App } from "../../apps/desktop/renderer/App";
import { Settings } from "../../apps/desktop/renderer/features/settings/Settings";
import { ResponseView } from "../../apps/desktop/renderer/features/messages/ResponseView";
import { makeCore, register, response } from "../helpers";
import type { Snapshot } from "../../packages/shared/types";
import type { Action } from "../../packages/shared/actions";
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("keeps only terminal configuration in workspace settings and saves without a global directory", async () => {
  const core = makeCore();
  const perform = vi.fn(async () => true);
  render(<Settings state={core.state} perform={perform} />);
  expect(screen.queryByLabelText("Workspace directory")).toBeNull();
  expect(screen.queryByLabelText("Operator separator")).toBeNull();
  expect(screen.queryByLabelText("Bash executable")).toBeNull();
  expect(screen.queryByLabelText("Policy")).toBeNull();
  expect(screen.queryByLabelText(/Exact allowlist/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Terminal executable"), {
    target: { value: "C:\\PowerShell\\pwsh.exe" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save settings" })),
  );
  expect(perform).toHaveBeenCalledExactlyOnceWith({
    type: "settings",
    settings: {
      shell: "C:\\PowerShell\\pwsh.exe",
      timeoutMs: core.state.settings.timeoutMs,
    },
  });
});
it("keeps the first task readable and exposes the complete attached instructions", () => {
  const c = makeCore(),
    a = register(c, "actor");
  const message = c.send(a.id, "Initialize Git");
  const { container } = render(
    <ResponseView
      message={message}
      agents={[a]}
      send={vi.fn()}
      perform={vi.fn()}
    />,
  );
  expect(screen.getByText("Initialize Git")).toBeTruthy();
  expect(screen.getByText(/Complete agent instructions included/)).toBeTruthy();
  expect(container.textContent).not.toContain(c.state.instructions.text);
  fireEvent.click(screen.getByText("Show complete text"));
  expect(container.textContent).toContain("## 1. Roles");
  expect(container.textContent).toContain("## 14. Final Operating Principles");
  const displayedCode = Array.from(
    container.querySelectorAll(".code-block code"),
  )
    .map((block) => block.textContent)
    .join("\n");
  expect(displayedCode).toContain("find . -maxdepth 2 -type f");
});
it("collapses operator-addressed responses while keeping every answer field visible", () => {
  const c = makeCore(),
    w = register(c, "watcher");
  const m = c.receive(
    w.id,
    "one",
    response(
      1,
      "watcher->operator",
      "Critical full instructions\nq1: Framework?\nq2: Platform?",
    ),
  );
  const { container } = render(
    <ResponseView
      message={m}
      agents={c.state.agents}
      send={vi.fn()}
      perform={vi.fn()}
    />,
  );
  expect(screen.queryByText(/Critical full instructions/)).toBeNull();
  expect(container.querySelectorAll("textarea")).toHaveLength(3);
  expect(screen.getByLabelText(/q1/)).toBeTruthy();
  fireEvent.click(screen.getByText("Show complete text"));
  expect(screen.getByText(/Critical full instructions/)).toBeTruthy();
});
it("highlights only the actual summary, and toggles full content access", () => {
  const c = makeCore(),
    a = register(c, "actor"),
    w = register(c, "watcher");
  const m = c.receive(
    a.id,
    "one",
    response(1, "actor->watcher", "Long original body"),
  );
  render(
    <ResponseView
      message={m}
      agents={[a, w]}
      send={vi.fn()}
      perform={vi.fn()}
    />,
  );
  expect(screen.queryByText(/Long original body/)).toBeNull();
  fireEvent.click(screen.getByText("Show complete text"));
  expect(screen.getByText(/Long original body/)).toBeTruthy();
  fireEvent.click(screen.getByText("Hide complete text"));
  expect(screen.queryByText(/Long original body/)).toBeNull();
});
it("keeps responses with no summary accessible without fabricating one", () => {
  const c = makeCore(),
    a = register(c, "actor");
  const m = c.receive(a.id, "one", "Full plain response");
  render(
    <ResponseView message={m} agents={[a]} send={vi.fn()} perform={vi.fn()} />,
  );
  expect(screen.queryByText("Full plain response")).toBeNull();
  expect(screen.queryByText("AGENT SUMMARY")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show complete text" }));
  expect(screen.getByText("Full plain response")).toBeTruthy();
});
function taskApp(prepare?: (core: ReturnType<typeof makeCore>) => void) {
  const core = makeCore();
  core.state.tasks.push({
    id: "saved",
    kind: "2. Add a feature",
    title: "Saved task",
    created: new Date().toISOString(),
  });
  core.state.activeTaskId = "saved";
  prepare?.(core);
  const invoke = vi.fn(
    async (
      action: Action,
    ): Promise<{ ok: boolean; data?: Snapshot; error?: string }> => {
      if (action.type === "task") {
        core.state.tasks.push({
          id: "new",
          title: action.title,
          kind: action.kind,
          operatingSystem: action.operatingSystem,
          created: new Date().toISOString(),
        });
        core.state.activeTaskId = "new";
      }
      if (action.type === "activateTask")
        core.state.activeTaskId = action.taskId;
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
      return {
        ok: true,
        data: {
          ...core.state,
          chrome: { connected: true, token: "a".repeat(64), port: 19432 },
        },
      };
    },
  );
  window.relay = { invoke, subscribe: () => () => {} };
  render(<App />);
  return { invoke, core };
}
it("starts on task management even when a task was previously active", async () => {
  taskApp();
  expect(
    await screen.findByRole("heading", { name: "Task management" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Actor Chat URL")).toBeNull();
  expect(screen.queryByText("Manual conversation fallback")).toBeNull();
});
it("opens a newly created task with exactly the two chat URL fields", async () => {
  const { invoke } = taskApp();
  fireEvent.change(await screen.findByLabelText("Task title"), {
    target: { value: "New feature" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Create & open task",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Operating system"), {
    target: { value: "Windows" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create & open task" }));
  expect(await screen.findByLabelText("Actor Chat URL")).toBeTruthy();
  expect(screen.getByLabelText("Watcher Chat URL")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "task",
      title: "New feature",
      operatingSystem: "Windows",
    }),
  );
  expect(
    (screen.getByLabelText("Message") as HTMLTextAreaElement).value,
  ).toContain("Operating system: Windows");
  expect(screen.queryByText("Import response")).toBeNull();
});
it("automatically connects a pasted URL to its selected task and role", async () => {
  const { invoke } = taskApp();
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  const input = await screen.findByLabelText("Actor Chat URL");
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: "https://chatgpt.com/c/actor" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(750);
  });
  expect(invoke).toHaveBeenCalledWith({
    type: "connectChat",
    taskId: "saved",
    role: "actor",
    url: "https://chatgpt.com/c/actor",
  });
});
it("offers only explicit Actor and Watcher sends and defaults the shortcut to Watcher", async () => {
  taskApp((core) => {
    core.connectChat(
      "saved",
      "actor",
      "https://chat.deepseek.com/a/chat/s/actor",
    ).connected = true;
    core.connectChat(
      "saved",
      "watcher",
      "https://chat.deepseek.com/a/chat/s/watcher",
    ).connected = true;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  const composer = within(
    await screen.findByRole("region", { name: "Message composer" }),
  );
  expect(
    (
      composer.getByRole("button", {
        name: "Send to Actor",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    composer.getByRole("button", { name: "Send to Watcher" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Message recipient")).toBeNull();
  expect(composer.getByText(/Ctrl \+ Enter sends to watcher/)).toBeTruthy();
});
it("prevents an Actor-only task from sending its first message by button or keyboard", async () => {
  const { invoke } = taskApp((core) => {
    core.connectChat(
      "saved",
      "actor",
      "https://chatgpt.com/c/actor",
    ).connected = true;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  const composer = within(
    await screen.findByRole("region", { name: "Message composer" }),
  );
  const draft = composer.getByLabelText("Message") as HTMLTextAreaElement;
  const original = draft.value;
  fireEvent.click(composer.getByRole("button", { name: "Send to Actor" }));
  await act(async () =>
    fireEvent.keyDown(draft, { key: "Enter", ctrlKey: true }),
  );
  expect(invoke.mock.calls.some(([action]) => action.type === "send")).toBe(
    false,
  );
  expect(draft.value).toBe(original);
});
it("sends a draft to the explicitly chosen role and uses that role for the next keyboard send", async () => {
  const { invoke, core } = taskApp((core) => {
    for (const role of ["actor", "watcher"] as const)
      core.connectChat(
        "saved",
        role,
        `https://chatgpt.com/c/${role}`,
      ).connected = true;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  const composer = within(
    await screen.findByRole("region", { name: "Message composer" }),
  );
  const draft = composer.getByLabelText("Message");
  expect(
    (
      composer.getByRole("button", {
        name: "Send to Actor",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  for (const role of ["watcher", "actor"] as const) {
    fireEvent.change(draft, { target: { value: `Instruction for ${role}` } });
    if (role === "actor")
      expect(
        (
          composer.getByRole("button", {
            name: "Send to Actor",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    await act(async () =>
      fireEvent.click(
        composer.getByRole("button", {
          name: role === "actor" ? "Send to Actor" : "Send to Watcher",
        }),
      ),
    );
    expect(invoke).toHaveBeenLastCalledWith({
      type: "send",
      agentId: core.state.agents.find((agent) => agent.role === role)!.id,
      content: `Instruction for ${role}`,
    });
    expect((draft as HTMLTextAreaElement).value).toBe("");
  }
  fireEvent.change(draft, { target: { value: "Keyboard instruction" } });
  await act(async () =>
    fireEvent.keyDown(draft, { key: "Enter", ctrlKey: true }),
  );
  expect(invoke).toHaveBeenLastCalledWith({
    type: "send",
    agentId: core.state.agents.find((agent) => agent.role === "actor")!.id,
    content: "Keyboard instruction",
  });
});
it("minimizes each workspace panel independently and preserves the draft and URL inputs", async () => {
  taskApp();
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  const draft = (await screen.findByLabelText(
    "Message",
  )) as HTMLTextAreaElement;
  const actorURL = screen.getByLabelText("Actor Chat URL") as HTMLInputElement;
  fireEvent.change(draft, { target: { value: "Keep my draft" } });
  fireEvent.change(actorURL, { target: { value: "https://chatgpt" } });

  fireEvent.click(screen.getByRole("button", { name: "Minimize left panel" }));
  expect(document.querySelector(".app-shell.left-collapsed")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Execution history" }),
  ).toBeNull();
  expect(screen.getByRole("textbox", { name: "Actor Chat URL" })).toBe(
    actorURL,
  );

  fireEvent.click(screen.getByRole("button", { name: "Minimize right panel" }));
  expect(
    screen.queryByRole("complementary", { name: "Task history" }),
  ).toBeNull();
  expect(
    document.querySelector(".workspace-body.right-collapsed"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Minimize top panel" }));
  expect(screen.queryByRole("textbox", { name: "Actor Chat URL" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(draft);
  expect(draft.value).toBe("Keep my draft");

  fireEvent.click(screen.getByRole("button", { name: "Expand top panel" }));
  expect(screen.getByRole("textbox", { name: "Actor Chat URL" })).toBe(
    actorURL,
  );
  expect(actorURL.value).toBe("https://chatgpt");
  expect(
    screen.queryByRole("complementary", { name: "Task history" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand right panel" }));
  expect(
    screen.getByRole("complementary", { name: "Task history" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Expand left panel" }));
  expect(document.querySelector(".app-shell.left-collapsed")).toBeNull();
});
it("remembers panel choices across task navigation and app remounts", async () => {
  taskApp();
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  await screen.findByLabelText("Message");
  for (const side of ["left", "right", "top"])
    fireEvent.click(
      screen.getByRole("button", { name: `Minimize ${side} panel` }),
    );
  fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Open task" }));
  expect(
    await screen.findByRole("button", { name: "Expand top panel" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Actor Chat URL" })).toBeNull();
  cleanup();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  for (const side of ["left", "right", "top"])
    expect(
      await screen.findByRole("button", { name: `Expand ${side} panel` }),
    ).toBeTruthy();
});
it("delivers a complete handoff in one click and preserves the operator's draft", async () => {
  let sourceId = "";
  let watcherId = "";
  const { invoke } = taskApp((core) => {
    const actor = core.connectChat(
      "saved",
      "actor",
      "https://chat.deepseek.com/a/chat/s/actor",
    );
    const watcher = core.connectChat(
      "saved",
      "watcher",
      "https://chat.deepseek.com/a/chat/s/watcher",
    );
    actor.connected = watcher.connected = true;
    watcherId = watcher.id;
    sourceId = core.receive(
      actor.id,
      "live-reply",
      response(1, "actor->watcher", "Complete original reply"),
    ).id;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
  const draft = await screen.findByLabelText("Message");
  fireEvent.change(draft, { target: { value: "My next instruction" } });
  fireEvent.click(
    within(document.getElementById(`message-${sourceId}`)!).getByRole(
      "button",
      { name: "Send to Watcher" },
    ),
  );
  expect(invoke).toHaveBeenCalledWith({
    type: "send",
    agentId: watcherId,
    sourceId,
    content: response(1, "actor->watcher", "Complete original reply"),
  });
  expect((draft as HTMLTextAreaElement).value).toBe("My next instruction");
});
