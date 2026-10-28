import { useState } from "react";
import type {
  Agent,
  Message,
  Task,
} from "../../../../../packages/shared/types";
import { handoverBlockReason } from "../../../../../packages/shared/task-start";
import type { Perform } from "../../ui";

export function ProtocolTools({
  task,
  agents,
  messages,
  perform,
  blocked = false,
}: {
  task: Task;
  agents: Agent[];
  messages: Message[];
  perform: Perform;
  blocked?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const watcher = agents.find((agent) => agent.role === "watcher");
  return (
    <section className="protocol-tools" aria-label="Task tools">
      <div className="protocol-command-actions">
        {([undefined, "actor", "watcher"] as const).map((targetRole) => {
          const unavailableReason = handoverBlockReason(
            { agents, messages },
            task.id,
            targetRole,
          );
          return (
            <button
              key={targetRole ?? "project"}
              disabled={
                blocked ||
                busy ||
                !!unavailableReason ||
                !watcher?.connected ||
                !!watcher?.awaitingResponse
              }
              title={unavailableReason}
              onClick={async () => {
                setBusy(true);
                try {
                  await perform({
                    type: "handover",
                    taskId: task.id,
                    ...(targetRole ? { targetRole } : {}),
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {targetRole ? `handover for new ${targetRole}` : "handover"}
            </button>
          );
        })}
      </div>
      <span className="muted">
        The Watcher prepares all three reports for the Operator. Replacement
        packets include agent.md and the selected role's briefing and response
        number.
      </span>
    </section>
  );
}
