import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, Role, Task } from "../../../../../packages/shared/types";
import { adapterForURL } from "../../../../../packages/chrome-connection/adapters";
import type { Perform } from "../../ui";
export function ChatURL({
  task,
  role,
  agent,
  perform,
}: {
  task: Task;
  role: Role;
  agent?: Agent;
  perform: Perform;
}) {
  const [url, setURL] = useState(agent?.conversation ?? "");
  const [busy, setBusy] = useState(false);
  const attempted = useRef("");
  useEffect(() => {
    if (agent?.conversation) setURL(agent.conversation);
  }, [agent?.conversation]);
  const connect = useCallback(
    async (automatic = false) => {
      if (busy || !url.trim()) return;
      try {
        adapterForURL(url.trim());
      } catch {
        return;
      }
      if (automatic && attempted.current === url.trim()) return;
      attempted.current = url.trim();
      setBusy(true);
      try {
        await perform({
          type: "connectChat",
          taskId: task.id,
          role,
          url: url.trim(),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, url, task.id, role, perform],
  );
  useEffect(() => {
    if (!url.trim() || url.trim() === agent?.conversation || busy) return;
    const timeout = setTimeout(() => void connect(true), 700);
    return () => clearTimeout(timeout);
  }, [url, agent?.conversation, busy, connect]);
  const label = role === "actor" ? "Actor Chat URL" : "Watcher Chat URL";
  let supported = false;
  try {
    supported = !!adapterForURL(url.trim());
  } catch {}
  return (
    <section className={`chat-url ${role}`}>
      <label htmlFor={`${role}-url`}>{label}</label>
      <input
        id={`${role}-url`}
        type="url"
        title="After pasting the complete handover into a new chat, replace this URL with that chat's address."
        value={url}
        onChange={(event) => setURL(event.target.value)}
        placeholder="Paste the chat URL from your signed-in Chrome"
        autoComplete="off"
      />
      <div className="chat-url-status">
        <span className={`dot ${agent?.connected ? "online" : ""}`} />
        <span>
          {busy
            ? "Connecting…"
            : agent?.awaitingResponse
              ? "Waiting for reply…"
              : agent?.connected
                ? `Connected · response #${agent.lastNumber}`
                : "Not connected"}
        </span>
        <button disabled={busy || !supported} onClick={() => void connect()}>
          {agent ? "Reconnect" : "Connect"}
        </button>
        {agent && (
          <button
            onClick={() =>
              void perform({ type: "openChat", agentId: agent.id })
            }
          >
            Show tab
          </button>
        )}
        {agent && (
          <button
            aria-label={`Disconnect ${role} chat`}
            onClick={() => {
              void perform({ type: "disconnectChat", agentId: agent.id }).then(
                (ok) => {
                  if (ok) {
                    setURL("");
                    attempted.current = "";
                  }
                },
              );
            }}
          >
            ×
          </button>
        )}
      </div>
      {url && !supported && (
        <small className="warning">
          Paste a ChatGPT, Qwen, DeepSeek, or GLM chat URL.
        </small>
      )}
      {agent?.error && <small className="warning">{agent.error}</small>}
    </section>
  );
}
