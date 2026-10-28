import type { RefObject } from "react";
import type {
  Agent,
  Message,
  Snapshot,
} from "../../../../../packages/shared/types";
import {
  outgoingPayload,
  isUnresolvedDelivery,
} from "../../../../../packages/shared/outgoing";
import { hasWatcherSubmission } from "../../../../../packages/shared/task-start";
import { MessageContent } from "../messages/MessageContent";
export function MessageComposer({
  state,
  agents,
  draft,
  setDraft,
  sending,
  current,
  requiredReply,
  composer,
  submit,
}: {
  state: Snapshot;
  agents: Agent[];
  draft: string;
  setDraft: (draft: string) => void;
  sending: boolean;
  current?: Agent;
  requiredReply?: Message;
  composer: RefObject<HTMLTextAreaElement | null>;
  submit: (agent?: Agent) => Promise<void>;
}) {
  const waitingForWatcher =
    !requiredReply && !hasWatcherSubmission(state, state.activeTaskId);
  return (
    <div className="composer" role="region" aria-label="Message composer">
      {requiredReply && (
        <p className="warning" role="status">
          Your reply to {requiredReply.role === "actor" ? "Actor" : "Watcher"}{" "}
          is required before continuing.
        </p>
      )}
      <textarea
        ref={composer}
        aria-label="Message"
        placeholder="Write an instruction or review a handoff…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-bottom">
        <details>
          <summary>
            Outgoing message preview · {current?.role ?? "watcher"}
          </summary>
          <MessageContent
            content={current ? outgoingPayload(state, current, draft) : draft}
          />
        </details>
        <div className="composer-send-actions">
          {(["actor", "watcher"] as const).map((role) => {
            const target = agents.find((agent) => agent.role === role);
            const unavailable =
              (!!requiredReply && target?.id !== requiredReply.agentId) ||
              (role === "actor" && waitingForWatcher) ||
              !target?.connected ||
              target.awaitingResponse ||
              state.messages.some(
                (message) =>
                  message.agentId === target?.id &&
                  isUnresolvedDelivery(message),
              );
            return (
              <button
                key={role}
                className={`primary send-${role}`}
                disabled={!draft.trim() || unavailable || sending}
                title={
                  requiredReply && target?.id !== requiredReply.agentId
                    ? "Reply to the agent that addressed the Operator first"
                    : role === "actor" && waitingForWatcher
                      ? "Send the first task message to the Watcher first"
                      : undefined
                }
                onClick={() => void submit(target)}
              >
                Send to {role === "actor" ? "Actor" : "Watcher"}
              </button>
            );
          })}
        </div>
      </div>
      <small className="muted">
        {sending ? "Sending… · " : ""}Ctrl + Enter sends to{" "}
        {current?.role ?? "watcher"} · Sent through the Chrome extension.
      </small>
    </div>
  );
}
