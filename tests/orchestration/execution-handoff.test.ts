import { describe, expect, it } from "vitest";
import { makeCore, register, response } from "../helpers";
import { deliveryRulesVersion } from "../../packages/shared/outgoing";
import { policy } from "../../packages/orchestration/execution-policy";
import { withContextCheck } from "../../packages/shared/context-health";
import { directoryMismatchIssue } from "../../packages/shared/executions";

function proposed(
  shell: "bash" | "powershell" = "bash",
  command = "clear\npwd",
  cwd?: string,
) {
  const core = makeCore();
  const actor = register(core, "actor");
  const watcher = register(core, "watcher");
  const briefing = core.receive(
    watcher.id,
    "brief",
    response(
      1,
      "watcher->actor",
      "Create the requested files, then verify them. Use actor->watcher for your proposal.",
    ),
  );
  core.delivery(
    core.send(actor.id, briefing.content, briefing.id).id,
    "submitted",
  );
  const block = `\`\`\`${shell}\n${command}\n\`\`\``;
  const proposal = core.receive(
    actor.id,
    "proposal",
    response(
      1,
      "actor->watcher",
      `${cwd ? `Working directory: ${cwd}\n` : ""}${block}`,
    ),
  );
  core.delivery(
    core.send(watcher.id, proposal.content, proposal.id).id,
    "submitted",
  );
  return { core, actor, watcher, block, proposal };
}

function directoryCorrection(otherActor = false) {
  const s = proposed("powershell", "clear\nGet-Location", "C:\\Projects");
  const actor = otherActor ? register(s.core, "actor", 2) : s.actor;
  actor.briefed = true;
  const corrected = s.core.receive(
    actor.id,
    "correction",
    response(
      otherActor ? 1 : 2,
      "actor->watcher",
      `Working directory: C:\\Projects\\a\n${s.block}`,
    ),
  );
  const delivery = s.core.send(s.watcher.id, corrected.content, corrected.id);
  s.core.delivery(delivery.id, "submitted");
  const approve = (cwd = "C:\\Projects\\a", block = s.block) =>
    s.core.receive(
      s.watcher.id,
      "approval",
      response(
        2,
        "watcher->operator",
        `APPROVED\nWorking directory: ${cwd}\n${block}\nq1: Return the actual output.`,
      ),
    );
  return { ...s, corrected, delivery, approve };
}

function legacyDirectoryConflict() {
  const s = directoryCorrection();
  const batches = structuredClone(s.core.state.batches);
  const approved = s.approve();
  // Reproduce persisted state from the version that compared both revisions.
  s.core.state.batches = batches;
  approved.parsed!.issues.push(directoryMismatchIssue);
  return { ...s, approved };
}

describe("execution handoff without approval acknowledgment loops", () => {
  it.each([
    "uncertain delivery",
    "older directory",
    "different actor",
    "edited code",
    "different shell",
    "duplicate correction",
  ])("does not resolve a directory correction with %s", (problem) => {
    const s = directoryCorrection(problem === "different actor");
    if (problem === "uncertain delivery") s.delivery.status = "uncertain";
    if (problem === "duplicate correction")
      s.core.receive(
        s.actor.id,
        "third",
        response(
          3,
          "actor->watcher",
          `Working directory: C:\\Projects\\a\n${s.block}`,
        ),
      );
    const block =
      problem === "edited code"
        ? s.block.replace("Get-Location", "Get-ChildItem")
        : problem === "different shell"
          ? s.block.replace("powershell", "bash")
          : s.block;
    const approved = s.approve(
      problem === "older directory" ? "C:\\Projects" : "C:\\Projects\\a",
      block,
    );
    expect(approved.parsed!.issues.length).toBeGreaterThan(0);
    expect(s.core.state.batches.some((batch) => batch.state === "ready")).toBe(
      false,
    );
    expect(
      s.core.state.batches.every((batch) => batch.state === "proposed"),
    ).toBe(true);
    expect(s.core.state.runs).toEqual([]);
  });

  it("rechecks a saved directory conflict only on explicit action, preserving bodies, counters and execution approval", () => {
    const s = legacyDirectoryConflict();
    const bodies = s.core.state.messages.map((message) => message.content);
    const counters = s.core.state.agents.map((agent) => agent.lastNumber);
    s.core.recover();
    expect(
      s.core.state.batches.every((batch) => batch.state === "proposed"),
    ).toBe(true);
    let sends = 0;
    s.core.transport = () => {
      sends++;
      return true;
    };
    const ready = s.core.recheckReview(s.approved.id);
    expect(ready).toMatchObject({
      proposalId: s.corrected.id,
      forwardedId: s.approved.id,
      state: "ready",
      cwd: "C:\\Projects\\a",
    });
    expect(s.approved.parsed!.issues).not.toContain(directoryMismatchIssue);
    expect(
      s.core.state.batches.find((batch) => batch.proposalId === s.proposal.id)
        ?.state,
    ).toBe("rejected");
    expect(s.core.state.messages.map((message) => message.content)).toEqual(
      bodies,
    );
    expect(s.core.state.agents.map((agent) => agent.lastNumber)).toEqual(
      counters,
    );
    expect(s.core.state.runs).toEqual([]);
    expect(sends).toBe(0);
    expect(() => policy(ready, false)).toThrow("approval");
    expect(() => s.core.recheckReview(s.approved.id)).toThrow();
  });

  it.each([
    "stale review",
    "different task",
    "missing approval",
    "edited code",
    "uncertain delivery",
    "future proposal",
  ])("refuses a saved-review recheck with %s", (problem) => {
    const s = legacyDirectoryConflict();
    if (problem === "stale review")
      s.core.receive(
        s.watcher.id,
        "later",
        response(3, "watcher->actor", "A later project message."),
      );
    if (problem === "different task") s.core.state.activeTaskId = "other";
    if (problem === "missing approval")
      s.approved.content = s.approved.content.replace("APPROVED\n", "");
    if (problem === "edited code")
      s.approved.content = s.approved.content.replace(
        "Get-Location",
        "Get-ChildItem",
      );
    if (problem === "uncertain delivery") s.delivery.status = "uncertain";
    if (problem === "future proposal")
      s.corrected.sequence = s.approved.sequence + 1;
    expect(() => s.core.recheckReview(s.approved.id)).toThrow();
    expect(s.core.state.batches.some((batch) => batch.state === "ready")).toBe(
      false,
    );
    expect(s.core.state.runs).toEqual([]);
  });
  it("reviews the delivered directory correction instead of comparing it against the Actor's obsolete proposal", () => {
    const { core, actor, watcher, block, proposal } = proposed(
      "powershell",
      "clear\nGet-Location",
      "C:\\Projects",
    );
    const corrected = core.receive(
      actor.id,
      "corrected-proposal",
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
    const approved = core.receive(
      watcher.id,
      "approve-correction",
      response(
        2,
        "watcher->operator",
        `APPROVED\nWorking directory: C:\\Projects\\a\n${block}\nq1: Return the actual output.`,
      ),
    );
    expect(approved.parsed!.issues).toEqual([]);
    expect(
      core.state.batches.find((batch) => batch.proposalId === proposal.id)
        ?.state,
    ).toBe("rejected");
    expect(
      core.state.batches.find((batch) => batch.proposalId === corrected.id),
    ).toMatchObject({
      state: "ready",
      cwd: "C:\\Projects\\a",
      forwardedId: approved.id,
      reviewId: approved.id,
    });
    expect(core.state.runs).toEqual([]);
  });
  it("preserves the directory confirmed in chat and blocks a forwarded directory change", () => {
    const { core, watcher, block } = proposed();
    core.state.batches[0].cwd = "C:\\Projects\\confirmed";
    const forwarded = core.receive(
      watcher.id,
      "changed-directory",
      response(
        2,
        "watcher->operator",
        `APPROVED\nWorking directory: C:\\Projects\\other\n${block}\nq1: Output?`,
      ),
    );
    expect(core.state.batches[0].state).toBe("proposed");
    expect(core.state.batches[0].cwd).toBe("C:\\Projects\\confirmed");
    expect(forwarded.parsed!.issues.join(" ")).toContain(
      "working directory differs",
    );
  });
  it("takes the forwarding directory from chat when the proposal did not include it", () => {
    const { core, watcher, block } = proposed();
    core.receive(
      watcher.id,
      "confirmed-directory",
      response(
        2,
        "watcher->operator",
        `APPROVED\nWorking directory: ${process.cwd()}\n${block}\nq1: Output?`,
      ),
    );
    expect(core.state.batches[0]).toMatchObject({
      state: "ready",
      cwd: process.cwd(),
    });
  });
  it("makes an exact Actor proposal ready in the Watcher's single approval and Operator execution request", () => {
    const { core, watcher, block } = proposed();
    const forwarded = core.receive(
      watcher.id,
      "approve-and-forward",
      response(
        2,
        "watcher->operator",
        `APPROVED\n${block}\nq1: Please run this approved batch and return stdout, stderr, and the exit code.`,
      ),
    );
    expect(forwarded.parsed!.recipient).toBe("operator");
    expect(forwarded.parsed!.questions).toHaveLength(1);
    expect(forwarded.parsed!.issues).toEqual([]);
    expect(core.state.batches).toHaveLength(1);
    expect(core.state.batches[0]).toMatchObject({
      state: "ready",
      reviewId: forwarded.id,
      forwardedId: forwarded.id,
      inspection: false,
    });
    expect(policy(core.state.batches[0], true)).toBeDefined();
  });

  it("authorizes reviewed PowerShell through the same explicit approval flow", () => {
    const command =
      "clear\nNew-Item -ItemType Directory -Path temp\nSet-Content -Path temp/temp.py -Value 'print(\"hello world\")'\npython -m py_compile temp/temp.py\npython temp/temp.py";
    const { core, watcher, block } = proposed("powershell", command);
    const forwarded = core.receive(
      watcher.id,
      "approve-and-forward",
      response(
        2,
        "watcher->operator",
        `APPROVED\n${block}\nq1: Please run this in Windows PowerShell and return its complete output.`,
      ),
    );
    expect(forwarded.parsed!.batches).toEqual([command]);
    expect(forwarded.parsed!.batchShells).toEqual(["powershell"]);
    expect(core.state.batches[0]).toMatchObject({
      state: "ready",
      shell: "powershell",
      inspection: false,
      command,
    });
    expect(policy(core.state.batches[0], true)).toBeDefined();
    expect(() => policy(core.state.batches[0], false)).toThrow("approval");
    expect(core.state.runs).toEqual([]);
  });

  it.each(["edited commands", "different shell", "missing explicit approval"])(
    "does not authorize a direct Operator handoff with %s",
    (difference) => {
      const { core, watcher, block } = proposed();
      const candidate =
        difference === "edited commands"
          ? block.replace("pwd", "ls")
          : difference === "different shell"
            ? block.replace("bash", "powershell")
            : block;
      const result = core.receive(
        watcher.id,
        "bad-forward",
        response(
          2,
          "watcher->operator",
          `${difference === "missing explicit approval" ? "Looks fine." : "APPROVED"}\n${candidate}\nq1: Return output.`,
        ),
      );
      expect(core.state.batches.every((batch) => batch.state !== "ready")).toBe(
        true,
      );
      expect(result.parsed!.issues.join(" ")).toContain(
        "explicit watcher review",
      );
    },
  );

  it("still accepts an old separate review when the Watcher forwards it directly to the Operator next", () => {
    const { core, watcher, block } = proposed();
    core.receive(
      watcher.id,
      "legacy-approval",
      response(2, "watcher->actor", `APPROVED\n${block}`),
    );
    expect(core.state.batches[0].state).toBe("reviewed");
    const forwarded = core.receive(
      watcher.id,
      "forward-now",
      response(
        3,
        "watcher->operator",
        `APPROVED\n${block}\nq1: Please run the batch and return the output.`,
      ),
    );
    expect(core.state.batches[0]).toMatchObject({
      state: "ready",
      forwardedId: forwarded.id,
    });
    expect(forwarded.parsed!.issues).toEqual([]);
  });

  it("updates delivery rules for existing chats on the next send, preserving original evidence and counters", () => {
    const { core, watcher, proposal } = proposed();
    const previous = core.state.messages.findLast(
      (message) =>
        message.agentId === watcher.id && message.status === "submitted",
    )!;
    previous.deliveryRulesVersion = undefined;
    const evidence = JSON.stringify(core.state.messages);
    const updated = core.send(
      watcher.id,
      "Please continue the pending execution handoff.",
    );
    expect(updated.deliveryRulesVersion).toBe(deliveryRulesVersion);
    expect(updated.content).toContain(
      "Both the Watcher and Actor may request Bash and PowerShell execution",
    );
    expect(updated.content).toContain(
      "There is no Watcher-specific command allowlist.",
    );
    expect(updated.content).toContain(
      "her NEXT response must be watcher->operator",
    );
    expect(updated.content).toContain(
      "q1: Please run the approved batch above",
    );
    expect(updated.content).not.toContain(
      "Wait for the Operator's next message before forwarding",
    );
    expect(updated.content).toContain(
      "Your next response must be RESPONSE NUMBER 2",
    );
    expect(watcher.lastNumber).toBe(1);
    expect(JSON.stringify(core.state.messages.slice(0, -1))).toBe(evidence);
    expect(
      core.state.messages.find((message) => message.id === proposal.id)!
        .content,
    ).toBe(proposal.content);
    core.delivery(updated.id, "submitted");
    expect(core.send(watcher.id, "Follow-up").content).toBe(
      withContextCheck("__________\nFollow-up", watcher),
    );
  });

  it("rejects retired automatic transfer retries without sending another packet", () => {
    const core = makeCore();
    const watcher = register(core, "watcher");
    const failed = core.append({
      agentId: watcher.id,
      sender: "Operator",
      recipient: watcher.id,
      conversationId: watcher.conversation,
      type: "onboarding",
      content: "Old packet: wait for another Operator message.",
      status: "failed",
    });
    const count = core.state.messages.length;
    expect(() => core.retry(failed.id)).toThrow("removed");
    expect(core.state.messages).toHaveLength(count);
    expect(failed.content).toBe(
      "Old packet: wait for another Operator message.",
    );
  });

  it("makes previously hidden saved PowerShell copyable without granting historical execution permission", () => {
    const { core, proposal } = proposed("powershell", "clear\nGet-Location");
    core.state.batches = [];
    proposal.parsed!.batches = [];
    proposal.parsed!.batchShells = undefined;
    core.recover();
    expect(proposal.parsed!.batches).toEqual(["clear\nGet-Location"]);
    expect(proposal.parsed!.batchShells).toEqual(["powershell"]);
    expect(core.state.batches).toEqual([]);
    expect(core.state.runs).toEqual([]);
  });

  it("recovers a legacy untracked PowerShell proposal only when the Watcher explicitly reviews it again", () => {
    const { core, watcher, proposal, block } = proposed(
      "powershell",
      "clear\nGet-Location",
    );
    core.state.batches = [];
    proposal.parsed!.batches = [];
    proposal.parsed!.batchShells = undefined;
    core.recover();
    expect(core.state.batches).toEqual([]);
    core.receive(
      watcher.id,
      "review-again",
      response(
        2,
        "watcher->operator",
        `APPROVED\n${block}\nq1: Run this exact batch in PowerShell and return its output.`,
      ),
    );
    expect(core.state.batches[0]).toMatchObject({
      proposalId: proposal.id,
      state: "ready",
      shell: "powershell",
      inspection: false,
    });
    expect(core.state.runs).toEqual([]);
  });

  it.each(["briefing", "proposal delivery"])(
    "refuses to restore historical PowerShell permission without confirmed %s",
    (missing) => {
      const { core, watcher, actor, block } = proposed(
        "powershell",
        "clear\nGet-Location",
      );
      core.state.batches = [];
      const delivery = core.state.messages.find(
        (message) =>
          message.type !== "response" &&
          message.agentId === (missing === "briefing" ? actor.id : watcher.id),
      )!;
      delivery.status = "uncertain";
      const reply = core.receive(
        watcher.id,
        "review-again",
        response(2, "watcher->operator", `APPROVED\n${block}`),
      );
      expect(core.state.batches).toEqual([]);
      expect(reply.parsed!.issues.join(" ")).toContain(
        "explicit watcher review",
      );
    },
  );
});
