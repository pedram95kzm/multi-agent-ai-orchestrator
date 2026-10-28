import { useState } from "react";
import { Settings } from "./features/settings/Settings";
import { TaskManager } from "./features/tasks/TaskManager";
import { TaskWorkspace } from "./features/workspace/TaskWorkspace";
import { Sidebar } from "./components/layout/Sidebar";
import { WorkspaceHeader } from "./components/layout/WorkspaceHeader";
import { useRelay } from "./hooks/useRelay";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { ContextAlerts } from "./components/ContextAlerts";
export type View = "tasks" | "workspace" | "settings";
export function App() {
  const { state, error, perform, dismissError } = useRelay();
  const { layout, togglePanel } = usePanelLayout();
  const [view, setView] = useState<View>("tasks");
  if (!state) return <div className="startup">{error || "Opening Relay…"}</div>;
  const task = state.tasks.find((task) => task.id === state.activeTaskId);
  return (
    <div className={`app-shell${layout.left ? " left-collapsed" : ""}`}>
      <Sidebar
        state={state}
        task={task}
        view={view}
        setView={setView}
        perform={perform}
        layout={layout}
        togglePanel={togglePanel}
      />
      <main>
        <WorkspaceHeader
          task={task}
          view={view}
          setView={setView}
          layout={layout}
          togglePanel={togglePanel}
        />
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => dismissError()}>Dismiss</button>
          </div>
        )}
        {state.instructions.changed && (
          <div className="banner">
            Instructions changed. Review and reload them in Settings.
          </div>
        )}
        <ContextAlerts state={state} />
        {view === "settings" ? (
          <div className="content-scroll">
            <Settings state={state} perform={perform} />
          </div>
        ) : view === "workspace" && task ? (
          <TaskWorkspace
            key={task.id}
            state={state}
            task={task}
            perform={perform}
            topCollapsed={layout.top}
            rightCollapsed={layout.right}
          />
        ) : (
          <TaskManager
            state={state}
            perform={perform}
            open={() => setView("workspace")}
          />
        )}
      </main>
    </div>
  );
}
