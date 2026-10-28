// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MessageContent } from "../../apps/desktop/renderer/features/messages/MessageContent";
import { CodeBlock } from "../../apps/desktop/renderer/features/messages/CodeBlock";
import { ResponseView } from "../../apps/desktop/renderer/features/messages/ResponseView";
import { ResponseBatch } from "../../apps/desktop/renderer/features/messages/ResponseBatch";
import { makeCore, register, response } from "../helpers";
import { executionResult } from "../../packages/shared/executions";
import { directoryMismatchIssue } from "../../packages/shared/executions";
import type { Run } from "../../packages/shared/types";
import { documentationCapture } from "../capture-fixture";

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  writeText.mockClear();
  Reflect.deleteProperty(window, "relay");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(cleanup);

it("offers a saved-chat code refresh for a hidden documentation batch and then exposes Execute without running it", async () => {
  const s = documentationCapture();
  const perform = vi.fn(async () => true);
  const send = vi.fn();
  const view = () => (
    <ResponseView
      message={s.review}
      agents={s.core.state.agents}
      batches={s.core.state.batches}
      perform={perform}
      send={send}
      requiredReply={s.review}
    />
  );
  const { rerender, container } = render(view());
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh captured code" }),
    ),
  );
  expect(perform).toHaveBeenCalledExactlyOnceWith({
    type: "refreshCapturedCode",
    messageId: s.review.id,
  });
  expect(send).not.toHaveBeenCalled();
  s.core.refreshCapturedCode(s.review.id, s.captures);
  rerender(view());
  expect(
    screen.queryByRole("button", { name: "Refresh captured code" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Execute command" })).toBeTruthy();
  expect(container.querySelector("code.language-powershell")!.textContent).toBe(
    `${s.command}\n`,
  );
  expect(s.core.state.runs).toEqual([]);
  expect(perform).toHaveBeenCalledTimes(1);
});

it("rechecks a saved blocked approval locally without executing or sending another AI message", async () => {
  const core = makeCore();
  const actor = register(core, "actor");
  const watcher = register(core, "watcher");
  actor.briefed = true;
  const block =
    "```powershell\nclear\nWrite-Output 'print(\"hello pesar\")'\n```";
  core.receive(
    actor.id,
    "first",
    response(1, "actor->watcher", `Working directory: C:\\Projects\n${block}`),
  );
  const corrected = core.receive(
    actor.id,
    "second",
    response(
      2,
      "actor->watcher",
      `Working directory: C:\\Projects\\a\n${block}`,
    ),
  );
  core.delivery(
    core.send(watcher.id, corrected.content, corrected.id).id,
    "submitted",
  );
  const batches = structuredClone(core.state.batches);
  const approved = core.receive(
    watcher.id,
    "approval",
    response(
      1,
      "watcher->operator",
      `APPROVED\nWorking directory: C:\\Projects\\a\n${block}\nq1: Return output.`,
    ),
  );
  core.state.batches = batches;
  approved.parsed!.issues.push(directoryMismatchIssue);
  const perform = vi.fn(async () => true);
  const { container } = render(
    <ResponseView
      message={approved}
      agents={core.state.agents}
      batches={batches}
      perform={perform}
      send={vi.fn()}
      requiredReply={approved}
    />,
  );
  expect(container.querySelector("code.language-powershell")).toBeTruthy();
  expect(container.querySelector("code.language-python")).toBeNull();
  expect(screen.queryByRole("button", { name: "Execute command" })).toBeNull();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck recorded review" }),
    ),
  );
  expect(perform).toHaveBeenCalledExactlyOnceWith({
    type: "recheckReview",
    messageId: approved.id,
  });
  expect(core.state.runs).toEqual([]);
});

it("shows a direct Watcher execution request as addressed to the Operator with copyable PowerShell and an output field", async () => {
  const core = makeCore();
  const actor = register(core, "actor");
  const watcher = register(core, "watcher");
  actor.briefed = true;
  const block =
    "```powershell\nclear\nSet-Content temp.py 'print(\"hello world\")'\npython temp.py\n```";
  core.receive(actor.id, "proposal", response(1, "actor->watcher", block));
  const message = core.receive(
    watcher.id,
    "approved",
    response(
      1,
      "watcher->operator",
      `APPROVED\nWorking directory: ${process.cwd()}\n${block}\nq1: Run the approved code in Windows PowerShell and paste its output.`,
    ),
  );
  const perform = vi.fn(async () => true);
  render(
    <ResponseView
      message={message}
      agents={core.state.agents}
      batches={core.state.batches}
      runs={[]}
      send={vi.fn()}
      perform={perform}
    />,
  );
  expect(screen.getByText(/You \(Operator\)/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Execute command" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send to Actor" })).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Execute command" })),
  );
  expect(perform).toHaveBeenCalledWith({
    type: "run",
    batchId: core.state.batches[0].id,
    approved: true,
  });
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Copy powershell code" }),
    ),
  );
  expect(writeText).toHaveBeenLastCalledWith(
    "clear\nSet-Content temp.py 'print(\"hello world\")'\npython temp.py\n",
  );
  fireEvent.change(screen.getByLabelText(/q1.*Run the approved code/), {
    target: { value: "hello world\nExit: 0" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" })),
  );
  expect(perform).toHaveBeenCalledWith({
    type: "send",
    agentId: watcher.id,
    content: "q1: hello world\nExit: 0",
    replyToId: message.id,
  });
});

it("provides a terminal-output answer field if an approved Operator batch omits the numbered question", async () => {
  const core = makeCore();
  const actor = register(core, "actor");
  const watcher = register(core, "watcher");
  actor.briefed = true;
  const block = "```bash\nclear\npwd\n```";
  core.receive(actor.id, "proposal", response(1, "actor->watcher", block));
  const message = core.receive(
    watcher.id,
    "approved",
    response(1, "watcher->operator", `APPROVED\n${block}`),
  );
  const perform = vi.fn(async () => true);
  render(
    <ResponseView
      message={message}
      agents={core.state.agents}
      batches={core.state.batches}
      send={vi.fn()}
      perform={perform}
    />,
  );
  fireEvent.change(screen.getByLabelText(/q1.*Please run the approved batch/), {
    target: { value: "/c/project\nExit: 0" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" })),
  );
  expect(perform).toHaveBeenCalledWith({
    type: "send",
    agentId: watcher.id,
    content: "q1: /c/project\nExit: 0",
    replyToId: message.id,
  });
  expect(message.parsed!.questions).toEqual([]);
});

it("recovers a legacy Watcher approval by requesting an Operator handoff instead of sending another acknowledgment to the Actor", async () => {
  const core = makeCore();
  const actor = register(core, "actor");
  const watcher = register(core, "watcher");
  actor.briefed = true;
  const block = "```bash\nclear\npwd\n```";
  core.receive(actor.id, "proposal", response(1, "actor->watcher", block));
  const message = core.receive(
    watcher.id,
    "review",
    response(1, "watcher->actor", `APPROVED\n${block}`),
  );
  const perform = vi.fn(async () => true);
  const send = vi.fn();
  render(
    <ResponseView
      message={message}
      agents={core.state.agents}
      batches={core.state.batches}
      send={send}
      perform={perform}
    />,
  );
  expect(screen.queryByRole("button", { name: "Send to Actor" })).toBeNull();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Request execution instructions" }),
    ),
  );
  expect(perform).toHaveBeenCalledWith({
    type: "send",
    agentId: watcher.id,
    content: expect.stringContaining(
      "Your next response must use watcher->operator",
    ),
  });
  expect(perform).toHaveBeenCalledWith({
    type: "send",
    agentId: watcher.id,
    content: expect.stringContaining(block),
  });
  expect(send).not.toHaveBeenCalled();
  expect(core.state.batches[0].state).toBe("reviewed");
});

it("copies the exact Bash from collapsed Summary and executes only its eligible recorded batch", async () => {
  const core = makeCore();
  const watcher = register(core, "watcher");
  const code = "clear\r\npwd\r\ngit status --short\r\n";
  const message = core.receive(
    watcher.id,
    "inspection",
    `RESPONSE NUMBER 1 | watcher->operator\r\nDetails hidden by default.\r\nWorking directory: ${process.cwd()}\r\n\`\`\`bash\r\n${code}\`\`\`\r\nSummary: Inspect the project.`,
  );
  const perform = vi.fn(async () => true);
  const { container } = render(
    <ResponseView
      message={message}
      agents={[watcher]}
      batches={core.state.batches}
      runs={core.state.runs}
      perform={perform}
      send={vi.fn()}
    />,
  );
  expect(container.querySelector(".summary .code-block")).toBeTruthy();
  expect(screen.queryByText(/Details hidden by default/)).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy bash code" })),
  );
  expect(writeText).toHaveBeenCalledWith(code);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Execute command" })),
  );
  expect(perform).toHaveBeenCalledWith({
    type: "run",
    batchId: core.state.batches[0].id,
    approved: true,
  });
});

it("does not offer execution for an unreviewed, running, or previously executed batch", () => {
  const core = makeCore();
  const watcher = register(core, "watcher");
  core.receive(
    watcher.id,
    "inspection",
    response(1, "watcher->operator", "```bash\nclear\npwd\n```"),
  );
  const batch = core.state.batches[0];
  for (const state of [
    "proposed",
    "reviewed",
    "running",
    "executed",
    "rejected",
  ] as const) {
    batch.state = state;
    const view = render(
      <ResponseBatch
        batch={batch}
        command={batch.command}
        anyRunning={false}
        perform={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Execute command" }),
    ).toBeNull();
    view.unmount();
  }
  batch.state = "ready";
  render(
    <ResponseBatch
      batch={batch}
      command={batch.command}
      anyRunning
      perform={vi.fn()}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Execute command",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("uses the desktop clipboard without requesting browser clipboard permissions", async () => {
  const nativeCopy = vi.fn(async (_text: string) => {});
  window.relay = {
    copy: nativeCopy,
    invoke: vi.fn(),
    subscribe: () => () => {},
  };
  render(<CodeBlock code={"clear\npwd"} language="bash" />);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy bash code" })),
  );
  expect(nativeCopy).toHaveBeenCalledWith("clear\npwd");
  expect(writeText).not.toHaveBeenCalled();
});

it("copies only the selected block with exact whitespace and original line endings", async () => {
  const bash = "clear\r\nprintf '%s\\n' 'Hello, World!'\r\n\r\n";
  const python = 'print("Hello, World!")\n';
  const { container } = render(
    <MessageContent
      content={`Before\r\n\`\`\`bash\r\n${bash}\`\`\`\r\nBetween\n\`\`\`python\n${python}\`\`\`\nAfter`}
    />,
  );
  expect(container.querySelectorAll(".code-block")).toHaveLength(2);
  expect(container.querySelector(".hljs-built_in")).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy bash code" })),
  );
  expect(writeText).toHaveBeenLastCalledWith(bash);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy python code" })),
  );
  expect(writeText).toHaveBeenLastCalledWith(python);
  expect(screen.getAllByText("Copied")).toHaveLength(2);
  expect(container.textContent).toContain("After");
});

it("keeps nested fences inside longer code fences and safely renders unfamiliar languages", async () => {
  const raw = "```bash\nclear\npwd\n```\n<script>alert('x')</script>\n";
  const { container } = render(
    <MessageContent content={`\`\`\`\`unknown\n${raw}\`\`\`\`\nDone`} />,
  );
  expect(container.querySelectorAll(".code-block")).toHaveLength(1);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("code")!.textContent).toBe(raw);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy unknown code" })),
  );
  expect(writeText).toHaveBeenCalledWith(raw);
});

it("escapes HTML while highlighting instead of creating executable page elements", () => {
  const code = '<img src="x" onerror="alert(1)"><script>alert(2)</script>';
  const { container } = render(<CodeBlock code={code} language="html" />);
  expect(container.querySelector("img,script")).toBeNull();
  expect(container.querySelector("code")!.textContent).toBe(code);
  expect(container.querySelector(".hljs-tag")).toBeTruthy();
});

it("keeps proposed commands visible and copyable while the full agent explanation is collapsed", () => {
  const core = makeCore();
  const actor = register(core, "actor");
  const message = core.receive(
    actor.id,
    "proposal",
    response(
      1,
      "actor->watcher",
      "Long implementation explanation\n```bash\nclear\npwd\n```",
    ),
  );
  const { container } = render(
    <ResponseView
      message={message}
      agents={[actor]}
      send={vi.fn()}
      perform={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Copy bash code" })).toBeTruthy();
  expect(container.querySelector("code")!.textContent).toBe("clear\npwd\n");
  expect(screen.queryByText(/Long implementation explanation/)).toBeNull();
});

it("shows a terminal-results answer field beside copyable code and submits its output to the asking agent", async () => {
  const core = makeCore();
  const watcher = register(core, "watcher");
  const content = response(
    1,
    "watcher->operator",
    "RUN ON GIT BASH (Windows):\n```bash\nclear\npwd\ngit status --short\n```\nq1: Please paste stdout, stderr, and the exit code from the Bash batch above.",
  );
  const message = core.receive(watcher.id, "inspection", content);
  const perform = vi.fn(async () => true);
  render(
    <ResponseView
      message={message}
      agents={[watcher]}
      send={vi.fn()}
      perform={perform}
    />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy bash code" })),
  );
  expect(writeText).toHaveBeenLastCalledWith(
    "clear\npwd\ngit status --short\n",
  );
  const output = "STDOUT:\n/c/project\n M main.py\nSTDERR: (empty)\nEXIT: 0";
  fireEvent.change(screen.getByLabelText(/q1.*Please paste stdout/), {
    target: { value: output },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" })),
  );
  expect(perform).toHaveBeenCalledWith({
    type: "send",
    agentId: watcher.id,
    content: `q1: ${output}`,
    replyToId: message.id,
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy full text" })),
  );
  expect(writeText).toHaveBeenLastCalledWith(content);
  expect(message.content).toBe(content);
});

it("keeps execution output and return-evidence controls beside the approved message, including expanded text", async () => {
  const core = makeCore();
  const watcher = register(core, "watcher");
  const message = core.receive(
    watcher.id,
    "inspection",
    response(1, "watcher->operator", "```bash\nclear\npwd\n```"),
  );
  const batch = core.state.batches[0];
  batch.state = "executed";
  const run = {
    id: "run",
    batchId: batch.id,
    agentId: watcher.id,
    command: batch.command,
    cwd: "/project",
    started: "2026-10-25",
    finished: "2026-10-25",
    stdout: "/project\n",
    stderr: "",
    exitCode: 0,
    status: "completed" as const,
    truncated: false,
    logPath: "internal",
  };
  const perform = vi.fn(async () => true);
  render(
    <ResponseView
      message={message}
      agents={[watcher]}
      batches={[batch]}
      runs={[run]}
      send={vi.fn()}
      perform={perform}
    />,
  );
  expect(screen.getByText("Standard output")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show complete text" }));
  expect(screen.getByText("Standard output")).toBeTruthy();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Return evidence to watcher" }),
    ),
  );
  expect(perform).toHaveBeenCalledWith({ type: "returnRun", runId: run.id });
});

it.each([
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
] as const)(
  "fills only the first output answer after a %s run finishes and keeps toolbar controls when expanded",
  async (status) => {
    const core = makeCore();
    const watcher = register(core, "watcher");
    const message = core.receive(
      watcher.id,
      "inspection",
      response(
        1,
        "watcher->operator",
        `Working directory: ${process.cwd()}\n\`\`\`powershell\nclear\nGet-Location\n\`\`\`\nq1: Paste the command output.\nq2: Any other observations?`,
      ),
    );
    const batch = core.state.batches[0];
    const perform = vi.fn(async () => true);
    const run: Run = {
      id: "actual-run",
      batchId: batch.id,
      agentId: watcher.id,
      command: batch.command,
      cwd: process.cwd(),
      started: "2026-10-26",
      stdout: "actual output\n",
      stderr: "actual error\n",
      exitCode: null,
      status: "running",
      truncated: false,
      logPath: "logs/actual",
    };
    const props = {
      message,
      agents: core.state.agents,
      batches: [batch],
      perform,
      send: vi.fn(),
    };
    const view = render(<ResponseView {...props} runs={[run]} anyRunning />);
    fireEvent.change(screen.getByLabelText(/q2/), {
      target: { value: "Keep my answer" },
    });
    expect((screen.getByLabelText(/q1/) as HTMLTextAreaElement).value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Copy result" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Cancellation can be signalled before the child closes and its final output arrives.
    const stopping = { ...run, status };
    view.rerender(<ResponseView {...props} runs={[stopping]} anyRunning />);
    expect((screen.getByLabelText(/q1/) as HTMLTextAreaElement).value).toBe("");
    const finished = {
      ...stopping,
      exitCode: status === "completed" ? 0 : 7,
      finished: "2026-10-26",
      truncated: status === "timeout",
    };
    batch.state = "executed";
    view.rerender(<ResponseView {...props} runs={[finished]} />);
    const result = executionResult(finished);
    expect((screen.getByLabelText(/q1/) as HTMLTextAreaElement).value).toBe(
      result,
    );
    expect((screen.getByLabelText(/q2/) as HTMLTextAreaElement).value).toBe(
      "Keep my answer",
    );
    expect(perform).not.toHaveBeenCalled();
    const toolbar = view.container.querySelector(".summary .code-toolbar")!;
    expect(toolbar.textContent).toContain("Copy code");
    expect(toolbar.textContent).toContain("Copy result");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy result" })),
    );
    expect(writeText).toHaveBeenLastCalledWith(result);
    fireEvent.click(screen.getByRole("button", { name: "Show complete text" }));
    expect(screen.getByRole("button", { name: "Copy result" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/q1/), {
      target: { value: "Reviewed output" },
    });
    view.rerender(<ResponseView {...props} runs={[{ ...finished }]} />);
    expect((screen.getByLabelText(/q1/) as HTMLTextAreaElement).value).toBe(
      "Reviewed output",
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Submit Answers" })),
    );
    expect(perform).toHaveBeenCalledExactlyOnceWith({
      type: "send",
      agentId: watcher.id,
      content: "q1: Reviewed output\n\nq2: Keep my answer",
      replyToId: message.id,
    });
  },
);

it("does not run without a confirmed directory or while the task is blocked", () => {
  const core = makeCore();
  const watcher = register(core, "watcher");
  const message = core.receive(
    watcher.id,
    "inspection",
    response(1, "watcher->operator", "```bash\nclear\npwd\n```"),
  );
  const perform = vi.fn();
  const props = {
    message,
    agents: core.state.agents,
    batches: core.state.batches,
    perform,
    send: vi.fn(),
  };
  const view = render(<ResponseView {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Execute command" }));
  expect(perform).not.toHaveBeenCalled();
  core.state.batches[0].cwd = process.cwd();
  view.rerender(<ResponseView {...props} blocked />);
  fireEvent.click(screen.getByRole("button", { name: "Execute command" }));
  expect(perform).not.toHaveBeenCalled();
});
