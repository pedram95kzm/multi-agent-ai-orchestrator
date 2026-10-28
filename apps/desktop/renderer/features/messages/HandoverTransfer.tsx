import { useEffect, useMemo, useState } from "react";
import type { AppState, Message } from "../../../../../packages/shared/types";
import { copy } from "../../ui";
import { manualHandoverPacket } from "../../../../../packages/orchestration/handover";

export function HandoverTransfer({
  state,
  report,
  taskId,
}: {
  state: AppState;
  report: Message;
  taskId: string;
}) {
  const role = report.handoverRole;
  const [copied, setCopied] = useState("");
  const content = useMemo(
    () => manualHandoverPacket(state, taskId, report, role),
    [state, taskId, report, role],
  );
  useEffect(() => setCopied(""), [content]);
  return (
    <section className="handover-transfer" aria-label="Manual handover">
      <p>
        {role
          ? `Handover for new ${role}: complete project report, full active agent.md, role definition, responsibilities and continued response number.`
          : "Project handover: the complete project report and recorded evidence."}
      </p>
      <div className="inline">
        <button
          type="button"
          className="primary"
          onClick={async () => {
            try {
              await copy(content);
              setCopied("Copied");
            } catch {
              setCopied("Copy failed — try again");
            }
          }}
        >
          {copied || "Copy complete handover"}
        </button>
      </div>
      {role && (
        <p>
          Paste it manually into a new chat. Its receipt reply must repeat the
          last response number without increasing it. Then paste the new URL
          into {role === "actor" ? "Actor Chat URL" : "Watcher Chat URL"} above.
        </p>
      )}
      <details>
        <summary>
          {role
            ? "Preview complete handover with agent.md"
            : "Preview project handover"}
        </summary>
        <textarea
          aria-label="Complete handover packet"
          readOnly
          value={content}
          spellCheck={false}
        />
      </details>
    </section>
  );
}
