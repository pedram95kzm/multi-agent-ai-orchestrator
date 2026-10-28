import type { Task } from "../../../../../packages/shared/types";
import type { View } from "../../App";
import type { PanelLayout } from "../../hooks/usePanelLayout";
import { PanelToggle } from "./PanelToggle";
export function WorkspaceHeader({
  task,
  view,
  setView,
  layout,
  togglePanel,
}: {
  task?: Task;
  view: View;
  setView: (view: View) => void;
  layout: PanelLayout;
  togglePanel: (side: keyof PanelLayout) => void;
}) {
  const title =
    view === "settings"
      ? "Settings"
      : view === "workspace" && task
        ? task.title
        : "Task management";
  return (
    <header
      className={`topbar${view === "workspace" && layout.top ? " top-collapsed" : ""}`}
    >
      <div>
        <span className="eyebrow">
          {view === "workspace" && task ? task.kind : "OPERATOR WORKSPACE"}
        </span>
        <h1>{title}</h1>
      </div>
      <div className="inline">
        {view === "workspace" && task && (
          <div className="panel-controls" aria-label="Workspace panels">
            <PanelToggle
              side="top"
              collapsed={layout.top}
              controls="top-panel"
              onClick={() => togglePanel("top")}
            />
            <PanelToggle
              side="right"
              collapsed={layout.right}
              controls="right-panel"
              onClick={() => togglePanel("right")}
            />
          </div>
        )}
        {view === "workspace" && (
          <button onClick={() => setView("tasks")}>← All tasks</button>
        )}
        <span className="badge">Approval required</span>
      </div>
    </header>
  );
}
