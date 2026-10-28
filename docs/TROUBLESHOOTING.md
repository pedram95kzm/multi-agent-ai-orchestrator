# Troubleshooting

## Extension is offline

Keep Relay open. Load the extension into the same Chrome profile that contains your signed-in AI chats. Copy the token from Settings using its copy button: it must contain exactly 64 hexadecimal characters with no prefix or newline. Paste it into the extension popup; it connects automatically. If another Chrome profile is connected, disconnect that extension instance first.

After updating Relay, click Reload for Relay Chrome Connection in `chrome://extensions`. Relay keeps the extension files in a stable folder under its local data directory. **Open extension folder** and **Copy folder path** locate it. If the app reports that its connection port is unavailable, close another running Relay instance before retrying.

## A chat URL does not connect

Use a supported HTTPS conversation URL. Open it in Chrome, complete sign-in, and click Reconnect beside the URL. The extension uses the profile it is installed in, including the existing cookies and sessions. It cannot access a conversation in another profile. A URL already assigned to another task or role must be replaced with a separate conversation URL.

If a genuinely new chat URL reports **This tab already belongs to another task or role**, update Relay and reload **Relay Chrome Connection** (1.1.7 or later) in `chrome://extensions`, then click **Reconnect**. Earlier versions could retain a tab's old owner after the same browser tab navigated to a different chat, or restore obsolete bindings during reconnect. Relay now releases the obsolete tab reservation, retains the original chat assignment and pending evidence, and removes cached assignments absent from the desktop's active list. Reconnecting the original task rebinds its saved URL without resending a prompt. Pairing caches are scoped to the Relay token and port. A chat genuinely assigned to another active task remains protected.

## A message was not sent

An existing composer draft is preserved. Clear or submit that draft yourself, then retry the confirmed failure. An adapter may also report a missing or ambiguous composer/Send control if the website layout changed. Do not repeat an uncertain send until you inspect the actual chat; use the confirmation button only after checking it.

## A response has not appeared

Keep its bound Chrome tab open. Relay waits for a new assistant turn, disappearance of generation controls, and stable answer text. Thinking text is excluded. Switching Relay tasks does not move the pending response to another task. Deleted tasks discard late replies. If Chrome or the extension was restarted, inspect the chat before resolving any interrupted delivery.

If Relay shows an earlier greeting instead of the answer to a new handoff, update the app and reload **Relay Chrome Connection** in `chrome://extensions` (version 1.1.3 or later). Supported old and new assistant wrappers are inspected together. The extension and desktop require the expected role and response number before accepting a capture, so an old greeting cannot complete the send. Saved unnumbered captures from earlier versions are marked ignored, and their original confirmed delivery is inspected for its real answer without resending it. Open the task and keep that chat available. A genuine pending question addressed to the Operator still needs your answer before forwarding other messages.

The first outgoing message to a chat includes the complete active `agent.md`, except when Relay has verified its receipt of the same protocol and current delivery rules in a complete manual handover. A saved ready label, bare response count, or earlier greeting is insufficient evidence of protocol delivery.

## DeepSeek code was cut off

DeepSeek can divide syntax highlighting across multiple code elements, or put only the first token in a nested code element and the rest in sibling spans. Relay Chrome Connection 1.1.5 reads the entire preformatted block, preserving commands, paths, whitespace, and explicit line breaks while excluding toolbar controls. It uses the outer language banner even if an inner token is marked as SQL. Earlier versions could capture only the first fragment, such as `Test` from `Test-Path`, `[System.IO.D` from `[System.IO.Directory]`, or a file-writing batch ending at `def`.

After updating and restarting Relay, reload **Relay Chrome Connection** in `chrome://extensions` to activate the updated capture code. Previously saved replies retain what was actually captured; request the complete batch again before executing it.

The current `agent.md` also requires raw source with real indentation, without Markdown escapes, HTML space entities or an added backslash on every line. Each source file is shown separately. PowerShell writes use small, reviewed UTF-8 line arrays; Python source, Markdown documentation and verification must not be bundled into a large here-string script. Relay preserves captured source rather than guessing how to repair malformed commands.

## A documentation approval has no batch

Relay Chrome Connection 1.1.8 preserves nested Markdown examples by choosing an outer fence longer than every backtick sequence in the actual code. Older captures always used three backticks, which could close a README reference too early and hide the separate shell batch. Update Relay and reload the extension in `chrome://extensions`.

For the current affected Watcher approval, click **Refresh captured code** with both saved chats open. Relay reads the latest Actor proposal and Watcher approval again without sending a message or changing response counters. It accepts only the exact previously recorded responses with changed outer fence delimiters, matching code, shell and directory, and confirmed original deliveries. Original captures remain in the exported history. Changed, stale, uncertain, replaced or already executed work requires a fresh proposal. A successful refresh exposes **Execute command**; execution still requires your click.

The updated `agent.md` requires equally long opening and closing fences, longer than their contents. Close a Markdown reference completely before the standalone working-directory line and separate executable batch. Literal backticks in PowerShell line-array strings remain unchanged.

## Build on Windows

If a corrected Actor proposal is still reported as having a different working directory, the app may have retained an older proposal with identical commands and different directory metadata. Relay now selects the one later correction whose exact code, shell and directory match the approval, whose earlier proposals belong to the same Actor, and whose delivery to the Watcher is confirmed. The superseded unexecuted proposals remain in history as rejected. Real directory changes, edited code, uncertain delivery and ambiguous duplicates remain blocked. For a review already saved with this obsolete conflict, **Recheck recorded review** validates the existing evidence locally; it sends no AI message and executes no command. **Execute command** remains the separate execution approval.

PowerShell display cmdlets such as `Format-Table` and `Format-List` are permitted after approval. Older versions incorrectly matched their `Format` prefix as the disk-formatting command. Updating Relay fixes that false warning without changing the batch; actual `format`, `format.com`, and `format.exe` commands remain blocked.

If Execute command is disabled, confirm the directory in chat and have the Watcher include a standalone `Working directory: <absolute path>` line with the reviewed batch. A proposed, running, rejected, or completed batch cannot run again. In Settings, select an existing absolute path to `powershell.exe`, `pwsh.exe`, or `bash.exe` matching the confirmed shell. A terminal window launcher such as `wt.exe` does not expose captured shell output; use its shell executable. When execution finishes, review the automatically filled first answer and submit it. A cancelled or timed-out process may need a moment to close before its final output is available.

Use Node.js 24.15+ from the 24 LTS branch. Run PowerShell from the project directory:

```powershell
npm ci
npm run package:win
```

Close a running portable Relay executable before rebuilding it. The full smoke test requires installed Chrome with extension debugging support. `funding` and intentionally skipped code-signing messages are informational.

## Manual replacement does not connect

Choose **handover for new actor** or **handover for new watcher**, then use **Copy complete handover**. The fixed-role packet includes the full active `agent.md`, role identity, duties, concrete next work, counter explanation, checkpoint and project evidence. Paste it into a new signed-in chat, wait for its acknowledgment and then paste its URL into the matching editable role field. The plain **handover** button is the project report only. All three reports come from the current Watcher and are addressed to the Operator.

If the new URL cannot connect, sign in in the same Chrome profile, clear any composer draft and click **Reconnect**. Reload Relay Chrome Connection after updating (version 1.1.6 or later) so Relay can verify the manual receipt. Generate a fresh complete replacement packet: its first setup acknowledgment must repeat the last confirmed response number, include the supplied MANUAL HANDOVER ACK line, and wait. The next actual project answer uses last confirmed plus one. A valid current receipt prevents duplicate agent.md delivery and survives restart; changed instructions still need delivery. A response for the wrong role does not replace the saved checkpoint. Relay sends no prompt just because a URL changed.

Finish or cancel any running execution before replacing its chat. Unexecuted batches belonging to the retired role are withdrawn; completed execution evidence remains. Pending or uncertain sends to the previous URL are preserved as uncertain history and never replayed. Startup retires old automatic-transfer state and its blocked controls without removing historical messages.

If the handover buttons are disabled, connect the Watcher and answer an ordinary pending Operator question first. The handover report itself is a copyable document and needs no acknowledgment reply. Historical directory and question examples in generated reports are not current execution metadata.
