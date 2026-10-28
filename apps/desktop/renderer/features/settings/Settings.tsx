import { useState } from "react";
import type { Snapshot } from "../../../../../packages/shared/types";
import type { Perform } from "../../ui";
import { ChromeConnection } from "../../components/ChromeConnection";

export function Settings({
  state,
  perform,
}: {
  state: Snapshot;
  perform: Perform;
}) {
  const [settings, setSettings] = useState(state.settings);
  const [instructions, setInstructions] = useState(state.instructions.text);
  return (
    <div className="settings-view">
      <ChromeConnection state={state} perform={perform} expanded />
      <div className="section-title">
        <h2>Workspace settings</h2>
        <span>Changes are saved locally</span>
      </div>

      <form
        className="settings-card"
        onSubmit={(e) => {
          e.preventDefault();
          void perform({ type: "settings", settings });
        }}
      >
        <h3>Command execution</h3>
        <p>
          Commands follow agent.md and always require your approval. The working
          directory is confirmed in chat. Run approved code with the terminal
          executable below; its output fills the first answer field.
        </p>
        <label>
          Terminal executable
          <input
            required
            value={settings.shell}
            onChange={(e) =>
              setSettings({ ...settings, shell: e.target.value })
            }
          />
        </label>
        <p className="muted">
          Use the full path to powershell.exe, pwsh.exe, or bash.exe for the
          shell selected in chat.
        </p>
        <div className="inline">
          <label>
            Timeout (seconds)
            <input
              type="number"
              min="1"
              max="600"
              value={settings.timeoutMs / 1000}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  timeoutMs: Number(e.target.value) * 1000,
                })
              }
            />
          </label>
        </div>

        <button className="primary">Save settings</button>
      </form>
      <section className="settings-card">
        <h3>Agent instructions</h3>
        <p className="path">{state.instructions.path}</p>
        <p>
          Version {state.instructions.hash.slice(0, 12)} · Changes affect
          subsequent messages. Existing evidence retains its version.
        </p>
        {state.instructions.changed && (
          <p className="warning">
            Instructions changed on disk. Validate and reload to apply them to
            subsequent messages. Existing execution evidence retains its
            version.
          </p>
        )}
        {state.instructions.error && (
          <p className="warning">{state.instructions.error}</p>
        )}
        <div className="inline">
          <button
            onClick={() =>
              void perform({ type: "instructions", operation: "open" })
            }
          >
            Open Agent Instructions
          </button>
          <button
            onClick={() =>
              void perform({ type: "instructions", operation: "choose" })
            }
          >
            Choose file
          </button>
          <button
            onClick={async () => {
              if (
                await perform({ type: "instructions", operation: "reload" })
              ) {
                const r = await window.relay.invoke({ type: "snapshot" });
                if (r.data) setInstructions(r.data.instructions.text);
              }
            }}
          >
            Validate & reload
          </button>
        </div>
        <details>
          <summary>Edit instructions in app</summary>
          <textarea
            className="instruction-editor"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <button
            onClick={() =>
              void perform({
                type: "instructions",
                operation: "save",
                content: instructions,
              })
            }
          >
            Validate, back up & activate
          </button>
        </details>
      </section>

      <div className="inline">
        <button onClick={() => void perform({ type: "export" })}>
          Export history
        </button>
        <button
          onClick={() => void perform({ type: "openFolder", folder: "data" })}
        >
          Open local data
        </button>
      </div>
    </div>
  );
}
