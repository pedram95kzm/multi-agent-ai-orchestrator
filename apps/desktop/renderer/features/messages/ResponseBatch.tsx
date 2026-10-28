import { useState } from "react";
import type {
  Agent,
  Batch,
  BatchShell,
  Run,
} from "../../../../../packages/shared/types";
import { copy, type Perform } from "../../ui";
import { CodeBlock } from "./CodeBlock";
import { executionResult } from "../../../../../packages/shared/executions";

export function BatchActions({
  batch,
  run,
  anyRunning,
  blocked = false,
  perform,
}: {
  batch: Batch;
  run?: Run;
  anyRunning: boolean;
  blocked?: boolean;
  perform: Perform;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  return (
    <>
      {batch.state === "ready" && !run && (
        <button
          type="button"
          disabled={busy || anyRunning || blocked || !batch.cwd}
          title="Approve and execute this exact batch"
          onClick={async () => {
            setBusy(true);
            try {
              await perform({ type: "run", batchId: batch.id, approved: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          Execute command
        </button>
      )}
      <button
        type="button"
        disabled={!run?.finished}
        aria-label="Copy result"
        onClick={async () => {
          if (!run?.finished) return;
          try {
            await copy(executionResult(run));
            setCopied("Result copied");
          } catch {
            setCopied("Copy failed — try again");
          }
        }}
      >
        {copied || "Copy result"}
      </button>
    </>
  );
}

export function ResponseBatch({
  command,
  code = command,
  batch,
  shell = batch?.shell ?? "bash",
  run,
  anyRunning,
  perform,
  watcher,
  watcherApproval = false,
  showExecution = true,
  showCode = true,
  blocked = false,
}: {
  command: string;
  code?: string;
  shell?: BatchShell;
  batch?: Batch;
  run?: Run;
  anyRunning: boolean;
  perform: Perform;
  watcher?: Agent;
  watcherApproval?: boolean;
  showExecution?: boolean;
  showCode?: boolean;
  blocked?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="summary-batch">
      {showCode && (
        <CodeBlock
          code={code}
          language={shell}
          actions={
            showExecution && batch ? (
              <BatchActions
                batch={batch}
                run={run}
                anyRunning={anyRunning}
                blocked={blocked}
                perform={perform}
              />
            ) : undefined
          }
        />
      )}
      {batch?.cwd && <p className="path">Working directory: {batch.cwd}</p>}
      {showExecution && batch?.state === "ready" && !run ? (
        <p className="muted">
          {batch.cwd
            ? "Click Execute command to approve this batch. Its output will fill the first answer field for review and submission."
            : "Confirm the working directory in chat and have the Watcher include Working directory: <absolute path> with the batch before execution."}
        </p>
      ) : (
        <p className="muted">
          {run
            ? `Execution ${run.status} · exit ${run.exitCode ?? "unknown"}`
            : batch
              ? `Batch ${batch.state}${["proposed", "reviewed"].includes(batch.state) ? " · waiting for Watcher approval and forwarding to Operator" : ""}`
              : "Execution unavailable · no eligible batch recorded"}
        </p>
      )}
      {showExecution && run && (
        <div className="execution-result">
          <details open>
            <summary>Standard output</summary>
            <CodeBlock
              code={run.stdout || "(empty)"}
              language="text"
              label="stdout"
            />
          </details>
          <details>
            <summary>Standard error</summary>
            <CodeBlock
              code={run.stderr || "(empty)"}
              language="text"
              label="stderr"
            />
          </details>
          {run.truncated && (
            <p className="warning">
              Output preview truncated. Full output is saved in the local data
              folder at {run.logPath}.
            </p>
          )}
          <button
            disabled={
              busy ||
              blocked ||
              (!run.finished && run.status !== "running") ||
              (run.status !== "running" &&
                (!watcher?.connected ||
                  !!watcher.awaitingResponse ||
                  run.truncated))
            }
            onClick={() =>
              void perform(
                run.status === "running"
                  ? { type: "cancelRun", runId: run.id }
                  : { type: "returnRun", runId: run.id },
              )
            }
          >
            {run.status === "running"
              ? "Cancel execution"
              : "Return evidence to watcher"}
          </button>
        </div>
      )}
      {batch &&
        !run &&
        ["proposed", "reviewed", "ready"].includes(batch.state) && (
          <button
            disabled={busy || anyRunning}
            onClick={() =>
              void perform({ type: "rejectBatch", batchId: batch.id })
            }
          >
            Reject / withdraw batch
          </button>
        )}
      {(batch?.state === "reviewed" || (!batch && watcherApproval)) &&
        watcher && (
          <button
            className="primary"
            disabled={
              busy ||
              blocked ||
              !watcher.connected ||
              !!watcher.awaitingResponse
            }
            onClick={async () => {
              setBusy(true);
              try {
                await perform({
                  type: "send",
                  agentId: watcher.id,
                  content: `Please complete the execution handoff now. Your next response must use watcher->operator, include APPROVED on its own line, repeat this exact reviewed ${shell} batch without edits, and ask a numbered question telling me to run it in the specified shell and paste stdout, stderr, and the exit code. Do not send another standby message to the Actor or wait for another Operator message. No execution has been confirmed.\n\nWorking directory: ${batch?.cwd ?? "use the confirmed task workspace"}\n\n\`\`\`${shell}\n${command}\n\`\`\``,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            Request execution instructions
          </button>
        )}
    </div>
  );
}
