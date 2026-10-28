import type { AppState, Message } from "./types";

// Legacy replies are inferred from confirmed sends to the requesting agent;
// new replies keep an explicit link to the message being answered.
export function pendingOperatorReply(
  state: Pick<AppState, "agents" | "messages">,
  taskId?: string,
): Message | undefined {
  const agents = new Set(
    state.agents.filter((agent) => !agent.staged).map((agent) => agent.id),
  );
  const waiting: Message[] = [];
  const messagesById = new Map(
    state.messages.map((message) => [message.id, message]),
  );
  const isTransferReply = (message: Message) => {
    if (!message.parsed?.onboardingRole) return false;
    const visited = new Set<string>();
    let current: Message | undefined = message;
    while (
      current &&
      current.taskId === message.taskId &&
      !visited.has(current.id)
    ) {
      if (current.purpose === "onboarding") return true;
      visited.add(current.id);
      current = current.replyToId
        ? messagesById.get(current.replyToId)
        : undefined;
    }
    return false;
  };
  for (const message of state.messages) {
    if (message.taskId !== taskId) continue;
    if (
      message.type === "response" &&
      !message.captureRejected &&
      message.purpose !== "onboarding" &&
      !(message.purpose === "handover" && message.parsed?.handover) &&
      message.parsed?.recipient === "operator" &&
      !isTransferReply(message) &&
      message.agentId &&
      agents.has(message.agentId)
    ) {
      waiting.push(message);
    } else if (
      message.status === "submitted" &&
      !message.purpose &&
      (message.type === "operator" || message.type === "terminal") &&
      (message.replyToId || !message.sourceId || message.type === "terminal")
    ) {
      const answered = waiting.findIndex(
        (request) =>
          request.agentId === message.agentId &&
          (!message.replyToId || message.replyToId === request.id),
      );
      if (answered >= 0) waiting.splice(answered, 1);
    }
  }
  return waiting[0];
}
