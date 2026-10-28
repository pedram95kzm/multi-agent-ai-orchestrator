import { legacyCapturedFences } from "../packages/protocol/fences";
import { makeCore, register, response } from "./helpers";

export function documentationCapture() {
  const core = makeCore();
  core.state.tasks.push({
    id: "docs",
    title: "Documentation",
    kind: "feature",
    created: "2026-10-28",
  });
  core.state.activeTaskId = "docs";
  const actor = register(core, "actor");
  const watcher = register(core, "watcher");
  actor.taskId = watcher.taskId = "docs";
  const first = core.send(watcher.id, "Document the project.");
  core.delivery(first.id, "submitted");
  const briefing = core.receive(
    watcher.id,
    "briefing",
    response(1, "watcher->actor", "Propose the documentation batch."),
    "docs",
    first.id,
  );
  const briefingDelivery = core.send(actor.id, briefing.content, briefing.id);
  core.delivery(briefingDelivery.id, "submitted");
  const documentation = [
    "# Project",
    "",
    "```powershell",
    "python .\\hello.py",
    "```",
    "",
    "```text",
    "hello",
    "```",
  ].join("\n");
  const command = [
    "clear",
    "$lines = @(",
    ...documentation.split("\n").map((line) => `    '${line}'`),
    ")",
    "Set-Content -LiteralPath README.md -Value $lines -Encoding UTF8",
    "Get-Content -LiteralPath README.md",
  ].join("\n");
  const body = `File: README.md (reference contents)\n\n\`\`\`\`markdown\n${documentation}\n\`\`\`\`\n\nWorking directory: C:\\Projects\\a\n\n\`\`\`\`powershell\n${command}\n\`\`\`\`\n`;
  const captures = {
    actor: response(1, "actor->watcher", body),
    watcher: response(
      2,
      "watcher->operator",
      `APPROVED\n${body}\nq1: Return the actual output.`,
    ),
  };
  const proposal = core.receive(
    actor.id,
    "proposal",
    legacyCapturedFences(captures.actor),
    "docs",
    briefingDelivery.id,
  );
  const delivery = core.send(watcher.id, proposal.content, proposal.id);
  core.delivery(delivery.id, "submitted");
  const review = core.receive(
    watcher.id,
    "approval",
    legacyCapturedFences(captures.watcher),
    "docs",
    delivery.id,
  );
  return {
    core,
    actor,
    watcher,
    proposal,
    review,
    delivery,
    briefingDelivery,
    captures,
    command,
    documentation,
  };
}
