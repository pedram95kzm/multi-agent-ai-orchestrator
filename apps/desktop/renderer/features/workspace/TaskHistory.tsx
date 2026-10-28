import { useState } from "react";
import type { Message } from "../../../../../packages/shared/types";
import { time } from "../../ui";
export function TaskHistory({
  messages,
  collapsed,
  onSelect,
}: {
  messages: Message[];
  collapsed: boolean;
  onSelect: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <aside
      className="task-history"
      id="right-panel"
      aria-label="Task history"
      hidden={collapsed}
    >
      <h3>
        Task history <span className="badge">{messages.length}</span>
      </h3>
      <input
        aria-label="Search task history"
        placeholder="Search this task"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="history-items">
        {messages
          .filter((message) =>
            message.content.toLowerCase().includes(query.toLowerCase()),
          )
          .map((message) => (
            <button
              className="history-item"
              key={message.id}
              onClick={() => {
                onSelect();
                document
                  .getElementById(`message-${message.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              <strong>
                {message.sender}{" "}
                {message.parsed?.number ? `#${message.parsed.number}` : ""}
              </strong>
              <small>
                {time(message.timestamp)} · {message.status}
              </small>
              <p>
                {message.parsed?.summary ??
                  message.originalInput ??
                  message.content.slice(0, 100)}
              </p>
            </button>
          ))}
      </div>
    </aside>
  );
}
