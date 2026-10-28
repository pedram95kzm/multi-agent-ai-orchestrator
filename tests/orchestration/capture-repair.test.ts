import { describe, expect, it } from "vitest";
import { documentationCapture } from "../capture-fixture";
import { response } from "../helpers";
import { policy } from "../../packages/orchestration/execution-policy";

describe("read-only recapture of collapsed reference fences", () => {
  it("restores only the exactly delivered proposal and approval, preserving original captures and counters without executing or sending", () => {
    const s = documentationCapture();
    expect(s.proposal.parsed!.batches).toEqual([]);
    expect(s.review.parsed!.batches).toEqual([]);
    const before = structuredClone(s.core.state);
    s.core.recover();
    expect(s.core.state.batches).toEqual([]);
    let sends = 0;
    s.core.transport = () => {
      sends++;
      return true;
    };
    const batch = s.core.refreshCapturedCode(s.review.id, s.captures);
    expect(batch).toMatchObject({
      command: s.command,
      shell: "powershell",
      state: "ready",
      proposalId: s.proposal.id,
      reviewId: s.review.id,
      forwardedId: s.review.id,
      cwd: "C:\\Projects\\a",
    });
    expect(s.proposal.content).toBe(s.captures.actor);
    expect(s.review.content).toBe(s.captures.watcher);
    expect(s.proposal.originalCapture).toBe(
      before.messages.find((message) => message.id === s.proposal.id)!.content,
    );
    expect(s.review.originalCapture).toBe(
      before.messages.find((message) => message.id === s.review.id)!.content,
    );
    expect(s.core.state.agents.map((agent) => agent.lastNumber)).toEqual(
      before.agents.map((agent) => agent.lastNumber),
    );
    expect(s.core.state.messages).toHaveLength(before.messages.length);
    expect(s.core.state.instructions).toEqual(before.instructions);
    expect(s.core.state.runs).toEqual([]);
    expect(sends).toBe(0);
    expect(() => policy(batch, false)).toThrow("approval");
    expect(() => s.core.refreshCapturedCode(s.review.id, s.captures)).toThrow();
  });

  it.each([
    "different task",
    "retired actor",
    "stale proposal",
    "uncertain proposal delivery",
    "uncertain briefing",
    "edited command",
    "edited reference",
    "changed shell",
    "changed directory",
    "wrong counter",
    "wrong role",
    "old extension",
    "pending reply",
    "existing batch",
    "unrelated reviewed duplicate",
  ])("rejects %s without partial mutation", (problem) => {
    const s = documentationCapture();
    if (problem === "different task") s.core.state.activeTaskId = "other";
    if (problem === "retired actor")
      s.core.state.agents = s.core.state.agents.filter(
        (agent) => agent.id !== s.actor.id,
      );
    if (problem === "stale proposal")
      s.core.receive(
        s.actor.id,
        "later",
        response(2, "actor->watcher", "New proposal."),
        "docs",
      );
    if (problem === "uncertain proposal delivery")
      s.delivery.status = "uncertain";
    if (problem === "uncertain briefing")
      s.briefingDelivery.status = "uncertain";
    if (problem === "edited command")
      s.captures.watcher = s.captures.watcher.replace(
        "Get-Content -LiteralPath",
        "Get-Item -LiteralPath",
      );
    if (problem === "edited reference")
      s.captures.actor = s.captures.actor.replace("# Project", "# Changed");
    if (problem === "changed shell")
      s.captures.watcher = s.captures.watcher.replace(
        "````powershell\nclear",
        "````bash\nclear",
      );
    if (problem === "changed directory")
      s.captures.watcher = s.captures.watcher.replace(
        "C:\\Projects\\a",
        "C:\\Projects\\other",
      );
    if (problem === "wrong counter")
      s.captures.watcher = s.captures.watcher.replace("NUMBER 2", "NUMBER 3");
    if (problem === "wrong role")
      s.captures.actor = s.captures.actor.replace(
        "actor->watcher",
        "watcher->actor",
      );
    if (problem === "old extension") s.captures.watcher = s.review.content;
    if (problem === "pending reply") s.watcher.awaitingResponse = true;
    if (problem === "existing batch")
      s.core.state.batches.push({
        id: "other",
        proposalId: s.proposal.id,
        requesterId: s.actor.id,
        command: s.command,
        state: "proposed",
        inspection: false,
      });
    if (problem === "unrelated reviewed duplicate") {
      s.core.state.messages.splice(
        s.core.state.messages.indexOf(s.proposal),
        0,
        {
          ...s.proposal,
          id: "other-proposal",
          sequence: s.proposal.sequence - 1,
        },
      );
      s.core.state.batches.push({
        id: "other-review",
        proposalId: "other-proposal",
        reviewId: s.review.id,
        requesterId: s.actor.id,
        command: s.command,
        shell: "powershell",
        cwd: "C:\\Projects\\a",
        state: "reviewed",
        inspection: false,
      });
      // This duplicate points to another review by the same Watcher.
      const duplicate = { ...s.review, id: "other-review-message" };
      s.core.state.messages.splice(
        s.core.state.messages.indexOf(s.review),
        0,
        duplicate,
      );
      s.core.state.batches.at(-1)!.reviewId = duplicate.id;
    }
    const before = structuredClone(s.core.state);
    expect(() => s.core.refreshCapturedCode(s.review.id, s.captures)).toThrow();
    expect(s.core.state).toEqual(before);
  });
});
