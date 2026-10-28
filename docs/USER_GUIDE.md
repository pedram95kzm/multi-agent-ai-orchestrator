# User guide

## First connection

Open Relay. Its first page is **Task management**. Connect the Chrome extension once using the instructions shown there or in **Settings**:

1. Open `chrome://extensions` in the profile where your AI chats are signed in.
2. Enable Developer mode, choose Load unpacked, and select Relay's extension folder. Relay's **Copy folder path** button gives the path.
3. Open the Relay Chrome Connection popup from Chrome's extensions menu.
4. Copy the 64-character connection token from Relay and paste it into the popup. It connects automatically and remembers this Chrome profile.

The app and popup display the connection state. Your existing Chrome sign-ins are used directly. There is no separate Relay browser profile.

## Tasks and chat URLs

Choose your operating system, a task type, and a title, then click **Create & open task**, or open a saved task. The operating system is saved with the task and included in its starting message and handover context. For older tasks without that information, the Watcher asks before proposing commands. At the top are **Actor Chat URL** and **Watcher Chat URL**. Paste each conversation URL; connection starts automatically. **Reconnect** repeats discovery after signing in or reloading a tab. **Show tab** brings the chat forward.

Supported URLs are on `chatgpt.com` (also `chat.openai.com`), `chat.qwen.ai`, `chat.deepseek.com`, and `chat.z.ai` (GLM). Relay detects the service from its URL. Use a separate conversation for every task and role. Use the × button to remove a task's assignment before replacing it when needed.

Use the panel buttons to minimize the left navigation, the top connection area, or the right task history. Each button restores its panel on a second click. Minimizing the top area also compacts the task header. Your panel choices are remembered when you switch tasks or restart Relay; drafts and chat URL fields are preserved while their panels are minimized.

## Sending and receiving

Click **Send to Watcher** to start the task. The composer has two explicit delivery buttons: **Send to Actor** and **Send to Watcher**. Send to Actor stays disabled until the task's first message to the Watcher is confirmed as submitted; pending, failed, or uncertain delivery does not unlock it. This rule applies independently to every task and is enforced by the backend as well as the UI. Ctrl + Enter sends to the Watcher initially, then to the role most recently used in the composer. The complete current `agent.md` is included in the first message. Later messages retain protocol separators and independent response counters.

The extension inserts text into the saved chat and verifies it before clicking Send. A completed assistant response returns to that task's conversation and history. Messages start collapsed; **Show complete text** reveals the original full text and **Hide complete text** collapses it again. Agent summaries and questions addressed to the operator remain visible. Both `Summary: text` on one line and separate Summary headings (including bold or Markdown headings) are recognized. The role buttons on a response send its complete original reply directly in one click, leaving your draft intact.

When **actor->operator** or **watcher->operator** arrives, your reply is required before continuing. Only that sender's send button remains available, and Ctrl + Enter targets that sender automatically. This also applies when there are no numbered questions: type your reply in the composer. You can instead submit the message's numbered answers or return its captured command result. Other handoffs and task tools remain disabled until the reply is confirmed as submitted. Failed or uncertain delivery keeps the requirement active. Multiple requests are answered in arrival order, independently for each task, and survive restarting Relay. Generated handovers are documents for manual copying and do not require an acknowledgment reply.

After you relay an Actor proposal to the Watcher, the Watcher approves it directly with **watcher->operator**, **APPROVED**, the exact code, and a numbered question asking you to execute it and return the output. Relay labels that recipient **You (Operator)**. No Actor acknowledgment or extra Operator message is needed between review and execution. For older approval-only messages, **Request execution instructions** asks the Watcher to finish that Operator handoff instead of sending another standby acknowledgment to the Actor. If an eligible Operator batch omits its numbered question, Relay supplies an execution-results answer field while preserving the original response.

Command batches appear alongside the Summary even when the full explanation is collapsed. The toolbar above the code offers **Copy code**, **Execute command**, and **Copy result**. Copy code preserves the original whitespace and line endings. Execute command appears for a reviewed batch forwarded to you by the Watcher; clicking it approves that exact execution. Every run requires your approval, including read-only inspections. Running, rejected, and previously executed batches cannot be executed again. Copy result becomes available when execution finishes. The same controls remain available when you expand the complete response.

The protocol requires literal code with real spaces and newlines. File contents appear in separate source-language blocks; the executable block contains the actual shell write and verification commands. PowerShell file writes use readable UTF-8 line arrays in small, single-file steps. Documentation belongs in a separate step, without mixing Markdown and Python inside here-strings. Reference source blocks do not execute or create files by themselves.

In **Settings → Workspace settings**, enter the full **Terminal executable** path for the shell confirmed in chat: `powershell.exe`, `pwsh.exe`, or `bash.exe`. Windows defaults to Windows PowerShell. Commands follow `agent.md` and run through that executable; a mismatched shell is rejected before execution. There is no workspace directory setting: confirm it in chat and have the agent include `Working directory: <absolute path>` before the code block. Relay preserves that directory through review and executes there. A change to an already proposed directory needs a corrected proposal. PowerShell and Bash batches are supported; Bash conditional `&&` chains remain supported. Both roles may request commands, including file changes, after your approval. There is no Watcher-specific command allowlist. The Watcher may request her own batch directly using watcher->operator without APPROVED; that marker is reserved for reviewing an Actor proposal. Actor proposals continue through Watcher review.

Agents request results with a numbered question outside the code fence. When a run finishes, Relay automatically fills the first output answer with captured stdout, stderr, status, working directory, and exit code. Review or edit it, complete any remaining questions, then click **Submit Answers**. Results are never sent automatically. Failure, cancellation, timeout, and interruption are recorded accurately, and truncated output is marked with its full log paths. Other answers and subsequent edits are preserved. Output and cancellation controls also remain beside the approved message; **Return evidence to watcher** provides an alternative direct handoff of a complete result. Reject / withdraw batch abandons an unexecuted proposal.

If a send is uncertain, inspect the actual chat before confirming it in Relay. Do not repeat it blindly. A confirmed pre-send failure can be retried after the page or draft problem is resolved. Existing drafts in Chrome are never overwritten.

## Managing tasks

**All tasks** returns to task management. Only the selected task's messages appear in its conversation and history. **Delete** removes that task's saved connections, messages, command batches, and execution evidence together after confirmation. It does not delete the website chats or close your Chrome tabs. There is no need to delete or reject batches manually first. Wait for any running execution belonging to the task to finish before deleting it. Full log files remain in the local logs folder.

## Replace an Actor or Watcher

Automatic onboarding is removed. There are exactly three handover buttons, and the CURRENT Watcher prepares all three outputs addressed to the Operator using watcher->operator:

- **handover** produces the complete project handover and evidence, without appending agent.md or assigning a new role.
- **handover for new actor** produces the complete project handover plus the full active agent.md, an explicit Actor identity and responsibilities, concrete next work, and an explanation of RESPONSE NUMBER with the last confirmed and next Actor numbers.
- **handover for new watcher** produces the corresponding complete Watcher replacement packet, including the preparing Watcher report in its continued checkpoint.

Each report covers requirements, architecture/files, completed work and evidence, tests/builds, documentation, decisions, unknowns and precise next steps. The replacement role is fixed by the button you chose; there is no role selector on the output.

1. Click **handover for new actor** or **handover for new watcher** and wait for the Watcher report addressed to the Operator.
2. Click **Copy complete handover** on that result.
3. Paste that entire packet manually into a new chat. It contains the report, the complete active `agent.md`, current delivery rules, original response 1 when recorded, task evidence and the continued response number.
4. Wait for its receipt acknowledgment. This first setup reply repeats the last confirmed response number without increasing it and includes the exact `MANUAL HANDOVER ACK` line supplied in the packet. Its first actual answer after the next Relay message uses the next number.
5. Paste its URL directly into **Actor Chat URL** or **Watcher Chat URL**. Both connected URL fields are editable and connect automatically after the paste.

Relay does not send the packet or another prompt automatically. Changing a URL retires the previous assignment, preserves conversation and execution history, carries forward its counter and briefing state, and withdraws unexecuted batches involving the retired member. A visible response in the new chat can advance the counter only when it matches the assigned role. Finish or cancel running execution before changing its chat. Uncertain old sends remain recorded and are never replayed.

Relay verifies the manual receipt against the task, target role, report, unchanged response checkpoint, active protocol and delivery-rule versions. It saves that evidence and does not resend the same `agent.md` on the first subsequent handoff or later messages. Changed instructions still require an update. Reload **Relay Chrome Connection** (1.1.6 or later) after updating so Relay can inspect the manual acknowledgment. Ordinary Operator-directed questions still require your reply; the generated handover itself does not. Historical directories and repeated question examples in the report do not create execution requests or answer forms.

All handover buttons remain disabled until the first task message has been submitted to the Watcher. **handover for new actor** also stays disabled until the Actor produces its first response; connecting its URL alone is insufficient.

Each Relay message still ends with the response-1 context check. A reported loss keeps a persistent notice naming the task and affected role and saying it would be better to onboard a new Actor or Watcher. The notice only makes that suggestion and has no button or automatic action. Manual replacement packets preserve original response 1 when available. Missing or contradictory metadata does not prove context exhaustion.

Older automatic-transfer workflow state is retired during startup without sending anything. Already-confirmed deliveries retain their assignment; unconfirmed staged assignments are discarded, and all historical messages and execution evidence remain. Obsolete transfer requests do not block the new manual workflow.

## Local data

Settings contains the terminal executable, timeout, instruction editing, history export, and **Open local data**. Operator messages receive their separator automatically. There are no workspace directory, separator, policy, or automatic-execution controls. Existing saved configurations discard those retired settings without changing recorded messages, batches, or runs. There is no separate execution-history or log viewer. Commands and their output are available within the conversation. Internal execution records prevent duplicate execution and supply actual evidence to handovers. Full stdout/stderr files are retained under the local data folder if the bounded preview is truncated.

Back up the local data directory with Relay closed. History export excludes the extension pairing token. Updated instructions are included with the next message to an existing chat; its independent counter continues. Historical messages, reviews, and execution evidence retain their recorded instruction version.

The first confirmed delivery to a chat includes the complete active `agent.md`, unless Relay has already verified receipt of the same protocol and delivery rules in its complete manual replacement packet. Bare greetings, response counters and saved ready states do not establish protocol delivery. Pending, failed, or uncertain sends do not establish it either. A handoff sends the selected current agent message in full; the Operator's draft and earlier greeting do not replace it.

Captured replies must match the role, expected next response number, and saved chat URL. Old greetings do not finish a pending send. After updating, reload Relay Chrome Connection in `chrome://extensions`. If an earlier extension saved a greeting as a reply, Relay marks that capture as ignored and inspects the same chat for the actual answer without repeating the prompt. Ignored captures remain in history but cannot be forwarded or authorize execution.
