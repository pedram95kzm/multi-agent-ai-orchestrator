import { hash } from "../agent-instructions/instructions";
import type { Agent, AppState, Batch, Message } from "../shared/types";
import { hasBlockingIssues, parseResponse } from "../protocol/parser";
import { directoryMismatchIssue } from "../shared/executions";

function deliveredDirectoryCorrection(
  state: AppState,
  watcher: Agent,
  review: Message,
  candidates: Batch[],
) {
  if (
    candidates.length < 2 ||
    !review.parsed?.approval ||
    review.parsed.recipient !== "operator" ||
    !review.parsed.workingDirectory
  )
    return;
  const matching = candidates.filter(
    (batch) => batch.cwd === review.parsed!.workingDirectory,
  );
  if (matching.length !== 1) return;
  const selected = matching[0];
  const source = state.messages.find(
    (message) => message.id === selected.proposalId,
  );
  if (
    !source ||
    source.captureRejected ||
    !source.parsed ||
    hasBlockingIssues(source.parsed)
  )
    return;
  const parsed = parseResponse(source.content);
  if (
    parsed.sender !== "actor" ||
    parsed.recipient !== "watcher" ||
    parsed.batches.length !== 1 ||
    parsed.batches[0] !== selected.command ||
    parsed.batchShells?.[0] !== (selected.shell ?? "bash") ||
    parsed.workingDirectory !== selected.cwd ||
    hasBlockingIssues(parsed) ||
    !selected.actorId ||
    source.agentId !== selected.actorId ||
    source.sequence >= review.sequence ||
    !candidates.every((batch) => {
      const proposal = state.messages.find(
        (message) => message.id === batch.proposalId,
      );
      return (
        batch.state === "proposed" &&
        batch.actorId === selected.actorId &&
        !!proposal &&
        proposal.taskId === source.taskId &&
        (batch === selected || proposal.sequence < source.sequence)
      );
    })
  )
    return;
  const delivered = state.messages.some(
    (delivery) =>
      delivery.sourceId === source.id &&
      delivery.agentId === watcher.id &&
      delivery.taskId === source.taskId &&
      delivery.conversationId === watcher.conversation &&
      delivery.status === "submitted" &&
      delivery.type !== "response" &&
      delivery.sequence > source.sequence &&
      delivery.sequence < review.sequence &&
      (delivery.originalInput === source.content ||
        delivery.content.includes(source.content)),
  );
  return delivered ? selected : undefined;
}
export function reviewBatch(
  state: AppState,
  agent: Agent,
  message: Message,
  taskId?: string,
  options: { directoryCorrectionOnly?: boolean } = {},
) {
  const parsed = message.parsed;
  if (!parsed || parsed.batches.length !== 1) return;

  const command = parsed.batches[0];
  const shell = parsed.batchShells?.[0] ?? "bash";
  if (agent.role === "actor" && parsed.recipient === "watcher") {
    state.batches.push({
      id: `${message.id.slice(0, 8)}-${hash(command).slice(0, 12)}`,
      command,
      shell,
      cwd: parsed.workingDirectory,
      actorId: agent.id,
      requesterId: agent.id,
      proposalId: message.id,
      state: "proposed",
      inspection: false,
    });
  } else if (agent.role === "watcher") {
    let candidates = state.batches.filter((b) => {
      const proposal = state.messages.find(
        (message) => message.id === b.proposalId,
      );
      return (
        b.command === command &&
        (b.shell ?? "bash") === shell &&
        ["proposed", "reviewed"].includes(b.state) &&
        !!proposal &&
        proposal.taskId === taskId &&
        proposal.sequence < message.sequence
      );
    });
    const correction = deliveredDirectoryCorrection(
      state,
      agent,
      message,
      candidates,
    );
    if (options.directoryCorrectionOnly && !correction) {
      parsed.issues.push(directoryMismatchIssue);
      return;
    }
    const superseded = correction
      ? candidates.filter((batch) => batch !== correction)
      : [];
    if (correction) candidates = [correction];
    // Older versions did not record PowerShell proposals. Restore only a proposal
    // with confirmed briefing and delivery evidence, on a new explicit review.
    if (
      !candidates.length &&
      shell === "powershell" &&
      parsed.approval &&
      parsed.recipient === "operator"
    ) {
      const legacy = state.messages.filter((source) => {
        if (
          source.type !== "response" ||
          source.role !== "actor" ||
          source.taskId !== taskId ||
          source.sequence >= message.sequence ||
          !source.parsed ||
          hasBlockingIssues(source.parsed) ||
          state.batches.some((batch) => batch.proposalId === source.id)
        )
          return false;
        const proposal = parseResponse(source.content);
        if (
          proposal.sender !== "actor" ||
          proposal.recipient !== "watcher" ||
          proposal.batches.length !== 1 ||
          proposal.batches[0] !== command ||
          proposal.batchShells?.[0] !== shell ||
          hasBlockingIssues(proposal)
        )
          return false;
        if (
          !state.agents.some(
            (actor) => actor.id === source.agentId && actor.role === "actor",
          )
        )
          return false;
        const delivered = state.messages.some(
          (delivery) =>
            delivery.sourceId === source.id &&
            delivery.agentId === agent.id &&
            delivery.status === "submitted" &&
            delivery.sequence < message.sequence,
        );
        const briefed = state.messages.some((delivery) => {
          if (
            delivery.agentId !== source.agentId ||
            delivery.status !== "submitted" ||
            delivery.sequence >= source.sequence
          )
            return false;
          const briefing = state.messages.find(
            (entry) => entry.id === delivery.sourceId,
          );
          return (
            briefing?.taskId === taskId &&
            briefing?.role === "watcher" &&
            briefing.parsed?.sender === "watcher" &&
            briefing.parsed.recipient === "actor" &&
            !hasBlockingIssues(briefing.parsed)
          );
        });
        return delivered && briefed;
      });
      if (legacy.length === 1) {
        const source = legacy[0];
        const batch: Batch = {
          id: `${source.id.slice(0, 8)}-${hash(command).slice(0, 12)}`,
          command,
          shell,
          cwd: parseResponse(source.content).workingDirectory,
          actorId: source.agentId,
          requesterId: source.agentId!,
          proposalId: source.id,
          state: "proposed",
          inspection: false,
        };
        state.batches.push(batch);
        candidates.push(batch);
      }
    }
    if (
      parsed.approval &&
      parsed.recipient === "actor" &&
      candidates.length === 1
    ) {
      candidates[0].state = "reviewed";
      candidates[0].reviewId = message.id;
    } else if (parsed.recipient === "operator") {
      if (
        candidates.some(
          (batch) =>
            batch.cwd &&
            parsed.workingDirectory &&
            batch.cwd !== parsed.workingDirectory,
        )
      ) {
        parsed.issues.push(directoryMismatchIssue);
        return;
      }
      if (state.batches.some((b) => ["ready", "running"].includes(b.state))) {
        parsed.issues.push(
          "Another batch is awaiting execution. Resolve it before forwarding another batch.",
        );
        return;
      }
      const reviewed = candidates.filter(
        (b) =>
          b.state === "reviewed" &&
          state.messages.find((message) => message.id === b.reviewId)
            ?.agentId === agent.id,
      );
      if (
        parsed.approval &&
        candidates.length === 1 &&
        candidates[0].state === "proposed"
      ) {
        candidates[0].state = "ready";
        candidates[0].reviewId = message.id;
        candidates[0].forwardedId = message.id;
        candidates[0].cwd ??= parsed.workingDirectory;
        // Keep rejected proposal history; the explicit review authorizes only
        // the later, delivered directory correction from the same Actor.
        for (const batch of superseded) batch.state = "rejected";
      } else if (reviewed.length === 1) {
        reviewed[0].state = "ready";
        reviewed[0].forwardedId = message.id;
        reviewed[0].cwd ??= parsed.workingDirectory;
      } else if (!candidates.length && !parsed.approval) {
        state.batches.push({
          id: `${message.id.slice(0, 8)}-${hash(command).slice(0, 12)}`,
          command,
          shell,
          cwd: parsed.workingDirectory,
          requesterId: agent.id,
          proposalId: message.id,
          forwardedId: message.id,
          state: "ready",
          inspection: true,
        });
      } else
        parsed.issues.push(
          "Batch lacks an unambiguous explicit watcher review of the exact actor proposal.",
        );
    }
  }
}
