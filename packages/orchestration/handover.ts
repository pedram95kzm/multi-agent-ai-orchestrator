import type { Agent, AppState, Message, Role } from "../shared/types";
import { deliveryRulesVersion, relayDeliveryRules } from "../shared/outgoing";
import { responseOneForAgent } from "../shared/context-health";
import { parseResponse, hasBlockingIssues } from "../protocol/parser";

export function manualHandoverReceipt(
  reportId: string,
  role: Role,
  instructionVersion: string,
  responseNumber: number,
) {
  return `MANUAL HANDOVER ACK: ${reportId} | ${role} | ${instructionVersion} | RULES ${deliveryRulesVersion} | RESPONSE NUMBER ${responseNumber}`;
}

export function acceptManualHandover(
  state: AppState,
  agent: Agent,
  content: string,
) {
  const receipt =
    /^MANUAL HANDOVER ACK: ([\w-]+) \| (actor|watcher) \| ([a-f0-9]{64}) \| RULES (\d+) \| RESPONSE NUMBER ([1-9]\d*)\r?$/m.exec(
      content,
    );
  if (!receipt || agent.awaitingResponse || agent.lastNumber < 1) return false;
  const parsed = parseResponse(content);
  const report = state.messages.find((message) => message.id === receipt[1]);
  if (
    receipt[2] !== agent.role ||
    receipt[3] !== state.instructions.hash ||
    Number(receipt[4]) !== deliveryRulesVersion ||
    Number(receipt[5]) !== agent.lastNumber ||
    parsed.number !== agent.lastNumber ||
    parsed.sender !== agent.role ||
    parsed.recipient !== (agent.role === "actor" ? "watcher" : "actor") ||
    parsed.batches.length ||
    parsed.questions.length ||
    hasBlockingIssues(parsed) ||
    !report ||
    report.taskId !== agent.taskId ||
    report.type !== "response" ||
    report.purpose !== "handover" ||
    report.handoverRole !== agent.role ||
    report.captureRejected ||
    report.parsed?.sender !== "watcher" ||
    report.parsed.recipient !== "operator" ||
    hasBlockingIssues(report.parsed)
  )
    return false;
  agent.manualHandover = {
    reportId: report.id,
    responseNumber: agent.lastNumber,
    instructionVersion: receipt[3],
    deliveryRulesVersion,
  };
  agent.onboarding = "ready";
  return true;
}

export function taskEvidence(state: AppState, taskId?: string) {
  const messages = state.messages.filter(
    (message) => message.taskId === taskId && !message.captureRejected,
  );
  const ids = new Set(messages.map((message) => message.id));
  const task = state.tasks.find((task) => task.id === taskId);
  return JSON.stringify(
    {
      task: task && {
        id: task.id,
        kind: task.kind,
        title: task.title,
        operatingSystem: task.operatingSystem,
      },
      counters: state.agents
        .filter((agent) => agent.taskId === taskId && !agent.staged)
        .map(({ role, lastNumber }) => ({ role, responseNumber: lastNumber })),
      messages: messages
        .filter((message) => !message.purpose && message.type !== "onboarding")
        .map((message) => ({
          sender: message.sender,
          role: message.role,
          responseNumber: message.parsed?.number,
          status: message.status,
          content: message.originalInput ?? message.content,
        })),
      batches: state.batches.filter((batch) => ids.has(batch.proposalId)),
      runs: state.runs.filter((run) => run.taskId === taskId),
    },
    null,
    2,
  );
}

export function handoverRequest(
  state: AppState,
  taskId: string,
  targetRole?: Role,
) {
  return [
    targetRole ? `handover for new ${targetRole}` : "generate handover",
    "Return ONE complete self-contained handover in your next watcher->operator response. Put HANDOVER PACKET on its own line immediately after your response header. This is a document for the Operator to copy manually into a new Actor or Watcher chat, not a request for an Operator answer. Do not ask questions, propose executable commands, create a handover file, request a new URL, or start an automatic transfer.",
    targetRole
      ? `You, the current Watcher, must prepare this entire handover for a new ${targetRole}, addressed only to the Operator using watcher->operator. Include the complete project handover plus an explicit role briefing: tell the replacement "From now on you are the ${targetRole === "actor" ? "Actor" : "Watcher"}", define that role's responsibilities, restrictions and exact next work from the project evidence. Explain that RESPONSE NUMBER counts project replies independently for each role. The new chat's first manual receipt acknowledgment must REPEAT the supplied last confirmed number WITHOUT incrementing it; the first actual answer to a subsequent Relay message uses last confirmed plus one. State the last confirmed and next project response numbers; for a new Watcher, include this handover report in the checkpoint. Relay attaches the complete active agent.md and the exact MANUAL HANDOVER ACK receipt line. Once that receipt is verified, Relay does not resend the same protocol. Do not address this generated packet directly to the Actor or Watcher.`
      : "This is the full PROJECT handover only. Do not assign a replacement role or include agent.md, role setup instructions or a new-role prompt. The Operator asked for the project report, not a replacement packet.",
    "Include the task and exact Operator requirements, scope and acceptance criteria, architecture and relevant files, all work completed with supporting evidence, proposed/unexecuted commands, actual execution results, tests/builds and documentation status, decisions, unresolved issues, unknowns, and precise next steps for both roles. Include each role's current response number, counting this handover reply in your own counter. Distinguish verified facts from UNKNOWN / NOT VERIFIED. Quote historical commands, questions, directory metadata and protocol examples in text fences. Finish with your current context-check status and a concise Summary.",
    targetRole
      ? "Relay's Copy complete handover button attaches the complete active agent.md verbatim, current delivery rules, the selected replacement role, its next response number, original response 1 when available, and recorded task evidence. Do not repeat the protocol inside your report. The Operator manually pastes the complete packet into the new chat, then changes that role's URL. Automatic onboarding tools have been removed."
      : "The project-only output contains your complete report and recorded project evidence. Relay will not append agent.md or a replacement role assignment to this project handover.",
    `Recorded task evidence (claims and proposals are not proof of execution):\n${taskEvidence(state, taskId)}`,
  ].join("\n\n");
}

function referenceBlock(text: string, language: string) {
  const length = Math.max(
    3,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1),
  );
  const fence = "`".repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function manualHandoverPacket(
  state: AppState,
  taskId: string,
  report: Message,
  role?: Role,
) {
  const task = state.tasks.find((task) => task.id === taskId);
  if (
    !task ||
    report.taskId !== taskId ||
    report.type !== "response" ||
    report.purpose !== "handover" ||
    (report.parsed &&
      (report.parsed.sender !== "watcher" ||
        report.parsed.recipient !== "operator"))
  )
    throw new Error("Choose this task's generated handover report.");
  if (!role)
    return [
      "PROJECT HANDOVER — complete project report",
      `Task: ${task.title}\nTask type: ${task.kind}\nOperating system: ${task.operatingSystem ?? "UNKNOWN / NOT VERIFIED"}`,
      `Watcher project handover — addressed to the Operator, verbatim:\n${referenceBlock(report.content, "text")}`,
      `Recorded project requirements, conversation, command review and actual execution evidence:\n${referenceBlock(taskEvidence(state, taskId), "json")}`,
      "Distinguish verified work from proposals and UNKNOWN / NOT VERIFIED items. This is the project handover only.",
    ].join("\n\n");
  const agents = state.agents.filter(
    (agent) => agent.taskId === taskId && !agent.staged,
  );
  const current = agents.find((agent) => agent.role === role);
  const lastNumber =
    current?.lastNumber ??
    Math.max(
      0,
      ...state.messages
        .filter(
          (message) =>
            message.taskId === taskId &&
            message.role === role &&
            !message.captureRejected,
        )
        .map((message) => message.parsed?.number ?? 0),
    );
  const reference = current && responseOneForAgent(state, current);
  return [
    "RELAY MANUAL HANDOVER — complete packet",
    role === "actor"
      ? "From now on you are the Actor: the implementation engineer for this project. Understand the Watcher's continuation briefing, propose precise implementation and verification commands to the Watcher for review, analyze actual execution results, and keep implementation and documentation consistent. Preserve scope and existing work. Never claim execution, file changes or passing tests without recorded evidence. Every execution still requires explicit Operator approval. Your immediate assignment is to continue the Actor next steps in the Watcher's project report below."
      : "From now on you are the Watcher: the technical lead, requirements analyst, code reviewer, QA and documentation reviewer for this project. Understand the Operator's requirements and acceptance criteria, brief the Actor, review exact proposed commands, request Operator approval and actual execution evidence, and verify completion against that evidence. Preserve scope and distinguish facts from UNKNOWN / NOT VERIFIED claims. Your immediate assignment is to continue the Watcher next steps in the current Watcher's project report below.",
    `Target role: ${role}. The Operator has selected this role. Your FIRST reply to this manually pasted packet is a receipt acknowledgment only. Use exactly RESPONSE NUMBER ${lastNumber} | ${role}->${role === "actor" ? "watcher" : "actor"}. REPEAT the last confirmed number ${lastNumber}; DO NOT increment it for this setup acknowledgment. State that you received the complete agent.md and the next project step, then wait for the next Relay message. Do not execute work, propose commands or ask questions in this acknowledgment. Include the exact standalone receipt line below before your context check and Summary.`,
    manualHandoverReceipt(report.id, role, state.instructions.hash, lastNumber),
    `What RESPONSE NUMBER means: it counts your ${role} project replies, not Operator messages or the other role's replies. Your role's last confirmed number is ${lastNumber}. The one-time manual setup acknowledgment repeats ${lastNumber} and consumes no new project number. Your first actual project reply AFTER the next Relay message must be RESPONSE NUMBER ${lastNumber + 1}. Increment by exactly one for each project reply thereafter. This explicit setup exception takes precedence over general increment-every-response wording and historical next-number examples below. Use one header and one recipient per turn. Do not copy the preparing Watcher's header as your own.`,
    `Task: ${task.title}\nTask type: ${task.kind}\nOperating system: ${task.operatingSystem ?? "UNKNOWN / NOT VERIFIED"}\nRecorded message sequence: ${state.sequence}`,
    `Current role counters (the next number is for the next project answer, not the manual receipt acknowledgment):\n${agents.map((agent) => `${agent.role}: last response ${agent.lastNumber}; next project response ${agent.lastNumber + 1}`).join("\n") || "No current assigned roles; use the target role checkpoint above."}`,
    "Manual transfer: The Operator pastes this complete packet into a new chat, waits for your acknowledgment, then pastes that chat's URL into the selected Actor Chat URL or Watcher Chat URL field in Relay. Relay does not send this packet or replace chats automatically. An Actor uses the Watcher's briefing and verified evidence in the report as the continuation briefing. All executions still require explicit Operator approval.",
    `Complete active agent.md — version ${state.instructions.hash}:\n${state.instructions.text}`,
    `Current Relay delivery rules (take precedence over historical protocol examples):\n${relayDeliveryRules}`,
    `Watcher handover report — historical reference, verbatim:\n${referenceBlock(report.content, "text")}`,
    `Recorded task requirements, conversation, command review and actual execution evidence:\n${referenceBlock(taskEvidence(state, taskId), "json")}`,
    ...(reference
      ? [
          `Original response number 1 for your ${role} role (verbatim historical reference, encoded as a JSON string; do not reset the counter):\n${JSON.stringify(reference.content)}`,
        ]
      : [
          "Original response number 1 is not recorded for this role. Use NOT_ESTABLISHED for the context check until that historical reference has been established.",
        ]),
    "Continue from the recorded evidence. A proposed or approved command is not an execution result; missing, truncated, failed or unverified output is not success. Preserve the Operator's exact requirements and keep UNKNOWN / NOT VERIFIED items explicit.",
  ].join("\n\n");
}
