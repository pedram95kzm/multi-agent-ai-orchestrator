import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../../packages/orchestration/store";
import { validateInstructions } from "../../packages/agent-instructions/instructions";
import { migrateTaskChats } from "../../packages/orchestration/migrate";
import {
  makeCore,
  register,
  protocol,
  temp,
  cleanup,
  response,
} from "../helpers";
describe("durable state and configuration", () => {
  it("clears obsolete packet metadata notices on recovery without changing evidence or authorizing historical commands", () => {
    const core = makeCore();
    const watcher = register(core, "watcher");
    const message = core.receive(
      watcher.id,
      "packet",
      response(
        1,
        "watcher->actor",
        "ONBOARDING PACKET: actor\nWorking directory: /one\nWorking directory: /two\nq1: Historical question.\nq1: Historical example.",
      ),
    );
    message.parsed!.issues = [
      "Conflicting working directories; confirm one directory for the batch.",
      "Ambiguous repeated question IDs; use the composer.",
      "Keep this evidence warning.",
    ];
    message.parsed!.questions = [{ id: "q1", text: "Historical question." }];
    message.parsed!.workingDirectory = "/one";
    const original = message.content;
    core.recover();
    expect(message.parsed!.issues).toEqual(["Keep this evidence warning."]);
    expect(message.parsed!.questions).toEqual([]);
    expect(message.parsed!.workingDirectory).toBeUndefined();
    expect(message.content).toBe(original);
    expect(core.state.batches).toEqual([]);
  });
  it("retires global execution configuration while preserving recorded directories and evidence", () => {
    const core = makeCore();
    core.state.tasks.push({
      id: "saved",
      title: "Saved task",
      kind: "feature",
      created: new Date().toISOString(),
    });
    core.state.activeTaskId = "saved";
    const watcher = register(core, "watcher");
    core.receive(
      watcher.id,
      "directory",
      response(
        1,
        "watcher->operator",
        "Working directory: C:\\Projects\\saved\n```bash\nclear\npwd\n```",
      ),
    );
    Object.assign(core.state.settings, {
      workspace: "C:\\retired",
      separator: "____",
      terminalMode: "restricted",
      allowlist: ["pwd"],
    });
    const evidence = JSON.stringify({
      batches: core.state.batches,
      messages: core.state.messages,
    });
    const { shell, timeoutMs } = core.state.settings;
    migrateTaskChats(core.state);
    expect(core.state.settings).toEqual({ shell, timeoutMs });
    expect(
      JSON.stringify({
        batches: core.state.batches,
        messages: core.state.messages,
      }),
    ).toBe(evidence);
  });
  it("refreshes saved Summary notices without changing original messages, counters, or review evidence", () => {
    const core = makeCore();
    const actor = register(core, "actor");
    const message = core.receive(
      actor.id,
      "saved",
      "RESPONSE NUMBER 1 | actor->watcher\nSummary: Ready.",
    );
    message.parsed!.summary = undefined;
    message.parsed!.issues = [
      "Missing agent-authored Summary section.",
      "Chained && commands violate agent.md.",
      "Keep this review warning.",
    ];
    core.recover();
    expect(message.parsed!.summary).toBe("Ready.");
    expect(message.parsed!.issues).toEqual(["Keep this review warning."]);
    expect(message.content).toBe(
      "RESPONSE NUMBER 1 | actor->watcher\nSummary: Ready.",
    );
    expect(actor.lastNumber).toBe(1);
    expect(core.state.batches).toEqual([]);
  });
  it("restores exact content, supplied counters, and event acknowledgments from SQLite", () => {
    const dir = temp(),
      file = join(dir, "test.sqlite");
    const s = new Store(file),
      c = makeCore(),
      a = register(c, "actor");
    c.receive(a.id, "a", response(1, "actor->watcher"));
    s.save(c.state);
    s.record("event", { ok: true });
    s.close();
    const restored = new Store(file);
    expect(restored.load()?.agents[0].lastNumber).toBe(1);
    expect(restored.load()?.messages[0].content).toBe(
      c.state.messages[0].content,
    );
    expect(restored.event("event")).toEqual({ ok: true });
    restored.close();
    cleanup(dir);
  });
  it("validates protocol versions without changing the previous valid configuration", () => {
    const c = makeCore(),
      old = c.state.instructions.hash;
    expect(() => validateInstructions("# incomplete")).toThrow("Previous");
    expect(c.state.instructions.hash).toBe(old);
    expect(validateInstructions(protocol + "\nComment")).not.toBe(old);
  });
});
