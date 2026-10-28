import { useState } from "react";
import type { Snapshot } from "../../../../../packages/shared/types";
import type { Perform } from "../../ui";
import { ChromeConnection } from "../../components/ChromeConnection";

export function TaskManager({
  state,
  perform,
  open,
}: {
  state: Snapshot;
  perform: Perform;
  open: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("2. Add a feature");
  const [operatingSystem, setOperatingSystem] = useState("");
  const [creating, setCreating] = useState(false);
  return (
    <div className="content-scroll task-manager">
      <ChromeConnection state={state} perform={perform} />
      <form
        className="settings-card create-task"
        onSubmit={async (event) => {
          event.preventDefault();
          if (creating) return;
          setCreating(true);
          try {
            if (
              await perform({
                type: "task",
                title: title.trim(),
                kind,
                operatingSystem,
              })
            ) {
              setTitle("");
              open();
            }
          } finally {
            setCreating(false);
          }
        }}
      >
        <h2>Create a task</h2>
        <p className="muted">
          Each task has its own Actor chat, Watcher chat, and conversation
          history.
        </p>
        <label>
          Operating system
          <select
            required
            value={operatingSystem}
            onChange={(event) => setOperatingSystem(event.target.value)}
          >
            <option value="" disabled>
              Select your operating system
            </option>
            <option>Windows</option>
            <option>macOS</option>
            <option>Linux</option>
            <option>Other</option>
          </select>
        </label>
        <label>
          Task type
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option>1. Create a project</option>
            <option>2. Add a feature</option>
            <option>3. Fix a bug</option>
            <option>4. Create or update documentation</option>
            <option>5. Ask a question about an existing project</option>
            <option>6. Other</option>
          </select>
        </label>
        <label>
          Task title
          <input
            aria-label="Task title"
            required
            maxLength={500}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What do you want to work on?"
          />
        </label>
        <button
          className="primary"
          disabled={creating || !title.trim() || !operatingSystem}
        >
          {creating ? "Creating…" : "Create & open task"}
        </button>
      </form>
      <div className="section-title">
        <h2>Your tasks</h2>
        <span>{state.tasks.length} tasks</span>
      </div>
      {!state.tasks.length && (
        <p className="empty">
          Create your first task to connect its Actor and Watcher chats.
        </p>
      )}
      <div className="task-grid">
        {[...state.tasks].reverse().map((task) => {
          const agents = state.agents.filter(
            (agent) => agent.taskId === task.id,
          );
          return (
            <article className="settings-card task-card" key={task.id}>
              <small>{task.kind}</small>
              {task.operatingSystem && <small>{task.operatingSystem}</small>}
              <h3>{task.title}</h3>
              <div className="task-roles">
                {["actor", "watcher"].map((role) => (
                  <span key={role}>
                    <span
                      className={`dot ${agents.some((agent) => agent.role === role && agent.connected) ? "online" : ""}`}
                    />
                    {role}
                  </span>
                ))}
              </div>
              <small>{new Date(task.created).toLocaleDateString()}</small>
              <div className="inline">
                <button
                  className="primary"
                  onClick={async () => {
                    if (
                      await perform({ type: "activateTask", taskId: task.id })
                    )
                      open();
                  }}
                >
                  Open task
                </button>
                <button
                  aria-label={`Delete task ${task.title}`}
                  className="danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete “${task.title}”, its conversation history, and all related execution history?`,
                      )
                    )
                      void perform({ type: "removeTask", taskId: task.id });
                  }}
                >
                  Delete
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
