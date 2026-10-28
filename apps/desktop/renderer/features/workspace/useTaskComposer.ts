import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  Message,
  Snapshot,
  Task,
} from "../../../../../packages/shared/types";
import type { Perform } from "../../ui";
import { hasWatcherSubmission } from "../../../../../packages/shared/task-start";
import { pendingOperatorReply } from "../../../../../packages/shared/operator-replies";
import { isUnresolvedDelivery } from "../../../../../packages/shared/outgoing";
export function useTaskComposer(
  state: Snapshot,
  task: Task,
  agents: Agent[],
  messages: Message[],
  perform: Perform,
) {
  const [recipient, setRecipient] = useState(
    agents.find((agent) => agent.role === "watcher")?.id ?? "",
  );
  const [draft, setDraft] = useState(
    messages.length
      ? ""
      : `Task type: ${task.kind}\nOperating system: ${task.operatingSystem ?? "UNKNOWN — ask the operator before proposing commands"}\nExpected outcome and context:\n${task.title}`,
  );
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
  const requiredReply = pendingOperatorReply(state, task.id);
  const waitingForWatcher =
    !requiredReply && !hasWatcherSubmission(state, task.id);
  const current = agents.find((agent) =>
    requiredReply
      ? agent.id === requiredReply.agentId
      : waitingForWatcher
        ? agent.role === "watcher"
        : agent.id === recipient,
  );
  useEffect(() => {
    if (!agents.some((agent) => agent.id === recipient))
      setRecipient(agents.find((agent) => agent.role === "watcher")?.id ?? "");
  }, [agents.map((agent) => agent.id).join(","), recipient]);
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  const handoff = async (agent: Agent, message: Message) => {
    if (
      requiredReply &&
      (message.type === "response" || agent.id !== requiredReply.agentId)
    )
      return;
    if (message.type === "response") {
      await perform({
        type: "send",
        agentId: agent.id,
        content: message.content,
        sourceId: message.id,
      });
      return;
    }
    setRecipient(agent.id);
    setDraft(message.content);
    composer.current?.focus();
  };
  const submit = async (target = current) => {
    if (
      (requiredReply && target?.id !== requiredReply.agentId) ||
      (target?.role === "actor" && waitingForWatcher) ||
      !target?.connected ||
      target.awaitingResponse ||
      !draft.trim() ||
      sending ||
      state.messages.some(
        (message) =>
          message.agentId === target.id && isUnresolvedDelivery(message),
      )
    )
      return;
    setRecipient(target.id);
    setSending(true);
    try {
      if (
        await perform({
          type: "send",
          agentId: target.id,
          content: draft,
        })
      ) {
        setDraft("");
        following.current = true;
      }
    } finally {
      setSending(false);
    }
  };
  const unresolved = state.messages.some(
    (message) =>
      message.agentId === current?.id && isUnresolvedDelivery(message),
  );

  return {
    recipient,
    setRecipient,
    draft,
    setDraft,
    sending,
    current,
    requiredReply,
    unresolved,
    composer,
    submit,
    handoff,
    following,
    end,
  };
}
