import type { Snapshot } from "../../../../packages/shared/types";
import { copy, type Perform } from "../ui";

export function ChromeConnection({
  state,
  perform,
  expanded = false,
}: {
  state: Snapshot;
  perform: Perform;
  expanded?: boolean;
}) {
  return (
    <section className={`chrome-connection ${expanded ? "settings-card" : ""}`}>
      <div className="section-title">
        <strong>
          <span className={`dot ${state.chrome?.connected ? "online" : ""}`} />{" "}
          Chrome extension
        </strong>
        <span>
          {state.chrome?.connected
            ? "Connected · your signed-in profile"
            : "Not connected"}
        </span>
      </div>
      {state.chrome?.error && <p className="warning">{state.chrome.error}</p>}
      {(expanded || !state.chrome?.connected) && (
        <details open={expanded}>
          <summary>Connect your existing Chrome profile</summary>
          <ol>
            <li>
              In the Chrome profile you already use, open{" "}
              <code>chrome://extensions</code> and enable Developer mode.
            </li>
            <li>
              Click <strong>Load unpacked</strong> and select the extension
              folder below.
            </li>
            <li>
              Open <strong>Relay Chrome Connection</strong> from Chrome’s
              extensions menu and paste this connection token. It connects
              automatically and remembers this profile.
            </li>
          </ol>
          <div className="inline">
            <button
              onClick={() => void perform({ type: "openExtensionFolder" })}
            >
              Open extension folder
            </button>
            <button
              onClick={() => void copy(state.chrome?.extensionPath ?? "")}
              disabled={!state.chrome?.extensionPath}
            >
              Copy folder path
            </button>
          </div>
          <label className="token-label">
            Connection token · exactly 64 characters
            <input
              readOnly
              aria-label="Chrome connection token"
              value={state.chrome?.token ?? ""}
              spellCheck={false}
            />
          </label>
          <button
            disabled={!state.chrome?.token}
            onClick={() => void copy(state.chrome!.token)}
          >
            Copy connection token
          </button>
          <p className="muted">
            Supported: ChatGPT, Qwen, DeepSeek, GLM. Relay uses the tabs and
            sign-ins in this Chrome profile.
          </p>
        </details>
      )}
    </section>
  );
}
