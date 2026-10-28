import { canonicalConversation } from "../shared/conversation";
import { reviewBatch } from "./batch-review";
import { handoverRequest } from "./handover";
import { randomUUID } from "node:crypto";
import { parseResponse, hasBlockingIssues } from "../protocol/parser";
import {
  deliveryRulesVersion,
  needsAgentInstructions,
  outgoingPayload,
  isUnresolvedDelivery,
} from "../shared/outgoing";
import {
  type RegisterAgent,
  type Agent,
  type AppState,
  type Message,
  type Role,
  type Run,
} from "../shared/types";
import {
  directoryMismatchIssue,
  executionResult,
  runningBatchIds,
} from "../shared/executions";
import {
  handoverBlockReason,
  hasWatcherSubmission,
} from "../shared/task-start";
import { pendingOperatorReply } from "../shared/operator-replies";
import { withContextCheck } from "../shared/context-health";
import { repairCapturedReview } from "./capture-repair";

export const now = () => new Date().toISOString();
export class Orchestrator {
  onChange: () => void = () => {};
  transport: (message: Message, agent: Agent) => boolean = () => false;
  constructor(
    public state: AppState,
    private persist: (state: AppState) => void,
  ) {}
  changed() {
    this.persist(this.state);
    this.onChange();
  }
  recover() {
    for (const a of this.state.agents) a.connected = false;
    for (const message of this.state.messages) {
      if (message.type !== "response" || !message.parsed) continue;
      const current = parseResponse(message.content, {
        handover: message.purpose === "handover",
      });
      const summaryIssue = (issue: string) =>
        issue.startsWith("Missing agent-authored") ||
        issue.startsWith("Summary exceeds");
      message.parsed.summary = current.summary;
      // Refresh visibility only; historical commands never gain review/execute permission here.
      message.parsed.batches = current.batches;
      message.parsed.batchShells = current.batchShells;
      message.parsed.contextCheck = current.contextCheck;
      message.parsed.onboardingRole = current.onboardingRole;
      message.parsed.handover = current.handover;
      if (current.onboardingRole || current.handover) {
        message.parsed.questions = current.questions;
        message.parsed.workingDirectory = current.workingDirectory;
        message.parsed.approval = current.approval;
      }
      message.parsed.issues = [
        ...message.parsed.issues.filter(
          (issue) =>
            !summaryIssue(issue) &&
            !(
              (current.onboardingRole || current.handover) &&
              /^(Conflicting working directories|Ambiguous repeated question IDs)/.test(
                issue,
              )
            ) &&
            issue !== "Chained && commands violate agent.md.",
        ),
        ...current.issues.filter(summaryIssue),
      ];
    }
    for (const m of this.state.messages)
      if (m.status === "pending") {
        m.status = "uncertain";
        m.error =
          "Application interrupted; inspect the provider before manually resolving this delivery.";
      }
    for (const run of this.state.runs)
      if (run.status === "running") {
        run.status = "interrupted";
        run.finished = now();
      }
    // Never allow a possibly executed batch to be submitted again after interruption.
    for (const b of this.state.batches)
      if (b.state === "running") b.state = "executed";
    this.changed();
  }
  agent(id: string) {
    const a = this.state.agents.find((a) => a.id === id);
    if (!a) throw new Error("Agent is no longer registered.");
    return a;
  }
  taskAgents(taskId = this.state.activeTaskId) {
    return this.state.agents.filter(
      (a) => !a.staged && (a.taskId === taskId || !a.taskId),
    );
  }
  connectChat(taskId: string, role: Role, url: string) {
    if (!this.state.tasks.some((task) => task.id === taskId))
      throw new Error("Choose a task before connecting a chat.");
    const conversation = canonicalConversation(url);
    const duplicate = this.state.agents.find(
      (a) => a.conversation === conversation,
    );
    if (duplicate && (duplicate.taskId !== taskId || duplicate.role !== role))
      throw new Error(
        "This chat URL is assigned elsewhere. Use a separate chat for each task and role.",
      );
    const previous = this.state.agents.find(
      (a) => a.taskId === taskId && a.role === role,
    );
    if (previous?.conversation === conversation) return previous;
    if (previous) {
      if (
        this.state.runs.some(
          (run) => run.taskId === taskId && run.status === "running",
        ) ||
        this.state.batches.some(
          (batch) =>
            batch.state === "running" &&
            (batch.actorId === previous.id ||
              batch.requesterId === previous.id),
        )
      )
        throw new Error(
          "Finish or cancel the running execution before replacing this chat URL.",
        );
      for (const batch of this.state.batches)
        if (
          ["proposed", "reviewed", "ready"].includes(batch.state) &&
          (batch.actorId === previous.id ||
            batch.requesterId === previous.id ||
            this.state.messages.find((message) => message.id === batch.reviewId)
              ?.agentId === previous.id)
        )
          batch.state = "rejected";
      for (const message of this.state.messages)
        if (
          message.agentId === previous.id &&
          ["pending", "uncertain"].includes(message.status)
        ) {
          message.status = "uncertain";
          message.error =
            "Chat URL replaced manually. Inspect the old chat if needed; this delivery will not be replayed.";
        }
      this.state.agents = this.state.agents.filter(
        (agent) => agent.id !== previous.id,
      );
    }
    const agent = this.register({
      taskId,
      role,
      conversation,
      name: role === "actor" ? "Actor" : "Watcher",
      provider: "browser",
      automation: "Chrome extension",
      lastNumber: previous?.lastNumber ?? 0,
    });
    agent.connected = false;
    agent.briefed =
      !!previous?.briefed ||
      (role === "actor" &&
        this.state.messages.some(
          (message) =>
            message.taskId === taskId &&
            message.type === "response" &&
            message.purpose === "handover" &&
            message.role === "watcher" &&
            message.parsed?.sender === "watcher" &&
            message.parsed.recipient === "operator" &&
            message.parsed.handover &&
            !hasBlockingIssues(message.parsed),
        ));
    this.changed();
    return agent;
  }
  register(data: RegisterAgent) {
    const conversation = canonicalConversation(data.conversation);
    const existing = this.state.agents.find(
      (a) => a.conversation === conversation,
    );
    if (existing) {
      if (existing.role !== data.role)
        throw new Error(
          "Conversation already registered. Reassign its role explicitly in the desktop app.",
        );
      existing.connected = true;
      existing.lastActivity = now();
      existing.automation = data.automation;
      this.changed();
      return existing;
    }
    if (
      data.role === "watcher" &&
      this.state.agents.some(
        (a) => a.role === "watcher" && a.taskId === data.taskId,
      )
    )
      throw new Error(
        "A watcher is already assigned. Remove or reassign it before adding another.",
      );
    const a: Agent = {
      ...data,
      conversation,
      id: randomUUID(),
      connected: true,
      lastActivity: now(),
      onboarding: "registered",
      briefed: false,
    };
    this.state.agents.push(a);
    this.changed();
    return a;
  }
  remove(id: string) {
    if (
      this.state.batches.some(
        (b) =>
          ["reviewed", "ready", "running"].includes(b.state) &&
          (b.actorId === id ||
            b.requesterId === id ||
            this.state.messages.find((m) => m.id === b.reviewId)?.agentId ===
              id),
      )
    )
      throw new Error(
        "Finish or reject active reviewed batches before removing an agent.",
      );
    if (this.state.runs.some((r) => r.agentId === id && r.status === "running"))
      throw new Error(
        "Cancel the active terminal run before removing its agent.",
      );
    const agent = this.agent(id);
    if (
      pendingOperatorReply(this.state, agent.taskId ?? this.state.activeTaskId)
    )
      throw new Error(
        "Reply to the pending Operator message before removing or replacing an agent in this task.",
      );
    this.state.agents = this.state.agents.filter((a) => a.id !== id);
    this.changed();
  }
  removeTask(id: string) {
    const task = this.state.tasks.find((task) => task.id === id);
    if (!task) throw new Error("Task is no longer available.");
    const taskMessageIds = new Set(
      this.state.messages
        .filter((message) => message.taskId === id)
        .map((message) => message.id),
    );
    const removed = this.state.agents.filter((a) => a.taskId === id);
    const agentIds = new Set(removed.map((agent) => agent.id));
    const taskBatchIds = new Set(
      this.state.batches
        .filter(
          (batch) =>
            [batch.proposalId, batch.reviewId, batch.forwardedId].some(
              (messageId) => messageId && taskMessageIds.has(messageId),
            ) ||
            agentIds.has(batch.requesterId) ||
            (!!batch.actorId && agentIds.has(batch.actorId)),
        )
        .map((batch) => batch.id),
    );
    for (const run of this.state.runs)
      if (run.taskId === id || agentIds.has(run.agentId))
        taskBatchIds.add(run.batchId);
    const running = runningBatchIds(this.state);
    if ([...taskBatchIds].some((batchId) => running.has(batchId)))
      throw new Error(
        "Wait for this task's running execution to finish before deleting it.",
      );
    this.state.runs = this.state.runs.filter(
      (run) => !taskBatchIds.has(run.batchId),
    );
    this.state.tasks = this.state.tasks.filter((task) => task.id !== id);
    this.state.messages = this.state.messages.filter(
      (message) => message.taskId !== id,
    );
    this.state.batches = this.state.batches.filter(
      (batch) => !taskBatchIds.has(batch.id),
    );
    this.state.agents = this.state.agents.filter((a) => a.taskId !== id);
    if (this.state.activeTaskId === id) {
      this.state.activeTaskId = this.state.tasks.reduce<
        typeof task | undefined
      >(
        (latest, candidate) =>
          !latest || candidate.created > latest.created ? candidate : latest,
        undefined,
      )?.id;
    }
    this.changed();
  }
  append(
    data: Omit<
      Message,
      "id" | "sequence" | "timestamp" | "instructionVersion" | "taskId"
    >,
    taskId = this.state.activeTaskId,
  ) {
    const message: Message = {
      ...data,
      id: randomUUID(),
      sequence: ++this.state.sequence,
      timestamp: now(),
      taskId,
      instructionVersion: this.state.instructions.hash,
    };
    this.state.messages.push(message);
    return message;
  }
  receive(agentId: string, sourceId: string, content: string): Message;
  receive(
    agentId: string,
    sourceId: string,
    content: string,
    taskId: string,
    requestId?: string,
  ): Message;
  receive(
    agentId: string,
    sourceId: string,
    content: string,
    taskId: string | null,
  ): Message | undefined;
  receive(
    agentId: string,
    sourceId: string,
    content: string,
    taskId?: string | null,
    requestId?: string,
  ): Message | undefined {
    const associatedTaskId =
      taskId === undefined
        ? (this.state.agents.find((a) => a.id === agentId)?.taskId ??
          this.state.activeTaskId)
        : (taskId ?? undefined);
    if (
      associatedTaskId &&
      !this.state.tasks.some((task) => task.id === associatedTaskId)
    )
      return;
    const existing = this.state.messages.find(
      (m) =>
        m.agentId === agentId &&
        m.sourceId === sourceId &&
        m.type === "response",
    );
    if (existing) return existing;
    const a = this.agent(agentId),
      purpose = this.state.messages.find(
        (message) => message.id === requestId,
      )?.purpose,
      parsed = parseResponse(content, { handover: purpose === "handover" });
    if (
      purpose === "handover" &&
      (parsed.sender !== "watcher" || parsed.recipient !== "operator")
    )
      parsed.issues.push(
        "All handover reports must be prepared by the Watcher using watcher->operator.",
      );
    if (parsed.sender && parsed.sender !== a.role && parsed.sender !== "setup")
      parsed.issues.push("Sender role differs from the persistent assignment.");
    if (parsed.number !== undefined && parsed.number !== a.lastNumber + 1)
      parsed.issues.push(
        `Counter mismatch: expected ${a.lastNumber + 1}, received ${parsed.number}. Confirm the missing evidence; this response will not authorize commands.`,
      );
    if (parsed.sender === "actor" && !a.briefed && parsed.batches.length)
      parsed.issues.push("Actor has not received a watcher briefing.");
    if (
      parsed.sender === "actor" &&
      parsed.recipient === "operator" &&
      parsed.batches.length
    )
      parsed.issues.push(
        "Actor batches must go through the watcher before reaching the operator.",
      );
    const m = this.append(
      {
        agentId,
        sourceId,
        conversationId: a.conversation,
        sender: a.name,
        recipient: parsed.recipient,
        role: a.role,
        type: "response",
        content,
        parsed,
        status: "received",
        replyToId: requestId,
        purpose,
        handoverRole: this.state.messages.find(
          (message) => message.id === requestId,
        )?.handoverRole,
      },
      associatedTaskId,
    );
    const blocked = hasBlockingIssues(parsed);
    if (
      parsed.sender === a.role &&
      parsed.number === a.lastNumber + 1 &&
      (parsed.contextCheck || parsed.number === 1)
    ) {
      const previous = a.contextHealth;
      const established =
        !!previous?.baselineEstablished ||
        this.state.messages.some(
          (message) =>
            message.id !== m.id &&
            message.agentId === a.id &&
            message.type === "response" &&
            message.parsed?.number === 1 &&
            message.parsed.sender === a.role,
        );
      const lost =
        parsed.contextCheck === "unavailable" ||
        (parsed.contextCheck === "not-established" && established);
      a.contextHealth = {
        baselineEstablished:
          established ||
          parsed.number === 1 ||
          parsed.contextCheck === "readable",
        status: parsed.contextCheck ?? "unknown",
        messageId: m.id,
        checkedAt: m.timestamp,
        needsOnboarding: !!previous?.needsOnboarding || lost,
      };
    }
    if (
      parsed.number === a.lastNumber + 1 &&
      (parsed.sender === a.role || parsed.sender === "setup")
    )
      a.lastNumber = parsed.number;
    a.lastActivity = now();
    if (parsed.sender === "setup" && !blocked) a.onboarding = "role-selection";
    else if (
      parsed.sender === a.role &&
      parsed.number !== undefined &&
      a.onboarding !== "registered" &&
      !blocked
    ) {
      a.onboarding = "ready";
    }
    if (!blocked && !m.purpose && !parsed.onboardingRole && !parsed.handover)
      reviewBatch(this.state, a, m, associatedTaskId);
    this.changed();
    return m;
  }
  send(
    agentId: string,
    input: string,
    sourceId?: string,
    kind: "operator" | "onboarding" | "terminal" = "operator",
    options: {
      workflow?: boolean;
      purpose?: Message["purpose"];
      handoverRole?: Role;
      replyToId?: string;
    } = {},
  ) {
    if (kind === "onboarding" || options.purpose === "onboarding")
      throw new Error(
        "Automatic onboarding has been removed. Generate a handover and replace the chat URL manually.",
      );
    const a = this.agent(agentId);
    if (!a.connected)
      throw new Error(
        "Chat disconnected. Connect the Chrome extension and reopen this task's chat URL.",
      );
    if (!input.trim()) throw new Error("Message cannot be empty.");
    const taskId = a.taskId ?? this.state.activeTaskId;
    const requiredReply = pendingOperatorReply(this.state, taskId);
    if (a.awaitingResponse)
      throw new Error(
        "Wait for this chat's previous assistant response before sending again.",
      );
    if (!options.workflow && a.taskId && a.taskId !== this.state.activeTaskId)
      throw new Error("Select this chat's task before sending.");
    if (
      requiredReply &&
      (requiredReply.agentId !== a.id ||
        options.purpose ||
        (sourceId && kind !== "terminal"))
    )
      throw new Error(
        `Your reply to ${requiredReply.role ?? requiredReply.sender} is required. Send your own answer to the agent that addressed the Operator before continuing.`,
      );
    if (options.replyToId && options.replyToId !== requiredReply?.id)
      throw new Error(
        "This is not the pending Operator question. Reply to the current requesting agent first.",
      );
    if (
      a.role === "actor" &&
      taskId &&
      !requiredReply &&
      !hasWatcherSubmission(this.state, taskId)
    )
      throw new Error(
        "Send the first task message to the Watcher and confirm its delivery before sending to the Actor.",
      );
    if (
      this.state.messages.some(
        (m) => m.agentId === agentId && isUnresolvedDelivery(m),
      )
    )
      throw new Error(
        "Resolve this agent’s pending or uncertain delivery before sending another message.",
      );
    if (sourceId && kind !== "terminal") {
      const source = this.state.messages.find((m) => m.id === sourceId);
      if (!source) throw new Error("Source response does not exist.");
      if (source.type !== "response" || source.captureRejected)
        throw new Error(
          "This message is not an accepted agent response and cannot be handed off.",
        );
      if (a.taskId && source.taskId !== a.taskId)
        throw new Error("A handoff must stay within the same task.");
      if (
        this.state.messages.some(
          (m) =>
            m.sourceId === sourceId &&
            m.agentId === agentId &&
            m.type !== "response" &&
            m.status !== "failed",
        )
      )
        throw new Error(
          "This response has already been handed to that recipient.",
        );
      if (
        source.parsed?.recipient !== "unknown" &&
        source.parsed?.recipient !== a.role
      )
        throw new Error(
          "Recipient differs from the protocol header. Ask the sender for a corrected response.",
        );
      if (source.parsed?.batches.length && input !== source.content)
        throw new Error(
          "Editing a command handoff would invalidate exact-batch review. Request a revised proposal.",
        );
      if (input !== source.content)
        throw new Error(
          "The handoff must contain the selected response's complete current text. Select that response again.",
        );
    }
    if (
      kind === "terminal" &&
      sourceId &&
      this.state.messages.some(
        (m) =>
          m.sourceId === sourceId &&
          m.type === "terminal" &&
          m.status !== "failed",
      )
    )
      throw new Error("These execution results have already been returned.");
    const content = outgoingPayload(this.state, a, input, sourceId, kind);
    const m = this.append(
      {
        agentId,
        sourceId,
        conversationId: a.conversation,
        sender: "Operator",
        recipient: a.id,
        type: kind,
        content,
        originalInput: input,
        replyToId: requiredReply?.id,
        purpose: options.purpose,
        handoverRole: options.handoverRole,
        deliveryRulesVersion,
        onboardingRole: needsAgentInstructions(this.state, a)
          ? a.role
          : undefined,
        status: "pending",
      },
      a.taskId ?? this.state.activeTaskId,
    );
    this.changed(); // Commit before the external side effect.
    if (!this.transport(m, a)) {
      m.status = "failed";
      m.error =
        "The Chrome chat connection is not ready. Nothing was submitted.";
      this.changed();
    }
    return m;
  }
  delivery(
    messageId: string,
    status: "submitted" | "failed" | "uncertain",
    error?: string,
  ) {
    const m = this.state.messages.find((m) => m.id === messageId);
    if (!m || !["pending", "uncertain"].includes(m.status)) return;
    m.status = status;
    m.error = error;
    if (status === "submitted") {
      const a = this.state.agents.find((a) => a.id === m.agentId);
      if (
        a &&
        (m.type === "onboarding" || m.onboardingRole) &&
        (!m.onboardingRole || m.onboardingRole === a.role)
      )
        a.onboarding = "packet-sent";
      const source = this.state.messages.find((s) => s.id === m.sourceId);
      if (
        a &&
        source?.role === "watcher" &&
        source.parsed?.sender === "watcher" &&
        source.parsed.recipient === "actor" &&
        !hasBlockingIssues(source.parsed)
      )
        a.briefed = true;
    }
    this.changed();
  }
  retry(messageId: string) {
    const m = this.state.messages.find((m) => m.id === messageId);
    if (!m || m.status !== "failed" || m.error?.startsWith("Retried as "))
      throw new Error(
        "Only the most recent confirmed pre-submission failure is retryable. Resolve uncertain submissions manually.",
      );
    if (m.type === "onboarding" || m.purpose === "onboarding")
      throw new Error(
        "Automatic onboarding has been removed. Generate a handover and replace the chat URL manually.",
      );
    const a = this.agent(m.agentId!);
    if (a.awaitingResponse)
      throw new Error(
        "Wait for this chat's previous assistant response before retrying.",
      );
    if (a.taskId && a.taskId !== this.state.activeTaskId)
      throw new Error("Select this chat's task before retrying.");
    if (!a.connected) throw new Error("Reconnect the recipient first.");
    const requiredReply = pendingOperatorReply(
      this.state,
      a.taskId ?? m.taskId ?? this.state.activeTaskId,
    );
    if (
      requiredReply &&
      (requiredReply.agentId !== a.id ||
        m.purpose ||
        (m.sourceId && m.type !== "terminal") ||
        (m.replyToId && m.replyToId !== requiredReply.id))
    )
      throw new Error(
        "Reply to the agent that addressed the Operator before retrying another message.",
      );
    if (m.replyToId && m.replyToId !== requiredReply?.id)
      throw new Error(
        "This Operator request has already been answered; do not retry an old answer.",
      );
    if (
      this.state.messages.some(
        (other) =>
          other.id !== m.id &&
          other.agentId === a.id &&
          isUnresolvedDelivery(other),
      )
    )
      throw new Error("Resolve another pending delivery first.");
    const addInstructions =
      needsAgentInstructions(this.state, a) &&
      (!m.onboardingRole ||
        !m.content.includes(this.state.instructions.text) ||
        m.instructionVersion !== this.state.instructions.hash ||
        m.deliveryRulesVersion !== deliveryRulesVersion);
    const retry = this.append({
      agentId: a.id,
      sourceId: m.sourceId,
      conversationId: m.conversationId,
      sender: m.sender,
      recipient: m.recipient,
      type: m.type,
      content: withContextCheck(
        addInstructions
          ? outgoingPayload(
              this.state,
              a,
              m.originalInput ?? m.content,
              m.sourceId,
              m.type,
            )
          : m.content,
        a,
      ),
      originalInput: m.originalInput,
      replyToId: m.replyToId ?? requiredReply?.id,
      purpose: m.purpose,
      handoverRole: m.handoverRole,
      deliveryRulesVersion: addInstructions
        ? deliveryRulesVersion
        : m.deliveryRulesVersion,
      onboardingRole: addInstructions ? a.role : m.onboardingRole,
      status: "pending",
    });
    m.error = `Retried as ${retry.id}`;
    this.changed();
    if (!this.transport(retry, a)) {
      retry.status = "failed";
      retry.error = "Bridge disconnected before submission.";
      this.changed();
    }
  }
  refreshCapturedCode(
    messageId: string,
    captures: { actor: string; watcher: string },
  ) {
    const batch = repairCapturedReview(this.state, messageId, captures);
    this.changed();
    return batch;
  }
  recheckReview(messageId: string) {
    const message = this.state.messages.find((entry) => entry.id === messageId);
    if (
      !message?.agentId ||
      message.type !== "response" ||
      message.captureRejected ||
      message.purpose ||
      message.taskId !== this.state.activeTaskId ||
      !message.parsed?.issues.includes(directoryMismatchIssue)
    )
      throw new Error(
        "Choose the current Watcher review blocked by a working-directory conflict.",
      );
    const watcher = this.agent(message.agentId);
    const latest = this.state.messages.findLast(
      (entry) =>
        entry.type === "response" &&
        entry.agentId === watcher.id &&
        !entry.captureRejected,
    );
    if (
      watcher.role !== "watcher" ||
      watcher.conversation !== message.conversationId ||
      watcher.awaitingResponse ||
      latest?.id !== message.id ||
      pendingOperatorReply(this.state, message.taskId)?.id !== message.id
    )
      throw new Error(
        "Recheck only the latest pending Operator request from the current Watcher.",
      );
    if (
      this.state.batches.some(
        (batch) =>
          batch.forwardedId === message.id || batch.reviewId === message.id,
      )
    )
      throw new Error(
        "This review already has a recorded batch; request a fresh proposal instead.",
      );
    const parsed = parseResponse(message.content);
    if (
      parsed.sender !== "watcher" ||
      parsed.recipient !== "operator" ||
      !parsed.approval ||
      parsed.batches.length !== 1 ||
      hasBlockingIssues(parsed) ||
      hasBlockingIssues({
        ...message.parsed,
        issues: message.parsed.issues.filter(
          (issue) => issue !== directoryMismatchIssue,
        ),
      })
    )
      throw new Error(
        "The recorded response is not an eligible exact Watcher approval.",
      );
    message.parsed = parsed;
    reviewBatch(this.state, watcher, message, message.taskId, {
      directoryCorrectionOnly: true,
    });
    const batch = this.state.batches.find(
      (entry) => entry.forwardedId === message.id && entry.state === "ready",
    );
    this.changed();
    if (!batch)
      throw new Error(
        parsed.issues.join(" ") ||
          "No unambiguous reviewed batch is available.",
      );
    return batch;
  }
  handover(taskId: string, targetRole?: Role) {
    if (taskId !== this.state.activeTaskId)
      throw new Error("Select this task before requesting a handover.");
    const blocked = handoverBlockReason(this.state, taskId, targetRole);
    if (blocked) throw new Error(blocked);
    const watcher = this.taskAgents(taskId).find(
      (agent) => agent.role === "watcher",
    );
    if (!watcher)
      throw new Error("Connect a Watcher before requesting a handover.");
    return this.send(
      watcher.id,
      handoverRequest(this.state, taskId, targetRole),
      undefined,
      "operator",
      { purpose: "handover", handoverRole: targetRole },
    );
  }
  returnRun(run: Run) {
    if (run.status === "running" || !run.finished)
      throw new Error("Wait for execution to finish.");
    const batch = this.state.batches.find((b) => b.id === run.batchId)!;
    const taskId =
      run.taskId ??
      this.state.messages.find((message) => message.id === batch.proposalId)
        ?.taskId ??
      this.state.agents.find((agent) => agent.id === run.agentId)?.taskId ??
      this.state.activeTaskId;
    const requiredReply = pendingOperatorReply(this.state, taskId);
    if (requiredReply && batch.forwardedId !== requiredReply.id)
      throw new Error(
        "Return the output requested by the current Operator message; an older run cannot answer another request.",
      );
    const watcher = this.taskAgents(taskId).find((a) => a.role === "watcher");
    const recipient = batch.inspection ? this.agent(run.agentId) : watcher;
    if (!recipient)
      throw new Error(
        "Register the watcher to receive and relay the execution evidence.",
      );
    if (run.truncated)
      throw new Error(
        "Output exceeded the UI limit. Open the complete stdout/stderr logs, select relevant evidence, and send it using the composer. No output will be silently discarded.",
      );
    return this.send(
      recipient.id,
      `${executionResult(run)}\n\nRelay this actual evidence to the requesting actor; do not infer success.`,
      `run:${run.id}`,
      "terminal",
    );
  }
}
