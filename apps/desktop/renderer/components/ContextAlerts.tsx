import type { Snapshot } from "../../../../packages/shared/types";

export function ContextAlerts({ state }: { state: Snapshot }) {
  const warnings = state.agents.filter(
    (agent) => !agent.staged && agent.contextHealth?.needsOnboarding,
  );
  if (!warnings.length) return null;
  return (
    <div className="context-alerts">
      {warnings.map((agent) => {
        const task = state.tasks.find(
          (task) => task.id === (agent.taskId ?? state.activeTaskId),
        );
        const role = agent.role === "actor" ? "Actor" : "Watcher";
        return (
          <div className="banner warning" role="alert" key={agent.id}>
            <strong>
              {task?.title ? `${task.title}: ` : ""}Context warning for {role}.
            </strong>{" "}
            {role} reported that response number 1 is no longer readable. It
            would be better to onboard a new {agent.role}.
          </div>
        );
      })}
    </div>
  );
}
