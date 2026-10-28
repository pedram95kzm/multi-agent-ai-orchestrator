import type { Snapshot, Task } from "../../../../../packages/shared/types";
import { ResponseView } from "../messages/ResponseView";
import { ChromeConnection } from "../../components/ChromeConnection";
import type { Perform } from "../../ui";
import { ChatURL } from "./ChatURL";
import { MessageComposer } from "./MessageComposer";
import { TaskHistory } from "./TaskHistory";
import { useTaskComposer } from "./useTaskComposer";
import { ProtocolTools } from "./ProtocolTools";
import { runningBatchIds } from "../../../../../packages/shared/executions";
export function TaskWorkspace({
  state,
  task,
  perform,
  topCollapsed,
  rightCollapsed,
}: {
  state: Snapshot;
  task: Task;
  perform: Perform;
  topCollapsed: boolean;
  rightCollapsed: boolean;
}) {
  const agents = state.agents.filter(
    (agent) => agent.taskId === task.id && !agent.staged,
  );
  const messages = state.messages.filter(
    (message) => message.taskId === task.id,
  );
  const conversation = useTaskComposer(state, task, agents, messages, perform);
  const { handoff, following, end, requiredReply } = conversation;
  const anyRunning = runningBatchIds(state).size > 0;
  return (
    <div className="task-workspace">
      <div className="task-connections" id="top-panel" hidden={topCollapsed}>
        <ChromeConnection state={state} perform={perform} />
        <div className="chat-url-grid">
          <ChatURL
            task={task}
            role="actor"
            agent={agents.find((agent) => agent.role === "actor")}
            perform={perform}
          />
          <ChatURL
            task={task}
            role="watcher"
            agent={agents.find((agent) => agent.role === "watcher")}
            perform={perform}
          />
        </div>
      </div>
      <ProtocolTools
        task={task}
        agents={agents}
        messages={messages}
        perform={perform}
        blocked={!!requiredReply}
      />
      <div
        className={`workspace-body${rightCollapsed ? " right-collapsed" : ""}`}
      >
        <div className="chat-column">
          <div
            className="conversation"
            onScroll={(event) => {
              const el = event.currentTarget;
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 140;
            }}
          >
            {!messages.length && (
              <div className="empty">
                <span className="empty-symbol">↗</span>
                <h2>Ready for this task</h2>
                <p>
                  Paste the Actor and Watcher chat URLs above. Your first
                  message goes to the Watcher and includes the complete agent
                  instructions. Use Send to Actor or Send to Watcher to pass
                  each reply directly to the other chat.
                </p>
              </div>
            )}
            {messages.map((message) => (
              <ResponseView
                key={message.id}
                message={message}
                agents={agents}
                send={handoff}
                perform={perform}
                batches={state.batches}
                runs={state.runs}
                anyRunning={anyRunning}
                handoverState={state}
                requiredReply={requiredReply ?? null}
                blocked={
                  !!requiredReply &&
                  message.id !== requiredReply.id &&
                  message.replyToId !== requiredReply.id
                }
              />
            ))}
            <div ref={end} />
          </div>
          <MessageComposer state={state} agents={agents} {...conversation} />
        </div>
        <TaskHistory
          messages={messages}
          collapsed={rightCollapsed}
          onSelect={() => {
            following.current = false;
          }}
        />
      </div>
    </div>
  );
}
