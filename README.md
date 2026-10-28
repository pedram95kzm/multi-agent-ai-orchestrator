# Relay Orchestrator

A local Actor / Watcher workspace with task-specific conversations. Relay starts on **Task management**. Create or open a task, then paste its **Actor Chat URL** and **Watcher Chat URL** at the top of the task. Valid URLs connect automatically.

The Chrome extension uses tabs in your existing signed-in Chrome profile. Relay does not start a separate browser profile. Supported adapters are **ChatGPT, Qwen, DeepSeek, and GLM**. There is no manual-agent mode or service selector.

## Connect Chrome once

1. Run Relay and open **Settings → Chrome extension**.
2. In your normal Chrome profile, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked**. Select the folder opened by Relay's **Open extension folder** button; **Copy folder path** provides its exact path.
4. Open **Relay Chrome Connection** in Chrome's extensions menu. Paste the connection token copied from Relay; it connects automatically and remembers this profile. The token is exactly 64 hexadecimal characters.

Keep Relay open. The extension reconnects automatically. Open the chat URLs in the same Chrome profile in which the extension is installed. Existing matching tabs are reused; missing tabs are opened there. Sign-ins remain in Chrome.

## Work on a task

Create a task, enter its two URLs, and click **Send to Watcher** to brief the Watcher. **Send to Actor** is disabled until that task has a confirmed message delivery to the Watcher. The first message includes the complete `agent.md` protocol. The extension fills the correct composer, verifies the complete text, clicks Send once, and imports the resulting assistant response into that task. **Send to Actor** and **Send to Watcher** pass the complete reply directly in one click without replacing your draft. After reviewing an Actor proposal, the Watcher addresses **watcher->operator** with the exact approved code and a numbered request asking you to execute it and return the output. Actor proposals require Watcher review; the Watcher may also request her own batch directly. Every execution requires Operator approval.

When an ordinary **actor->operator** or **watcher->operator** message arrives, you must reply to its sender before continuing. Failed or uncertain delivery keeps that requirement active. A generated handover is a document for manual copying, so it does not require an acknowledgment reply.

Every outgoing message asks whether the receiving agent can still read its original response number 1. A reported loss raises a persistent task/role warning saying it would be better to onboard a new Actor or Watcher. The notice only recommends replacement; it has no automatic action. It remains until that role is replaced.

The Watcher prepares all three handover outputs for the Operator:

- **handover**: the complete project handover and recorded evidence only.
- **handover for new actor**: the project handover, full active `agent.md`, Actor identity and responsibilities, concrete next work, and an explanation of the independent response counter with its next number.
- **handover for new watcher**: the same complete replacement package, explicitly defining the new Watcher and its continued response number.

Use **Copy complete handover** on the chosen result. Paste a replacement packet manually into a new chat, wait for its receipt acknowledgment, then replace **Actor Chat URL** or **Watcher Chat URL**. That setup acknowledgment repeats the last confirmed response number without incrementing it and includes the supplied protocol receipt. The next project reply increments by one. Relay verifies and saves the receipt, so it does not resend the same `agent.md`. Both URL fields remain editable. Changing a URL sends no prompt automatically, preserves history/counters and withdraws unexecuted batches involving the retired member. Handover tools stay disabled before the first task message; **handover for new actor** also waits for the Actor's first response. No automatic onboarding controls remain.

Set the **Terminal executable** path in **Settings → Workspace settings** for the shell confirmed in chat (`powershell.exe`, `pwsh.exe`, or `bash.exe`). Confirm the working directory in chat; agents include `Working directory: <absolute path>` with each batch. The code toolbar has **Copy code**, **Execute command**, and **Copy result**. Clicking Execute command approves that exact run. Its captured output fills the first results question automatically, ready for review and **Submit Answers**. Every run requires user approval. Operator separators are automatic; directory, separator, and policy settings are unnecessary.

Each task owns its chat assignments and history. Deleting a task removes those assignments and messages; it does not delete conversations from the AI websites. Use a separate chat for each task and role. Existing history from the older global-agent layout is retained and migrated where a task association is available.

## Run and build

Development requires Node.js 24.15+ from the 24 LTS branch. The installer and portable app do not require Node.js. Chrome 120+ is needed for the extension; the full browser smoke test also requires Chrome's extension debugging support.

Before running `npm ci`, close Relay and stop its development server with Ctrl+C. Windows cannot replace native dependency files while the server is using them.

```powershell
npm ci
npm run dev
```

The command prints build and server status, then opens the Relay desktop window. The terminal stays active while Relay is running; close the window or press Ctrl+C to stop it.

Close the running Relay portable app before replacing its executable, then build:

```powershell
npm ci
npm run package:win
```

The package command typechecks, tests, builds the desktop and extension, creates the Windows installer and portable app in `release/`, and runs the packaged Chrome extension smoke test. The extension is bundled in both Windows distributions and copied to a stable folder in Relay's local data directory. Source builds also produce `dist/chrome-extension/` for **Load unpacked**.

Run `npm run check` before submitting changes; it checks formatting, types, unused local variables and parameters, tests, and the production build. `npm run format` applies formatting. The [architecture source map](docs/ARCHITECTURE.md#source-map) describes the feature folders and desktop services. Generated files and the exact `agent.md` text are excluded from formatting.

The project omits unused peer packages, including the Squirrel installer target, through `.npmrc`; required test peers are explicit dependencies. The ASAR override uses a maintained archive library. Code signing is not configured.

## Documentation

See the [user guide](docs/USER_GUIDE.md), [architecture](docs/ARCHITECTURE.md), [troubleshooting](docs/TROUBLESHOOTING.md), and [verification scope](docs/VERIFICATION.md). SQLite state and internal execution evidence stay in Relay's local data directory, accessible through Open local data in Settings. Exported history excludes the extension pairing token.

## License

MIT License. Copyright (c) 2026 pedram95kzm. See [LICENSE](LICENSE).
