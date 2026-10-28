import type { Agent, Role } from "../../../../packages/shared/types";
import type { Orchestrator } from "../../../../packages/orchestration/core";
import type { ExtensionEvent } from "../../../../packages/chrome-connection/protocol";
import { adapterForURL } from "../../../../packages/chrome-connection/adapters";
import { ExtensionBridge } from "./extension-bridge";
import { matchesExpectedResponse } from "../../../../packages/chrome-connection/page";
import { canonicalConversation } from "../../../../packages/shared/conversation";
import { acceptManualHandover } from "../../../../packages/orchestration/handover";
import { capturedReviewPair } from "../../../../packages/orchestration/capture-repair";

export class ChatConnections {
  readonly bridge: ExtensionBridge;
  selectedTaskId?: string;
  private awaiting = new Map<string, { deliveryId: string; taskId: string }>();
  constructor(
    private readonly core: Orchestrator,
    token: string,
  ) {
    let recoveredCapture = false;
    for (const agent of this.core.state.agents) {
      const last = this.core.state.messages
        .filter((message) => message.agentId === agent.id)
        .at(-1);
      const delivery =
        last?.type === "response"
          ? this.core.state.messages.find(
              (message) => message.id === last.replyToId,
            )
          : undefined;
      if (
        agent.taskId &&
        last &&
        delivery &&
        last.sourceId?.startsWith(`${delivery.id}:`) &&
        delivery.agentId === agent.id &&
        delivery.type !== "onboarding" &&
        delivery.purpose !== "onboarding" &&
        delivery.status === "submitted" &&
        !matchesExpectedResponse(
          last.content,
          agent.role,
          agent.lastNumber + 1,
        ) &&
        !last.parsed?.number
      ) {
        // An earlier extension could attach a pre-existing greeting to a new
        // delivery. Inspect for its real reply without sending the prompt again.
        last.captureRejected = true;
        last.error =
          "This captured answer did not match the sent message's role and response number. Relay is inspecting the chat for the actual reply; the prompt will not be resent.";
        this.awaiting.set(agent.id, {
          deliveryId: delivery.id,
          taskId: agent.taskId,
        });
        agent.awaitingResponse = true;
        recoveredCapture = true;
      }
      if (
        agent.taskId &&
        last &&
        last.type !== "response" &&
        last.type !== "onboarding" &&
        last.purpose !== "onboarding" &&
        (agent.awaitingResponse ||
          (last.status === "uncertain" && !last.error?.startsWith("Imported")))
      ) {
        this.awaiting.set(agent.id, {
          deliveryId: last.id,
          taskId: agent.taskId,
        });
        agent.awaitingResponse = true;
      }
    }

    this.bridge = new ExtensionBridge(
      token,
      (connected) => {
        if (!connected)
          for (const agent of this.core.state.agents) {
            agent.connected = false;
            agent.error = "Chrome extension disconnected.";
          }
        this.core.changed();
        if (connected) void this.connectSelectedTask();
      },
      (event) => this.onExtensionEvent(event),
    );
    this.configureTransport();
    if (recoveredCapture) this.core.changed();
  }
  async connectChat(taskId: string, role: Role, url: string) {
    adapterForURL(url);
    const old = this.core.state.agents.find(
      (agent) =>
        agent.taskId === taskId && agent.role === role && !agent.staged,
    );
    const agent = this.core.connectChat(taskId, role, url);
    if (old && old.id !== agent.id) await this.discardConnection(old.id);
    this.selectedTaskId = taskId;
    await this.connectAgent(agent);
  }
  private connectAgent = async (agent: Agent) => {
    if (!this.core.state.agents.includes(agent)) return;
    agent.connected = false;
    agent.error = undefined;
    if (!this.bridge.connected) {
      agent.error =
        "Connect the Chrome extension in your signed-in profile first.";
      this.core.changed();
      return;
    }
    try {
      adapterForURL(agent.conversation);
      const result = await this.bridge.request({
        type: "connect",
        agentId: agent.id,
        taskId: agent.taskId!,
        url: agent.conversation,
        role: agent.role,
        lastNumber: agent.lastNumber,
        resumeDeliveryId: this.awaiting.get(agent.id)?.deliveryId,
        activeAgentIds: this.core.state.agents.map((current) => current.id),
      });
      if (!this.core.state.agents.includes(agent)) return;
      agent.connected = !!result?.ready;
      agent.error =
        result?.error ??
        (!result?.ready
          ? "Open the chat in Chrome and sign in, then reconnect its URL."
          : undefined);
      if (!this.awaiting.has(agent.id) && result?.ready && result.response)
        acceptManualHandover(this.core.state, agent, result.response);
      if (
        !this.awaiting.has(agent.id) &&
        agent.onboarding === "registered" &&
        result?.lastNumber &&
        result.lastNumber > agent.lastNumber &&
        result.lastRole === agent.role
      )
        agent.lastNumber = result.lastNumber;
    } catch (error) {
      agent.error = error instanceof Error ? error.message : String(error);
    }
    this.core.changed();
  };
  async refreshCapturedCode(messageId: string) {
    const pair = capturedReviewPair(this.core.state, messageId);
    if (this.awaiting.has(pair.actor.id) || this.awaiting.has(pair.watcher.id))
      throw new Error(
        "Wait for the pending chat reply before refreshing captured code.",
      );
    if (!this.bridge.connected)
      throw new Error("Connect the updated Chrome extension first.");
    const read = async (role: "actor" | "watcher") => {
      const agent = pair[role];
      const result = await this.bridge.request({
        type: "connect",
        agentId: agent.id,
        taskId: agent.taskId!,
        url: agent.conversation,
        role,
        lastNumber: agent.lastNumber,
        activeAgentIds: this.core.state.agents.map((current) => current.id),
      });
      if (
        !result?.ready ||
        !result.response ||
        !result.url ||
        canonicalConversation(result.url) !==
          canonicalConversation(agent.conversation)
      )
        throw new Error(
          result?.error ??
            "Open the saved chat and reconnect the updated extension before refreshing its code.",
        );
      return result.response;
    };
    const [actor, watcher] = await Promise.all([
      read("actor"),
      read("watcher"),
    ]);
    this.core.refreshCapturedCode(messageId, { actor, watcher });
  }
  async connectSelectedTask() {
    if (!this.selectedTaskId) return;
    await Promise.all(
      this.core.state.agents
        .filter((agent) => agent.taskId === this.selectedTaskId)
        .map(this.connectAgent),
    );
  }
  private onExtensionEvent(event: ExtensionEvent) {
    if (event.type === "status") {
      const agent = this.core.state.agents.find(
        (entry) => entry.id === event.agentId,
      );
      if (!agent) return;
      if (event.url && this.awaiting.has(agent.id)) {
        try {
          if (
            adapterForURL(event.url).id === adapterForURL(agent.conversation).id
          )
            agent.conversation = event.url;
        } catch {
          return;
        }
      }
      agent.connected = event.ready;
      agent.error = event.error;
      this.core.changed();
    }
    if (event.type === "response") {
      const pending = this.awaiting.get(event.agentId);
      const agent = this.core.state.agents.find(
        (entry) => entry.id === event.agentId,
      );
      if (
        !agent ||
        !pending ||
        pending.deliveryId !== event.deliveryId ||
        pending.taskId !== event.taskId ||
        agent.taskId !== event.taskId
      )
        return;
      if (!this.core.state.tasks.some((task) => task.id === event.taskId))
        return;
      if (
        !matchesExpectedResponse(
          event.content,
          agent.role,
          agent.lastNumber + 1,
        ) ||
        canonicalConversation(event.url) !==
          canonicalConversation(agent.conversation)
      ) {
        const error = `Waiting for ${agent.name} RESPONSE NUMBER ${agent.lastNumber + 1} from this task's chat. An unmatched answer was ignored; the outgoing message will not be resent.`;
        if (agent.error !== error || agent.connected) {
          agent.error = error;
          agent.connected = false;
          this.core.changed();
        }
        return false;
      }
      agent.connected = true;
      agent.error = undefined;
      agent.awaitingResponse = false;
      this.awaiting.delete(agent.id);
      this.core.delivery(pending.deliveryId, "submitted");
      this.core.receive(
        agent.id,
        event.sourceId,
        event.content,
        event.taskId,
        pending.deliveryId,
      );
    }
  }
  async discardConnection(agentId: string) {
    this.awaiting.delete(agentId);
    if (this.bridge.connected)
      await this.bridge
        .request({ type: "disconnect", agentId })
        .catch(() => {});
  }
  private configureTransport() {
    this.core.transport = (message, agent) => {
      if (
        !this.bridge.connected ||
        !agent.taskId ||
        !agent.connected ||
        this.awaiting.has(agent.id)
      )
        return false;
      this.awaiting.set(agent.id, {
        deliveryId: message.id,
        taskId: agent.taskId,
      });
      agent.awaitingResponse = true;
      this.core.changed();
      void this.bridge
        .request({
          type: "send",
          agentId: agent.id,
          deliveryId: message.id,
          content: message.content,
          expectedNumber: agent.lastNumber + 1,
        })
        .then((result) => {
          const status = result?.status ?? "uncertain";
          if (
            status === "failed" &&
            this.awaiting.get(agent.id)?.deliveryId === message.id
          ) {
            this.awaiting.delete(agent.id);
            agent.awaitingResponse = false;
          }
          this.core.delivery(message.id, status, result?.error);
        })
        .catch((error) => {
          this.core.delivery(message.id, "uncertain", String(error));
        });
      return true;
    };
  }
}
