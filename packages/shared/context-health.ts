import type { Agent, AppState } from "./types";

export function contextCheckFooter(role: Agent["role"]) {
  return `Relay context check for ${role}: Can you still directly read the original message headed RESPONSE NUMBER 1 for your ${role} role in the context available to you? Do not infer its contents from a summary or pretend to remember it. In your same response, put exactly one standalone line before Summary: CONTEXT CHECK: RESPONSE 1 = READABLE, CONTEXT CHECK: RESPONSE 1 = UNAVAILABLE, or CONTEXT CHECK: RESPONSE 1 = NOT_ESTABLISHED. Use UNAVAILABLE when response 1 was previously available but you can no longer read it. Use NOT_ESTABLISHED only when response 1 has never been available in this chat, such as the first reply or a replacement chat without that historical reference. If unavailable, Relay will notify the Operator that it would be better to onboard a new ${role}. This is only a recommendation; automatic onboarding is unavailable. This check is for you, not a numbered question for the Operator. Keep your response number and recipient correct.`;
}

export function withContextCheck(content: string, agent: Pick<Agent, "role">) {
  const footer = contextCheckFooter(agent.role);
  return content.endsWith(footer)
    ? content
    : `${content}\n\n__________\n${footer}`;
}

export function responseOneForAgent(
  state: Pick<AppState, "messages">,
  agent: Agent,
) {
  const matching = state.messages.filter(
    (message) =>
      message.type === "response" &&
      message.role === agent.role &&
      message.parsed?.sender === agent.role &&
      message.parsed.number === 1,
  );
  return (
    matching.find((message) => message.agentId === agent.id) ??
    (agent.taskId
      ? matching.find((message) => message.taskId === agent.taskId)
      : undefined)
  );
}
