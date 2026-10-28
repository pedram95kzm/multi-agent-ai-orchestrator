import type { BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InstructionFiles } from "../../apps/desktop/electron/InstructionFiles";
import { Store } from "../../packages/orchestration/store";
import { cleanup, makeCore, protocol, temp } from "../helpers";

vi.mock("electron", () => ({ dialog: {}, shell: {} }));

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});
function instructions() {
  const dir = temp();
  const file = join(dir, "agent.md");
  writeFileSync(file, protocol);
  const core = makeCore();
  core.state.instructions.path = file;
  const store = new Store(join(dir, "state.sqlite"));
  const files = new InstructionFiles(core, store);
  disposals.push(
    () => cleanup(dir),
    () => store.close(),
    () => files.close(),
  );
  return { core, file, files };
}

it("backs up and activates valid instructions without rewriting saved conversation evidence", async () => {
  const { core, file, files } = instructions();
  const previous = core.state.instructions.hash;
  core.state.messages.push({
    id: "saved",
    sequence: 1,
    conversationId: "chat",
    sender: "Operator",
    recipient: "watcher",
    type: "operator",
    content: "Saved evidence",
    timestamp: "2026-10-22T00:00:00Z",
    status: "submitted",
    instructionVersion: previous,
  });
  const evidence = structuredClone(core.state.messages);
  const updated = protocol + "\nAdditional context.\n";
  await files.handle(
    { type: "instructions", operation: "save", content: updated },
    {} as BrowserWindow,
  );
  expect(readFileSync(`${file}.bak`, "utf8")).toBe(protocol);
  expect(readFileSync(file, "utf8")).toBe(updated);
  expect(core.state.instructions.text).toBe(updated);
  expect(core.state.instructions.hash).not.toBe(previous);
  expect(core.state.messages).toEqual(evidence);
});

it("keeps the last valid file and instruction version when validation fails", async () => {
  const { core, file, files } = instructions();
  const previous = core.state.instructions.hash;
  await expect(
    files.handle(
      {
        type: "instructions",
        operation: "save",
        content: "Incomplete protocol",
      },
      {} as BrowserWindow,
    ),
  ).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe(protocol);
  expect(core.state.instructions.hash).toBe(previous);
  expect(core.state.instructions.error).toBeTruthy();
});

it("flags changed disk content for review before activating it", () => {
  const { core, file, files } = instructions();
  const previous = core.state.instructions.hash;
  writeFileSync(file, protocol + "\nChanged on disk.\n");
  files.verify();
  expect(core.state.instructions.changed).toBe(true);
  expect(core.state.instructions.hash).toBe(previous);
  expect(core.state.instructions.text).toBe(protocol);
});

it("upgrades only an unchanged shipped default, with a backup and preserved historical evidence", () => {
  const { core, file, files } = instructions();
  const previous = core.state.instructions.hash;
  const updated = protocol + "\nUpdated task tools.\n";
  files.upgradeDefault(updated, [previous]);
  expect(readFileSync(`${file}.before-tools-update.bak`, "utf8")).toBe(
    protocol,
  );
  expect(readFileSync(file, "utf8")).toBe(updated);
  expect(core.state.instructions.text).toBe(updated);
  expect(core.state.instructions.hash).not.toBe(previous);
});

it("preserves customized instructions on disk during a default upgrade", () => {
  const { core, file, files } = instructions();
  const custom = protocol + "\nUser-specific rules.\n";
  writeFileSync(file, custom);
  files.upgradeDefault(protocol + "\nNew default.\n", [
    core.state.instructions.hash,
  ]);
  expect(readFileSync(file, "utf8")).toBe(custom);
  expect(core.state.instructions.text).toBe(protocol);
});
