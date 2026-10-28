import { operatorPayload } from "../protocol/parser";
import type { Agent, AppState, Message } from "./types";
import { withContextCheck } from "./context-health";

export const isRetiredTransfer = (message: Pick<Message, "type" | "purpose">) =>
  message.type === "onboarding" || message.purpose === "onboarding";

export const isUnresolvedDelivery = (
  message: Pick<Message, "type" | "purpose" | "status">,
) =>
  !isRetiredTransfer(message) &&
  (message.status === "pending" || message.status === "uncertain");

export const deliveryRulesVersion = 13;
export const relayDeliveryRules = [
  "Relay delivery rules (current; replace any earlier rule requiring separate approval acknowledgment or another Operator message before forwarding): Each assistant turn is ONE response with exactly one RESPONSE NUMBER header, one recipient, and at most one command batch.",
  "Protocol delivery and handoff rule: The first confirmed Relay message to a chat includes the complete active agent.md unless Relay has verified that role's acknowledgment of the complete manually pasted handover with the same current protocol and delivery rules. That manual acknowledgment repeats the supplied last confirmed RESPONSE NUMBER without incrementing it; it is setup only. The first actual project answer after a Relay message uses the next number. Include the packet's exact MANUAL HANDOVER ACK line in the setup acknowledgment. Relay records that receipt and does not resend the same agent.md to a manually prepared replacement. Earlier greetings, bare response numbers, and saved ready labels alone do not establish protocol delivery. Follow the supplied role and next response number without asking for setup again. An agent handoff preserves the selected current response verbatim, never substituting the Operator's original greeting. Relay accepts only a captured project answer matching the assigned role, next response number, and saved chat URL; an older greeting cannot complete a new delivery.",
  "The Actor proposes executable file-creation/change commands using actor->watcher. Once the Watcher accepts the exact Actor proposal, her NEXT response must be watcher->operator with APPROVED on its own line, the identical command block, and q1: Please run the approved batch above and paste its complete stdout, stderr, and exit code here. Put the question after the block and before Summary. Reviewing and forwarding in this single watcher->operator response is supported. Do not first send an approval to the Actor or wait for another Operator message, an Actor acknowledgment, or execution output that has not yet been requested. If an earlier watcher->actor approval already exists, forward that unchanged block to the Operator now instead of exchanging standby messages.",
  "Current Operator execution rule (replaces earlier Watcher read-only restrictions): Both the Watcher and Actor may request Bash and PowerShell execution, including file changes, with explicit Operator approval. There is no Watcher-specific command allowlist. The Watcher may request her own batch directly using watcher->operator, with the confirmed working directory and numbered output question; omit APPROVED for a self-authored batch because that marker identifies review of an Actor proposal. Actor proposals continue through exact Watcher review. Every execution requires the Operator to click Execute command; neither agent may claim execution before actual results arrive.",
  "Operator reply rule: Every ordinary actor->operator or watcher->operator response requires a non-empty Operator answer to the same sender before continuing, even without numbered questions. Relay makes that sender the only available reply target until submission is confirmed. Pending, failed, and uncertain sends do not satisfy the requirement. Handoffs and task tools cannot replace the answer. Requests are answered in arrival order within each task. A generated HANDOVER PACKET is a document for manual copying and chat replacement, not a question requiring an Operator acknowledgment.",
  "Confirm the operating system, actual shell, and working directory in chat, using available evidence and asking the Operator when unknown. Before every executable batch, include a standalone Working directory: <absolute path> line outside the code fence, preserving that exact directory when reviewing and forwarding. Use a bash fence for Bash/Git Bash/WSL and a powershell fence for PowerShell. Relay executes the batch through the configured terminal executable for that shell only after the Operator clicks Execute command. Execution always requires Operator approval; automatic execution is unavailable. Relay fills the first output question with actual stdout, stderr, status, and exit code when execution finishes. The Operator reviews and submits the answers. Never label PowerShell commands as Bash. Use the verified python executable for compile checks. Bash && chains are supported. Preserve the exact reviewed commands.",
  'Literal code formatting rule: Fence bodies are raw source, with real newlines and indentation. Never add Markdown escaping, HTML space entities such as &#x20; or &nbsp;, escaped Python underscores, escaped Markdown headings/lists, or a trailing backslash on every line. Preserve actual Windows path backslashes and literal __name__ == "__main__". Show each file separately under File: <relative path> in its own correct source-language fence. Put only actual shell commands in the one executable powershell or bash fence, never mislabeled as SQL. Do not embed Python programs and Markdown documentation together using PowerShell here-strings or Bash heredocs. Use small, cohesive single-file steps; in PowerShell, write UTF8 using readable single-quoted line arrays and Set-Content -LiteralPath. A literal quote inside a PowerShell single-quoted line is doubled. The write must exactly match the separately shown source, including spaces and blank lines. Independent documentation belongs in a later step. Reference source blocks alone are not file writes; require actual approved execution evidence before claiming creation. Keep explanations, questions and Summary outside executable fences.',
  "Code-fence boundaries: Use an outer backtick fence longer than every consecutive backtick sequence in its body, with an equally long closing fence. Markdown references containing triple-backtick examples need at least four outer backticks; contents containing four need five. Literal backticks in quoted PowerShell line-array strings remain exact file contents, and their executable batch also needs a longer outer fence. Fully close each reference before the standalone Working directory line and separate shell batch. Keep q1, context status and Summary outside all blocks. Never promote reference examples into executable batches. The Watcher checks these boundaries before approving and forwards unchanged literal code with valid fences.",
  "Summary: text on the same line and a separate Summary heading are supported; finish with at most three prose lines. Relay shows the fenced command batch next to the collapsed Summary with copy and eligible execution controls. Never treat a proposal, approval, or standby acknowledgment as execution evidence.",
  "Every delivered message ends with a Relay context check. Report whether you can still directly read the original response numbered 1 for your assigned role using exactly one standalone CONTEXT CHECK: RESPONSE 1 = READABLE, UNAVAILABLE, or NOT_ESTABLISHED line before Summary. This is metadata, not an Operator question. Never claim to read an unavailable message from memory or a summary. NOT_ESTABLISHED applies only when response 1 has never been available in this chat. A replacement packet may include the original role response 1 as a historical reference; continue the supplied counter without resetting it. Relay suggests that it would be better to onboard a new member of the affected role when the reference is lost. This is only a recommendation; it does not trigger replacement.",
  "Manual handover rules: There are exactly three tools: handover, handover for new actor, and handover for new watcher. The current Watcher prepares every report using watcher->operator, with HANDOVER PACKET immediately after the header and a final Summary. The plain handover contains the complete project report and recorded evidence only, without appending agent.md or assigning a new role. Handover for new actor and handover for new watcher each contain the complete project handover plus the full active agent.md, an explicit identity and responsibility briefing for that selected role, its concrete next work, and an explanation of RESPONSE NUMBER with the last confirmed and next numbers. RESPONSE NUMBER counts that role's assistant replies independently, increases by one per turn and never resets on replacement. Include the preparing Watcher's current handover reply in its own checkpoint. Relay attaches the exact current protocol, rules, counters and evidence to replacement copies. Do not ask questions or propose commands in handover reports; quote historical metadata in text fences. The Operator manually pastes a replacement packet into a new chat and then edits its role URL. No packet or prompt is sent automatically. Context warnings only suggest that it would be better to onboard a new actor or watcher. Do not offer automatic onboarding, synchronization tools or handover file creation.",
].join("\n\n");

export function needsAgentInstructions(
  state: Pick<AppState, "instructions" | "messages">,
  agent: Agent,
): boolean {
  if (
    agent.manualHandover?.instructionVersion === state.instructions.hash &&
    agent.manualHandover.deliveryRulesVersion === deliveryRulesVersion
  )
    return false;
  const delivered = state.messages.findLast(
    (message) =>
      message.agentId === agent.id &&
      message.type !== "response" &&
      message.status === "submitted",
  );
  const instructionsDelivered = state.messages.some(
    (message) =>
      message.agentId === agent.id &&
      message.conversationId === agent.conversation &&
      message.type !== "response" &&
      message.status === "submitted" &&
      (message.onboardingRole === agent.role ||
        message.type === "onboarding") &&
      message.instructionVersion === state.instructions.hash &&
      message.content.includes(state.instructions.text),
  );
  return (
    !instructionsDelivered ||
    (!!delivered &&
      (delivered.instructionVersion !== state.instructions.hash ||
        delivered.deliveryRulesVersion !== deliveryRulesVersion))
  );
}

export function outgoingPayload(
  state: Pick<
    AppState,
    "instructions" | "settings" | "messages" | "tasks" | "activeTaskId"
  >,
  agent: Agent,
  input: string,
  sourceId?: string,
  kind: Message["type"] = "operator",
): string {
  const handoff = !!sourceId && kind !== "terminal";
  if (kind !== "onboarding" && needsAgentInstructions(state, agent)) {
    const filename = state.instructions.path.split(/[\\/]/).pop() || "agent.md";
    const task = state.tasks.find(
      (task) => task.id === (agent.taskId ?? state.activeTaskId),
    );
    return withContextCheck(
      operatorPayload(
        `Target role: ${agent.role}. The Operator has selected this role. This role is already selected; do not ask for role selection. Follow the role restrictions and use the supplied task context.\nYour next response must be RESPONSE NUMBER ${agent.lastNumber + 1}. Continue the independent counter without resetting it.\nTask operating system: ${task?.operatingSystem ?? "UNKNOWN — ask the Operator before proposing commands"}.\n\nComplete Agent Instructions (${filename}; version ${state.instructions.hash}):\n${state.instructions.text}\n\n${relayDeliveryRules}\n\n${handoff ? "Original agent message (verbatim)" : "Operator message"}:\n${input}`,
      ),
      agent,
    );
  }
  return withContextCheck(handoff ? input : operatorPayload(input), agent);
}
