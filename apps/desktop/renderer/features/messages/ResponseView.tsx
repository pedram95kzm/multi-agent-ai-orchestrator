import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  Batch,
  Message,
  Run,
  AppState,
} from "../../../../../packages/shared/types";
import {
  formatAnswers,
  withOperatorExplanation,
} from "../../../../../packages/protocol/parser";
import { copy, time, type Perform } from "../../ui";
import { MessageContent } from "./MessageContent";
import { ResponseBatch, BatchActions } from "./ResponseBatch";
import {
  directoryMismatchIssue,
  executionResult,
} from "../../../../../packages/shared/executions";
import { fencedCodeBlocks } from "../../../../../packages/protocol/fences";
import { HandoverTransfer } from "./HandoverTransfer";
import { OperatorExplanation } from "../../components/OperatorExplanation";

export function ResponseView({
  message: m,
  agents,
  send,
  perform,
  batches = [],
  runs = [],
  anyRunning = false,
  blocked = false,
  requiredReply,
  handoverState,
}: {
  message: Message;
  agents: Agent[];
  send: (
    agent: Agent,
    message: Message,
  ) => void | boolean | Promise<void | boolean>;
  perform: Perform;
  batches?: Batch[];
  runs?: Run[];
  anyRunning?: boolean;
  blocked?: boolean;
  requiredReply?: Message | null;
  handoverState?: AppState;
}) {
  const [complete, setComplete] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = agents.find((a) => a.id === m.agentId);
  const codeBlocks = fencedCodeBlocks(m.content);
  const isHandover =
    m.type === "response" &&
    m.purpose === "handover" &&
    m.parsed?.handover &&
    m.parsed.sender === "watcher" &&
    m.parsed.recipient === "operator";
  const executionBatch = batches.find((batch) => batch.forwardedId === m.id);
  const completedRun = runs.find(
    (run) => run.batchId === executionBatch?.id && !!run.finished,
  );
  const questions = m.parsed?.questions.length
    ? m.parsed.questions
    : executionBatch
      ? [
          {
            id: "q1",
            text: `Please run the approved batch in ${executionBatch.shell === "powershell" ? "Windows PowerShell" : "Bash"} in the specified working directory, then paste its actual stdout, stderr, and exit code here.`,
          },
        ]
      : [];
  const firstQuestion = questions[0]?.id;
  const filledRun = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      !completedRun ||
      !firstQuestion ||
      filledRun.current === completedRun.id
    )
      return;
    filledRun.current = completedRun.id;
    setAnswers((previous) => ({
      ...previous,
      [firstQuestion]: executionResult(completedRun),
    }));
  }, [completedRun, firstQuestion]);
  const watcherApproval =
    m.parsed?.sender === "watcher" &&
    m.parsed.approval &&
    !!m.parsed.batches.length;
  const destinations = agents.filter(
    (a) =>
      a.id !== m.agentId &&
      !m.captureRejected &&
      m.purpose !== "onboarding" &&
      m.purpose !== "handover" &&
      !watcherApproval &&
      (m.parsed?.recipient === "unknown" || m.parsed?.recipient === a.role),
  );
  return (
    <article
      className={`message ${m.role ?? "operator"}`}
      id={`message-${m.id}`}
    >
      <div className="message-head">
        <span className={`role-icon ${m.role}`}>
          {m.role === "watcher" ? "W" : m.role === "actor" ? "A" : "O"}
        </span>
        <strong>{m.sender}</strong>
        <span className="muted">
          →{" "}
          {m.recipient === "operator"
            ? "You (Operator)"
            : (agents.find((a) => a.id === m.recipient)?.name ?? m.recipient)}
        </span>
        <span className="response-number">
          {m.parsed?.number ? `#${m.parsed.number}` : `· ${m.sequence}`}
        </span>
        <time>{time(m.timestamp)}</time>
      </div>
      <div className="message-body">
        {m.parsed?.sender === "watcher" &&
          m.parsed.approval &&
          m.parsed.recipient === "operator" &&
          !m.parsed.batches.length &&
          /\n```markdown\n/.test(m.content) &&
          !m.captureRejected &&
          !m.purpose && (
            <button
              type="button"
              disabled={
                busy || blocked || anyRunning || !!agent?.awaitingResponse
              }
              title="Read the same Actor proposal and Watcher approval again using the updated extension; no message is sent and no command is executed"
              onClick={async () => {
                setBusy(true);
                try {
                  await perform({
                    type: "refreshCapturedCode",
                    messageId: m.id,
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Refresh captured code
            </button>
          )}
        {watcherApproval &&
          m.parsed?.issues.includes(directoryMismatchIssue) && (
            <button
              type="button"
              disabled={
                busy || blocked || anyRunning || !!agent?.awaitingResponse
              }
              title="Recheck the recorded exact approval against its delivered Actor directory correction; no commands are executed"
              onClick={async () => {
                setBusy(true);
                try {
                  await perform({ type: "recheckReview", messageId: m.id });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Recheck recorded review
            </button>
          )}
        {handoverState && isHandover && m.taskId && m.parsed?.handover && (
          <HandoverTransfer
            state={handoverState}
            report={m}
            taskId={m.taskId}
          />
        )}
        {(m.parsed?.summary || !!m.parsed?.batches.length) && (
          <div className="summary">
            {m.parsed?.summary && (
              <>
                <span className="eyebrow">AGENT SUMMARY</span>
                <p>{m.parsed.summary}</p>
              </>
            )}
            {m.parsed?.batches.map((command, index) => {
              const batch = batches.find(
                (batch) =>
                  batch.command === command &&
                  [
                    batch.proposalId,
                    batch.reviewId,
                    batch.forwardedId,
                  ].includes(m.id),
              );
              return (
                <ResponseBatch
                  key={index}
                  command={command}
                  shell={
                    m.parsed?.batchShells?.[index] ?? batch?.shell ?? "bash"
                  }
                  code={
                    codeBlocks.find(
                      (block) =>
                        block.code.replace(/\r\n/g, "\n").replace(/\n$/, "") ===
                        command,
                    )?.code
                  }
                  batch={batch}
                  run={runs.find((run) => run.batchId === batch?.id)}
                  anyRunning={anyRunning}
                  perform={perform}
                  watcher={agents.find((agent) => agent.role === "watcher")}
                  watcherApproval={watcherApproval}
                  showExecution={batch?.forwardedId === m.id}
                  showCode={!complete}
                  blocked={blocked}
                />
              );
            })}
          </div>
        )}
        {m.type === "onboarding" && (
          <p className="muted">
            Historical transfer packet · complete protocol, confirmed counters,
            task context, and recorded evidence.
          </p>
        )}
        {complete && (
          <MessageContent
            content={m.content}
            codeActions={(code) => {
              const command = code.replace(/\r\n/g, "\n").replace(/\n$/, "");
              const batch = batches.find(
                (batch) =>
                  batch.command === command && batch.forwardedId === m.id,
              );
              return batch ? (
                <BatchActions
                  batch={batch}
                  run={runs.find((run) => run.batchId === batch.id)}
                  anyRunning={anyRunning}
                  blocked={blocked}
                  perform={perform}
                />
              ) : undefined;
            }}
          />
        )}
        {!complete && m.type !== "response" && m.type !== "onboarding" && (
          <p className="message-preview">
            {(m.originalInput ?? m.content).slice(0, 180)}
            {(m.originalInput ?? m.content).length > 180 ? "…" : ""}
          </p>
        )}
        {m.onboardingRole && m.type !== "onboarding" && (
          <>
            <p className="muted">
              Complete agent instructions included with this message.
            </p>
          </>
        )}
        {m.parsed?.operatorInput && (
          <details>
            <summary>Operator input relayed with this response</summary>
            <MessageContent content={m.parsed.operatorInput} />
          </details>
        )}
        <button
          className="text-button"
          aria-expanded={complete}
          onClick={() => setComplete(!complete)}
        >
          {complete ? "Hide complete text" : "Show complete text"}
        </button>
        {!!m.parsed?.issues.length && (
          <details className="warning">
            <summary>
              {m.parsed.issues.length} protocol notice
              {m.parsed.issues.length !== 1 ? "s" : ""}
            </summary>
            {m.parsed.issues.map((i) => (
              <p key={i}>{i}</p>
            ))}
          </details>
        )}
        {!m.captureRejected &&
          m.parsed?.recipient === "operator" &&
          !!questions.length &&
          agent && (
            <form
              className="questions"
              onSubmit={async (e) => {
                e.preventDefault();
                if (requiredReply !== undefined && requiredReply?.id !== m.id)
                  return;
                setBusy(true);
                try {
                  if (
                    await perform({
                      type: "send",
                      agentId: agent.id,
                      replyToId: m.id,
                      content: withOperatorExplanation(
                        formatAnswers(questions, answers),
                        explanation,
                      ),
                    })
                  ) {
                    setAnswers({});
                    setExplanation("");
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span className="eyebrow">YOUR ANSWERS</span>
              {questions.map((q) => (
                <label key={q.id}>
                  <strong>{q.id}</strong> {q.text}
                  <textarea
                    required
                    placeholder="Paste the result or type your answer…"
                    spellCheck={false}
                    value={answers[q.id] ?? ""}
                    onChange={(e) =>
                      setAnswers({ ...answers, [q.id]: e.target.value })
                    }
                  />
                </label>
              ))}
              <OperatorExplanation
                value={explanation}
                onChange={setExplanation}
              />
              <button
                disabled={
                  busy ||
                  blocked ||
                  (requiredReply !== undefined && requiredReply?.id !== m.id) ||
                  (executionBatch &&
                    runs.some(
                      (run) =>
                        run.batchId === executionBatch.id &&
                        run.status === "running",
                    )) ||
                  !agent.connected ||
                  !!agent.awaitingResponse
                }
                className="primary"
              >
                Submit Answers
              </button>
            </form>
          )}
        {m.type === "response" && !!destinations.length && (
          <OperatorExplanation value={explanation} onChange={setExplanation} />
        )}
        <div className="message-actions">
          <span className={`status ${m.status}`}>{m.status}</span>
          {!(handoverState && isHandover) && (
            <button onClick={() => void copy(m.content)}>Copy full text</button>
          )}
          {m.type === "response" &&
            destinations.map((a) => (
              <button
                key={a.id}
                className={`primary send-${a.role}`}
                disabled={
                  busy ||
                  blocked ||
                  !!requiredReply ||
                  !a.connected ||
                  !!a.awaitingResponse
                }
                title={
                  !a.connected
                    ? "Open this conversation in Chrome"
                    : a.awaitingResponse
                      ? "Waiting for this chat's previous reply"
                      : "Send the complete reply directly to this chat"
                }
                onClick={async () => {
                  setBusy(true);
                  try {
                    if (
                      await send(a, {
                        ...m,
                        content: withOperatorExplanation(
                          m.content,
                          explanation,
                        ),
                      })
                    )
                      setExplanation("");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Send to {a.role === "actor" ? "Actor" : "Watcher"}
              </button>
            ))}
          {m.type === "response" &&
            m.parsed?.recipient !== "operator" &&
            !watcherApproval &&
            !m.captureRejected &&
            !destinations.length && (
              <span className="warning">
                Register the intended recipient to hand off.
              </span>
            )}
          {m.status === "failed" &&
            m.type !== "onboarding" &&
            m.purpose !== "onboarding" && (
              <button
                disabled={blocked}
                onClick={() => void perform({ type: "retry", messageId: m.id })}
              >
                Retry confirmed failure
              </button>
            )}
          {m.status === "failed" &&
            agent &&
            !m.purpose &&
            m.type !== "onboarding" && (
              <button
                disabled={blocked}
                onClick={() =>
                  send(agent, { ...m, content: m.originalInput ?? m.content })
                }
              >
                Edit original input
              </button>
            )}
          {m.status === "uncertain" &&
            m.type !== "onboarding" &&
            m.purpose !== "onboarding" && (
              <button
                onClick={() =>
                  void perform({ type: "confirmSubmission", messageId: m.id })
                }
              >
                I confirmed submission in the chat
              </button>
            )}
        </div>
        {m.error && <p className="warning">{m.error}</p>}
      </div>
    </article>
  );
}
