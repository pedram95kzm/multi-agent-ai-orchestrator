import type { Snapshot, Task } from "../../../../../packages/shared/types";
import type { View } from "../../App";
import type { PanelLayout } from "../../hooks/usePanelLayout";
import type { Perform } from "../../ui";
import { PanelToggle } from "./PanelToggle";
export function Sidebar({
  state,
  task,
  view,
  setView,
  perform,
  layout,
  togglePanel,
}: {
  state: Snapshot;
  task?: Task;
  view: View;
  setView: (view: View) => void;
  perform: Perform;
  layout: PanelLayout;
  togglePanel: (side: keyof PanelLayout) => void;
}) {
  return (
    <aside className="sidebar" id="left-panel" aria-label="Main navigation">
      <div className="sidebar-toggle">
        <PanelToggle
          side="left"
          collapsed={layout.left}
          controls="left-panel"
          onClick={() => togglePanel("left")}
        />
      </div>
      <div className="brand">
        <span className="brand-mark">↗</span>
        <div className="brand-name">
          Relay<span>ACTOR · WATCHER</span>
        </div>
      </div>
      <nav>
        <button
          aria-label="Tasks"
          title="Tasks"
          className={view === "tasks" ? "active" : ""}
          onClick={() => setView("tasks")}
        >
          ▦ <span>Tasks</span>
          <span className="badge">{state.tasks.length}</span>
        </button>
        {task && (
          <button
            aria-label="Current task"
            title="Current task"
            className={view === "workspace" ? "active" : ""}
            onClick={async () => {
              if (await perform({ type: "activateTask", taskId: task.id }))
                setView("workspace");
            }}
          >
            ↗ <span>Current task</span>
          </button>
        )}
        <button
          aria-label="Settings"
          title="Settings"
          className={view === "settings" ? "active" : ""}
          onClick={() => setView("settings")}
        >
          ⚙ <span>Settings</span>
        </button>
      </nav>
      <div className="sidebar-note">
        <p>One task. Two chats.</p>
        <p className="muted">
          Choose a task, then connect its Actor and Watcher URLs using your
          existing Chrome profile.
        </p>
      </div>
      <footer
        title={
          state.chrome?.connected
            ? "Chrome extension connected"
            : "Chrome extension offline"
        }
      >
        <span className={`dot ${state.chrome?.connected ? "online" : ""}`} />
        <span className="connection-label">
          {state.chrome?.connected
            ? "Chrome extension connected"
            : "Chrome extension offline"}
        </span>
        <small>Protocol {state.instructions.hash.slice(0, 8)} · SQLite</small>
      </footer>
    </aside>
  );
}
