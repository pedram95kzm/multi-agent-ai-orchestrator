// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ContextAlerts } from "../../apps/desktop/renderer/components/ContextAlerts";
import { ProtocolTools } from "../../apps/desktop/renderer/features/workspace/ProtocolTools";
import { makeCore, response } from "../helpers";

afterEach(cleanup);

it.each(["actor", "watcher"] as const)(
  "keeps a simple global suggestion to onboard a new %s without automatic actions",
  (role) => {
    const core = makeCore();
    for (const id of ["first", "affected"])
      core.state.tasks.push({
        id,
        title: id === "affected" ? "Affected task" : "First task",
        kind: "feature",
        created: new Date().toISOString(),
      });
    core.state.activeTaskId = "first";
    const actor = core.connectChat(
      "affected",
      "actor",
      "https://chatgpt.com/c/actor",
    );
    const watcher = core.connectChat(
      "affected",
      "watcher",
      "https://chatgpt.com/c/watcher",
    );
    actor.connected = watcher.connected = true;
    const agent = role === "actor" ? actor : watcher;
    core.receive(
      agent.id,
      "lost",
      response(
        1,
        `${role}->${role === "actor" ? "watcher" : "actor"}`,
        "CONTEXT CHECK: RESPONSE 1 = UNAVAILABLE",
      ),
      "affected",
    );
    const element = () => (
      <>
        <ContextAlerts state={{ ...core.state }} />
        <ProtocolTools
          task={core.state.tasks[1]}
          agents={[actor, watcher]}
          messages={core.state.messages}
          perform={vi.fn()}
        />
      </>
    );
    const view = render(element());
    expect(screen.getByRole("alert").textContent).toContain("Affected task");
    expect(screen.getByRole("alert").textContent).toContain(
      `It would be better to onboard a new ${role}`,
    );
    expect(within(screen.getByRole("alert")).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /Onboard/ })).toBeNull();
    core.state.agents = core.state.agents.filter(
      (entry) => entry.id !== agent.id,
    );
    view.rerender(element());
    expect(screen.queryByRole("alert")).toBeNull();
  },
);
