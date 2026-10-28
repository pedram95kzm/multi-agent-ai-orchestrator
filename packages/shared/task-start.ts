import type { AppState, Role } from "./types";
import { hasBlockingIssues } from "../protocol/parser";

export function handoverBlockReason(
  state: Pick<AppState, "agents" | "messages">,
  taskId: string,
  targetRole?: Role,
) {
  if (!hasWatcherSubmission(state, taskId))
    return "Send the first task message to the Watcher before requesting a handover.";
  if (
    targetRole === "actor" &&
    !state.agents.some(
      (agent) =>
        agent.taskId === taskId &&
        agent.role === "actor" &&
        !agent.staged &&
        agent.lastNumber > 0 &&
        state.messages.some(
          (message) =>
            message.taskId === taskId &&
            message.type === "response" &&
            message.role === "actor" &&
            !message.captureRejected &&
            !message.purpose &&
            message.parsed?.sender === "actor" &&
            !!message.parsed.number &&
            !hasBlockingIssues(message.parsed),
        ),
    )
  )
    return "Wait for the Actor's first response before requesting a replacement handover.";
}

export function hasWatcherSubmission(
  state: Pick<AppState, "agents" | "messages">,
  taskId?: string,
): boolean {
  const watcherIds = new Set(
    state.agents
      .filter((agent) => agent.role === "watcher")
      .map((agent) => agent.id),
  );
  return state.messages.some(
    (message) =>
      message.taskId === taskId &&
      message.type !== "response" &&
      message.status === "submitted" &&
      (message.onboardingRole === "watcher" ||
        watcherIds.has(message.agentId ?? "")),
  );
}
