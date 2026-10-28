import type { Agent, AppState } from "../shared/types";

// Retain history from the old global agent list while moving connections into tasks.
export function migrateTaskChats(state: AppState) {
  state.settings = {
    shell: state.settings.shell,
    timeoutMs: state.settings.timeoutMs,
  };
  // Retired controls are discarded without altering historical messages or runs.
  delete (state as unknown as Record<string, unknown>).syncPoints;
  delete (state as unknown as Record<string, unknown>).onboarding;
  // Retire automatic transfers without sending, replaying or deleting evidence.
  const retired = new Set<string>();
  for (const task of state.tasks) {
    const flow = task.onboarding;
    if (!flow) continue;
    const staged = state.agents.find(
      (agent) => agent.id === flow.agentId && agent.staged,
    );
    const delivered = state.messages.some(
      (message) =>
        message.id === flow.deliveryId && message.status === "submitted",
    );
    if (staged && delivered) {
      staged.staged = undefined;
      staged.onboarding = "registered";
      staged.awaitingResponse = false;
      if (flow.previousAgentId) retired.add(flow.previousAgentId);
    } else if (staged) retired.add(staged.id);
    delete task.onboarding;
  }
  for (const batch of state.batches)
    if (
      ["proposed", "reviewed", "ready"].includes(batch.state) &&
      (retired.has(batch.actorId ?? "") ||
        retired.has(batch.requesterId) ||
        retired.has(
          state.messages.find((message) => message.id === batch.reviewId)
            ?.agentId ?? "",
        ))
    )
      batch.state = "rejected";
  state.agents = state.agents.filter((agent) => !retired.has(agent.id));
  for (const agent of state.agents) {
    const last = state.messages.findLast(
      (message) => message.agentId === agent.id,
    );
    if (last && (last.type === "onboarding" || last.purpose === "onboarding"))
      agent.awaitingResponse = false;
  }
  for (const message of state.messages)
    if (
      (message.type === "onboarding" || message.purpose === "onboarding") &&
      message.status === "pending"
    ) {
      message.status = "uncertain";
      message.error =
        "Automatic transfer retired. Inspect the old chat if needed; this message will not be replayed.";
    }
  const unassigned = state.messages.filter((message) => !message.taskId);
  if (unassigned.length) {
    let imported = state.tasks.find((task) => task.id === "imported-workspace");
    if (!imported) {
      imported = {
        id: "imported-workspace",
        kind: "Imported",
        title: "Imported workspace",
        created: new Date().toISOString(),
      };
      state.tasks.push(imported);
    }
    for (const message of unassigned) message.taskId = imported.id;
  }
  const legacy = state.agents.filter((agent) => !agent.taskId);
  if (!legacy.length) return;
  if (!state.tasks.length && (legacy.length || state.messages.length)) {
    state.tasks.push({
      id: "imported-workspace",
      kind: "Imported",
      title: "Imported workspace",
      created: new Date().toISOString(),
    });
    state.activeTaskId = state.tasks[0].id;
    for (const message of state.messages) message.taskId ??= state.tasks[0].id;
  }
  const scoped = state.agents.filter((agent) => agent.taskId);
  const mapping = new Map<string, string>();
  const used = new Set<string>();
  for (const task of state.tasks) {
    for (const role of ["actor", "watcher"] as const) {
      if (
        scoped.some((agent) => agent.taskId === task.id && agent.role === role)
      )
        continue;
      const ids = state.messages
        .filter((message) => message.taskId === task.id && message.agentId)
        .map((message) => message.agentId);
      const old =
        legacy
          .filter((agent) => agent.role === role && ids.includes(agent.id))
          .at(-1) ??
        (state.tasks.length === 1
          ? legacy.find((agent) => agent.role === role)
          : undefined);
      if (!old) continue;
      const id = used.has(old.id) ? `${old.id}:${task.id}` : old.id;
      used.add(old.id);
      const agent: Agent = {
        ...old,
        id,
        taskId: task.id,
        provider: "browser",
        automation: "Chrome extension",
        connected: false,
      };
      scoped.push(agent);
      mapping.set(`${old.id}:${task.id}`, id);
    }
  }
  for (const message of state.messages) {
    const key = `${message.agentId}:${message.taskId}`;
    if (mapping.has(key)) message.agentId = mapping.get(key);
    const recipient = mapping.get(`${message.recipient}:${message.taskId}`);
    if (recipient) message.recipient = recipient;
    if ((message.status as string) === "manual") {
      message.status = "uncertain";
      message.error =
        "Imported unconfirmed delivery. Check its chat before resolving it.";
    }
  }
  for (const batch of state.batches) {
    const taskId = state.messages.find(
      (message) => message.id === batch.proposalId,
    )?.taskId;
    batch.actorId = mapping.get(`${batch.actorId}:${taskId}`) ?? batch.actorId;
    batch.requesterId =
      mapping.get(`${batch.requesterId}:${taskId}`) ?? batch.requesterId;
  }
  for (const run of state.runs)
    run.agentId = mapping.get(`${run.agentId}:${run.taskId}`) ?? run.agentId;
  state.agents = scoped;
}
