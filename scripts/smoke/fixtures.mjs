import { until } from "./cdp.mjs";
export const fixtures = [
  {
    id: "chatgpt",
    role: "actor",
    url: "https://chatgpt.com/c/relay-fixture",
    controls:
      '<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button" disabled>Send</button>',
    response:
      '<div data-message-author-role="assistant" data-message-id="reply-chatgpt"><div class="markdown">BODY</div></div>',
  },
  {
    id: "deepseek",
    role: "watcher",
    url: "https://chat.deepseek.com/a/chat/s/relay-fixture",
    controls:
      '<textarea placeholder="Message DeepSeek"></textarea><button class="ds-button ds-button--primary ds-button--circle" disabled>Send</button>',
    response:
      '<div class="ds-message"><div class="ds-think-content">Do not import thinking</div><div class="ds-assistant-message-main-content" id="reply-deepseek">BODY</div></div>',
  },
  {
    id: "qwen",
    role: "actor",
    url: "https://chat.qwen.ai/c/relay-fixture",
    controls:
      '<textarea class="message-input-textarea"></textarea><button class="send-button" aria-label="Send" disabled>Send</button>',
    response:
      '<div class="qwen-chat-message-assistant" id="reply-qwen"><div class="response-message-content phase-answer">BODY</div></div>',
  },
  {
    id: "glm",
    role: "watcher",
    url: "https://chat.z.ai/c/relay-fixture",
    controls:
      '<textarea id="chat-input"></textarea><button id="send-message-button" disabled>Send</button>',
    response:
      '<div class="chat-assistant" id="reply-glm"><div class="thinking-chain-container">Do not import thinking</div><section>BODY</section></div>',
  },
];
export async function installFixtures(chrome, entries = fixtures) {
  const sessions = new Map();
  const escapeHTML = (text) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  for (const fixture of entries) {
    const page = await chrome.call("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await chrome.call("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    sessions.set(fixture.id, sessionId);
    const codeExample =
      fixture.id === "chatgpt"
        ? '\n```python\nprint("Hello, World!")\n```\nq1: Please paste the actual stdout, stderr, and exit code here.\n'
        : fixture.role === "watcher"
          ? `\nWorking directory: ${process.cwd()}\n\`\`\`${process.platform === "win32" ? "powershell" : "bash"}\nclear\n${process.platform === "win32" ? "Get-Location | Select-Object -ExpandProperty Path" : "pwd && ls"}\n\`\`\`\nq1: Please return stdout, stderr, and the exit code.\n`
          : "";
    const response = `RESPONSE NUMBER 1 | ${fixture.role}->operator\n${fixture.id} fixture reply\n${codeExample}\nCONTEXT CHECK: RESPONSE 1 = READABLE\nSummary\n${fixture.id} completed.`;
    // DeepSeek can put only the first token in a nested code element and leave
    // the rest in sibling spans. Its outer banner identifies the actual shell.
    const answerMarkup =
      fixture.id === "deepseek"
        ? response
            .split(/(```(?:powershell|bash)\n[\s\S]*?\n```)/g)
            .map((part, index) => {
              const code = /^```(\w+)\n([\s\S]*?)\n```$/.exec(part);
              if (!code) {
                const reference =
                  index === 0
                    ? `<p>File: README.md (reference contents)</p><pre><code class="language-markdown">${escapeHTML("# Reference\n\n```powershell\nclear\nWrite-Output 'Reference only'\n```\n\n````text\nq1: Historical example, not an Operator question.\nSummary: Historical example.\n````")}</code></pre>`
                    : "";
                return `<p>${escapeHTML(part).replaceAll("\n", "<br>")}</p>${reference}`;
              }
              const prefixLength = code[2].indexOf("\n") + 4;
              const prefix = escapeHTML(code[2].slice(0, prefixLength));
              const remaining = escapeHTML(code[2].slice(prefixLength));
              return `<div class="md-code-block"><div class="md-code-block-banner-wrap"><span>${code[1]}</span><div role="button">Copy</div></div><div class="code-scroll"><pre><span class="first-token"><code class="language-sql">${prefix}</code></span><span class="remaining-tokens">${remaining}</span></pre></div></div>`;
            })
            .join("")
        : `<p>${escapeHTML(response).replaceAll("\n", "<br>")}</p>`;
    const replyMarkup = fixture.response
      .replace("BODY", answerMarkup)
      .replace(
        'class="ds-assistant-message-main-content"',
        'data-message-role="assistant"',
      );
    const greeting = fixture.response
      .replace("BODY", "<p>Hi! How can I help you today?</p>")
      .replace(/id="([^"]+)"/g, (_match, id) => `id="${id}-old-greeting"`);
    const body =
      '<!doctype html><html><head><style>[contenteditable]{min-height:40px;white-space:pre-wrap}</style></head><body><main><div id="history"><div id="old-greeting" hidden>' +
      greeting +
      "</div></div><form>" +
      fixture.controls +
      "</form></main><script>" +
      'window.submits=0; const editor=document.querySelector("textarea,[contenteditable]"); const button=document.querySelector("button"); editor.addEventListener("input",()=>{button.disabled=false;});document.querySelector("form").addEventListener("submit",event=>{event.preventDefault();window.submits++;window.lastSubmitted=editor.tagName==="TEXTAREA"?editor.value:editor.innerText;if(editor.tagName==="TEXTAREA")editor.value="";else editor.replaceChildren();button.disabled=true;document.getElementById("old-greeting").hidden=false;setTimeout(()=>document.getElementById("history").insertAdjacentHTML("beforeend",' +
      "(window.nextReply ?? " +
      JSON.stringify(replyMarkup) +
      ")" +
      "),window.submits===1?5500:200);});" +
      "</script></body></html>";
    chrome.onEvent((event) => {
      if (
        event.sessionId === sessionId &&
        event.method === "Fetch.requestPaused"
      ) {
        void chrome
          .call(
            "Fetch.fulfillRequest",
            {
              requestId: event.params.requestId,
              responseCode: 200,
              responseHeaders: [
                { name: "Content-Type", value: "text/html; charset=utf-8" },
              ],
              body: Buffer.from(body).toString("base64"),
            },
            sessionId,
          )
          .catch(() => {});
      }
    });
    await chrome.call(
      "Fetch.enable",
      {
        patterns: [
          {
            urlPattern: "*",
            resourceType: "Document",
            requestStage: "Request",
          },
        ],
      },
      sessionId,
    );
    await chrome.call("Page.navigate", { url: fixture.url }, sessionId);
    await until(
      () =>
        chrome.evaluate('Boolean(document.querySelector("form"))', sessionId),
      `${fixture.id} fixture page`,
    );
  }

  return sessions;
}
