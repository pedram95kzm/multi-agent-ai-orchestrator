import { legacyCapturedFences } from "../protocol/fences";
import { hasBlockingIssues, parseResponse } from "../protocol/parser";
import { pendingOperatorReply } from "../shared/operator-replies";
import type { AppState, Message } from "../shared/types";
import { reviewBatch } from "./batch-review";

export function capturedReviewPair(state: AppState, messageId: string) {
  const review = state.messages.find((message) => message.id === messageId);
  const watcher = state.agents.find((agent) => agent.id === review?.agentId);
  const delivery = state.messages.find(
    (message) => message.id === review?.replyToId,
  );
  const proposal = state.messages.find(
    (message) => message.id === delivery?.sourceId,
  );
  const actor = state.agents.find((agent) => agent.id === proposal?.agentId);
  const briefingDelivery = state.messages.find(
    (message) => message.id === proposal?.replyToId,
  );
  const briefing = state.messages.find(
    (message) => message.id === briefingDelivery?.sourceId,
  );
  const current = (message: Message) =>
    state.messages.findLast(
      (entry) =>
        entry.agentId === message.agentId &&
        entry.type === "response" &&
        !entry.captureRejected,
    )?.id === message.id;
  if (
    !review ||
    !proposal ||
    !delivery ||
    !actor ||
    !watcher ||
    !briefingDelivery ||
    !briefing ||
    !state.activeTaskId ||
    review.taskId !== state.activeTaskId ||
    proposal.taskId !== review.taskId ||
    delivery.taskId !== review.taskId ||
    actor.taskId !== review.taskId ||
    watcher.taskId !== review.taskId ||
    actor.role !== "actor" ||
    watcher.role !== "watcher" ||
    actor.awaitingResponse ||
    watcher.awaitingResponse ||
    review.type !== "response" ||
    proposal.type !== "response" ||
    review.captureRejected ||
    proposal.captureRejected ||
    review.purpose ||
    proposal.purpose ||
    review.originalCapture ||
    proposal.originalCapture ||
    review.conversationId !== watcher.conversation ||
    proposal.conversationId !== actor.conversation ||
    !current(proposal) ||
    !current(review) ||
    review.parsed?.sender !== "watcher" ||
    review.parsed.recipient !== "operator" ||
    !review.parsed.approval ||
    proposal.parsed?.sender !== "actor" ||
    proposal.parsed.recipient !== "watcher" ||
    review.parsed.batches.length ||
    proposal.parsed.batches.length ||
    hasBlockingIssues(review.parsed) ||
    hasBlockingIssues(proposal.parsed) ||
    !/\n```markdown\n/.test(review.content) ||
    !/\n```markdown\n/.test(proposal.content) ||
    delivery.agentId !== watcher.id ||
    delivery.conversationId !== watcher.conversation ||
    delivery.type === "response" ||
    delivery.status !== "submitted" ||
    proposal.sequence >= delivery.sequence ||
    delivery.sequence >= review.sequence ||
    briefingDelivery.agentId !== actor.id ||
    briefingDelivery.conversationId !== actor.conversation ||
    briefingDelivery.taskId !== review.taskId ||
    briefingDelivery.status !== "submitted" ||
    briefingDelivery.type === "response" ||
    briefingDelivery.sequence >= proposal.sequence ||
    briefing.taskId !== review.taskId ||
    briefing.agentId !== watcher.id ||
    briefing.type !== "response" ||
    briefing.captureRejected ||
    briefing.parsed?.sender !== "watcher" ||
    briefing.parsed.recipient !== "actor" ||
    hasBlockingIssues(briefing.parsed) ||
    briefing.sequence >= briefingDelivery.sequence ||
    !(
      delivery.originalInput === proposal.content ||
      delivery.content.includes(proposal.content)
    ) ||
    pendingOperatorReply(state, review.taskId)?.id !== review.id ||
    state.runs.some((run) => run.status === "running") ||
    state.batches.some(
      (batch) =>
        batch.proposalId === proposal.id ||
        batch.reviewId === review.id ||
        batch.forwardedId === review.id ||
        ["ready", "running"].includes(batch.state),
    )
  )
    throw new Error(
      "Refresh only the current unrecorded documentation approval and its delivered Actor proposal.",
    );
  return { proposal, review, actor, watcher };
}

export function repairCapturedReview(
  state: AppState,
  messageId: string,
  captures: { actor: string; watcher: string },
) {
  const pair = capturedReviewPair(state, messageId);
  const refreshed = (["actor", "watcher"] as const).map((role) => {
    const original = role === "actor" ? pair.proposal : pair.review;
    const content = captures[role];
    const parsed = parseResponse(content);
    if (
      content === original.content ||
      legacyCapturedFences(content) !== original.content ||
      parsed.sender !== role ||
      parsed.number !== original.parsed?.number ||
      parsed.number !== pair[role].lastNumber ||
      parsed.recipient !== original.parsed?.recipient ||
      parsed.batches.length !== 1 ||
      !parsed.workingDirectory ||
      hasBlockingIssues(parsed)
    )
      throw new Error(
        "The chat must contain the same recorded response with only corrected code-fence delimiters. Reload the updated extension and try again; changed replies need a fresh proposal.",
      );
    return { ...original, content, originalCapture: original.content, parsed };
  });
  const [proposal, review] = refreshed;
  if (
    !review.parsed.approval ||
    proposal.parsed.batches[0] !== review.parsed.batches[0] ||
    proposal.parsed.batchShells?.[0] !== review.parsed.batchShells?.[0] ||
    proposal.parsed.workingDirectory !== review.parsed.workingDirectory
  )
    throw new Error(
      "The refreshed approval must preserve the Actor's exact code, shell and working directory.",
    );
  const draft: AppState = {
    ...state,
    batches: state.batches.map((batch) => ({ ...batch })),
    messages: state.messages.map((message) =>
      message.id === proposal.id
        ? proposal
        : message.id === review.id
          ? review
          : message,
    ),
  };
  reviewBatch(draft, pair.actor, proposal, proposal.taskId);
  reviewBatch(draft, pair.watcher, review, review.taskId);
  const batch = draft.batches.find(
    (batch) =>
      batch.proposalId === proposal.id &&
      batch.forwardedId === review.id &&
      batch.state === "ready",
  );
  if (!batch || hasBlockingIssues(review.parsed))
    throw new Error(
      "The refreshed captures do not establish an exact reviewed batch.",
    );
  Object.assign(pair.proposal, proposal);
  Object.assign(pair.review, review);
  state.batches = draft.batches;
  return batch;
}
