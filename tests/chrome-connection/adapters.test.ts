import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { parseResponse } from "../../packages/protocol/parser";
import { fencedCodeBlocks } from "../../packages/protocol/fences";
import {
  adapters,
  adapterForURL,
} from "../../packages/chrome-connection/adapters";
import {
  chatPage,
  isNewTurn,
  matchesExpectedResponse,
  type PageRequest,
  type PageState,
} from "../../packages/chrome-connection/page";

const fixtures = [
  [
    "chatgpt",
    "https://chatgpt.com/c/test",
    '<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button>',
  ],
  [
    "qwen",
    "https://chat.qwen.ai/c/test",
    '<textarea class="message-input-textarea"></textarea><button class="send-button" aria-label="Send">Send</button>',
  ],
  [
    "deepseek",
    "https://chat.deepseek.com/a/chat/s/test",
    '<textarea placeholder="Message DeepSeek"></textarea><button class="ds-button ds-button--primary ds-button--circle">Send</button>',
  ],
  [
    "glm",
    "https://chat.z.ai/c/test",
    '<textarea id="chat-input"></textarea><button id="send-message-button">Send</button>',
  ],
] as const;
function page(markup: string, url: string) {
  const dom = new JSDOM(`<main>${markup}</main>`, {
    url,
    runScripts: "outside-only",
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 30,
    width: 100,
    height: 30,
    toJSON: () => ({}),
  });
  const run = (request: Omit<PageRequest, "adapter" | "expectedURL">) =>
    dom.window.eval(
      `(${chatPage.toString()})(${JSON.stringify({ ...request, adapter: adapterForURL(url), expectedURL: url })})`,
    ) as PageState;
  return { dom, run };
}
describe("extension chat adapters", () => {
  it.each(fixtures)(
    "preserves Markdown reference fences and the separate executable documentation batch on %s",
    (id, url, controls) => {
      const documentation = [
        "# Project",
        "",
        "```powershell",
        "python .\\hello.py",
        "```",
        "",
        "````text",
        "Summary: historical example",
        "q1: historical question",
        "````",
      ].join("\n");
      const command = [
        "clear",
        "$lines = @('```powershell', 'python .\\hello.py', '```')",
        "Set-Content -LiteralPath README.md -Value $lines -Encoding UTF8",
      ].join("\n");
      const escape = (value: string) =>
        value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      const shellBlock = `<pre><code class="language-powershell">${escape(command)}</code></pre>`;
      const executable =
        id === "deepseek"
          ? `<div class="md-code-block"><div class="md-code-block-banner-wrap"><span>powershell</span></div>${shellBlock}</div>`
          : shellBlock;
      const body = `<p>RESPONSE NUMBER 8 | watcher-&gt;operator</p><p>APPROVED</p><p>File: README.md (reference contents)</p><pre><code class="language-markdown">${escape(documentation)}</code></pre><p>Working directory: C:\\Projects\\a</p>${executable}<p>q1: Return the actual output.</p><p>Summary: Documentation approved.</p>`;
      const wrappers = {
        chatgpt: `<div data-message-author-role="assistant"><div class="markdown">${body}</div></div>`,
        qwen: `<div class="qwen-chat-message-assistant">${body}</div>`,
        deepseek: `<div class="ds-assistant-message-main-content">${body}</div>`,
        glm: `<div class="chat-assistant">${body}</div>`,
      };
      const { dom, run } = page(`${wrappers[id]}${controls}`, url);
      const captured = run({ mode: "inspect" }).response!;
      const blocks = fencedCodeBlocks(captured);
      expect(blocks.map((block) => [block.language, block.code])).toEqual([
        ["markdown", `${documentation}\n`],
        ["powershell", `${command}\n`],
      ]);
      const parsed = parseResponse(captured);
      expect(parsed.batches).toEqual([command]);
      expect(parsed.batchShells).toEqual(["powershell"]);
      expect(parsed.workingDirectory).toBe("C:\\Projects\\a");
      expect(parsed.questions).toEqual([
        { id: "q1", text: "Return the actual output." },
      ]);
      expect(parsed.issues).toEqual([]);
      dom.window.close();
    },
  );
  it("reads the latest supported assistant wrapper instead of a greeting using an older wrapper", () => {
    const { dom, run } = page(
      '<div class="ds-assistant-message-main-content" id="greeting"><p>Hi! How can I help you today?</p></div><div data-message-role="assistant" id="new-wrapper"><div class="ds-assistant-message-main-content"><p>RESPONSE NUMBER 1 | actor-&gt;watcher</p><p>Use the new Watcher briefing.</p><p>Summary: Ready.</p></div></div><div data-message-role="assistant" id="latest-wrapper"><p>RESPONSE NUMBER 2 | actor-&gt;watcher</p><p>Newest answer.</p><p>Summary: Continued.</p></div><textarea placeholder="Message DeepSeek"></textarea>',
      "https://chat.deepseek.com/a/chat/s/test",
    );
    const result = run({ mode: "inspect" });
    expect(result.response).toContain("Newest answer.");
    expect(result.response).not.toContain("Hi!");
    expect(result.lastNumber).toBe(2);
    expect(result.turnCount).toBe(3);
    dom.window.close();
  });
  it.each([
    "Hi! How can I help you today?",
    "RESPONSE NUMBER 1 | watcher->actor\nWrong role.",
    "RESPONSE NUMBER 2 | actor->watcher\nOld response.",
    "RESPONSE NUMBER 4 | actor->watcher\nWrong counter.",
    "RESPONSE NUMBER 3 | actor->actor\nWrong recipient.",
    "```text\nRESPONSE NUMBER 3 | actor->watcher\nQuoted example.",
  ])(
    "does not accept an unmatched visible answer as the current delivery: %s",
    (content) => {
      expect(matchesExpectedResponse(content, "actor", 3)).toBe(false);
    },
  );
  it.each(["actor", "watcher"] as const)(
    "accepts only the expected new %s response",
    (role) => {
      expect(
        matchesExpectedResponse(
          `\nRESPONSE NUMBER 3 | ${role}->operator\r\nCurrent answer.`,
          role,
          3,
        ),
      ).toBe(true);
    },
  );
  it.each(fixtures)(
    "fills and clicks exactly once on %s",
    (id, url, controls) => {
      const { dom, run } = page(`<form>${controls}</form>`, url);
      let submitted = "";
      let clicks = 0;
      dom.window.document
        .querySelector("button")!
        .addEventListener("click", () => {
          clicks++;
        });
      dom.window.document
        .querySelector("form")!
        .addEventListener("submit", (event) => {
          event.preventDefault();
          const editor = dom.window.document.querySelector(
            "textarea,[contenteditable]",
          )!;
          submitted =
            editor instanceof dom.window.HTMLTextAreaElement
              ? editor.value
              : editor.textContent!;
          if (editor instanceof dom.window.HTMLTextAreaElement)
            editor.value = "";
          else editor.replaceChildren();
        });
      const text = "Exact first line\n\nپاسخ فارسی\n`literal` $variable";
      expect(adapterForURL(url).id).toBe(id);
      expect(run({ mode: "fill", content: text }).matches).toBe(true);
      expect(clicks).toBe(0);
      expect(run({ mode: "submit", content: text }).submitted).toBe(true);
      expect(clicks).toBe(1);
      expect(submitted).toBe(text);
      expect(run({ mode: "inspect" }).empty).toBe(true);
      dom.window.close();
    },
  );
  it.each([
    "https://chatgpt.com.evil.test/",
    "https://user:password@chat.z.ai/",
    "http://chat.qwen.ai/",
    "javascript://chat.deepseek.com/",
    "https://claude.ai/",
  ])("rejects unsupported or unsafe URLs: %s", (url) => {
    expect(() => adapterForURL(url)).toThrow();
  });
  it("never overwrites a draft or submits text that changed after filling", () => {
    const { dom, run } = page(
      '<textarea id="chat-input">My draft</textarea><button id="send-message-button">Send</button>',
      "https://chat.z.ai/c/test",
    );
    expect(run({ mode: "fill", content: "Replace" }).error).toContain(
      "already contains",
    );
    expect(dom.window.document.querySelector("textarea")!.value).toBe(
      "My draft",
    );
    expect(run({ mode: "submit", content: "Replace" }).submitted).toBe(false);
    dom.window.close();
  });
  it("extracts assistant answers with exact code whitespace while excluding user and thinking text", () => {
    const markup =
      '<div class="user-message">Do not capture me</div><div class="chat-assistant" data-message-id="answer-2"><div class="thinking-chain-container">Private thinking</div><p>RESPONSE NUMBER 2 | watcher-&gt;operator</p><pre><code class="language-bash">clear\ncat &lt;&lt;EOF\n\n\nexact\nEOF</code></pre><h2>Summary</h2><p>Verified.</p><button>Copy</button></div><textarea id="chat-input"></textarea>';
    const { dom, run } = page(markup, "https://chat.z.ai/c/test");
    const result = run({ mode: "inspect" });
    expect(result.response).toContain(
      "```bash\nclear\ncat <<EOF\n\n\nexact\nEOF\n```",
    );
    expect(result.response).not.toMatch(
      /Private thinking|Do not capture me|Copy/,
    );
    expect(result.lastNumber).toBe(2);
    expect(result.responseId).toBe("answer-2");
    dom.window.close();
  });
  it("does not submit while a stop-generation control is visible", () => {
    const { dom, run } = page(
      '<textarea id="chat-input"></textarea><button id="stop-message-button">Stop</button>',
      "https://chat.z.ai/c/test",
    );
    expect(run({ mode: "fill", content: "hello" }).busy).toBe(true);
    expect(dom.window.document.querySelector("textarea")!.value).toBe("");
    dom.window.close();
  });
  it("captures an advanced protocol response when DeepSeek reuses the same turn elements without IDs", () => {
    const baseline = { turnCount: 2, lastNumber: 1, responseId: "" };
    expect(
      isNewTurn({ turnCount: 2, lastNumber: 2, responseId: "" }, baseline),
    ).toBe(true);
    expect(
      isNewTurn({ turnCount: 2, lastNumber: 1, responseId: "" }, baseline),
    ).toBe(false);
    expect(
      isNewTurn({ turnCount: 2, lastNumber: 0, responseId: "" }, baseline),
    ).toBe(false);
  });
  it("preserves DeepSeek code language and whitespace without copying the code toolbar", () => {
    const { dom, run } = page(
      '<div class="ds-assistant-message-main-content"><p>RESPONSE NUMBER 2 | actor-&gt;watcher</p><div class="md-code-block"><div class="md-code-block-banner-wrap"><div><span>bash</span></div><div role="button">Copy</div><div role="button">Download</div></div><pre><code>clear\ncat &lt;&lt;EOF\n\n  exact\nEOF</code></pre></div><p>Summary</p><p>Ready for review.</p></div><textarea placeholder="Message DeepSeek"></textarea>',
      "https://chat.deepseek.com/a/chat/s/test",
    );
    const result = run({ mode: "inspect" });
    expect(result.response).toContain(
      "```bash\nclear\ncat <<EOF\n\n  exact\nEOF\n```",
    );
    expect(result.response).not.toMatch(/Copy|Download|\n\nbash\n/);
    dom.window.close();
  });
  it.each(["sibling tokens", "mixed tokens", "line breaks", "line wrappers"])(
    "captures the whole DeepSeek PowerShell block with %s",
    (layout) => {
      const lines = [
        "clear",
        String.raw`[System.IO.Directory]::Exists('C:\Users\danesh\Desktop\a')`,
        String.raw`Get-ChildItem 'C:\Users\danesh\Desktop\a'`,
        "(Get-Command python).Source",
      ];
      const expected = lines.join("\n");
      const fragments = [
        "clear\n[System.IO.D",
        "irectory]::Exists(",
        String.raw`'C:\Users\danesh\Desktop\a'`,
        ")\nGet",
        "-ChildItem ",
        String.raw`'C:\Users\danesh\Desktop\a'`,
        "\n(Get",
        "-Command python).Source",
      ];
      const highlighted =
        layout === "sibling tokens"
          ? fragments.map((text) => `<code>${text}</code>`).join("")
          : layout === "mixed tokens"
            ? fragments
                .map((text, index) =>
                  index % 2 ? `<span>${text}</span>` : `<code>${text}</code>`,
                )
                .join("")
            : layout === "line breaks"
              ? `<code>${lines.map((line) => `<span>${line}</span>`).join("<br>")}</code>`
              : lines.map((line) => `<div><code>${line}</code></div>`).join("");
      const { dom, run } = page(
        `<div class="ds-assistant-message-main-content"><p>RESPONSE NUMBER 3 | watcher-&gt;operator</p><div class="md-code-block"><div class="md-code-block-banner-wrap"><span>powershell</span><div role="button">Copy</div></div><pre>${highlighted}<button>Download</button><span hidden>Hidden</span><span aria-hidden="true">Toolbar</span></pre></div><p>q1: Paste the output.</p><p>Summary</p><p>Inspect the directory and Python executable.</p></div><textarea placeholder="Message DeepSeek"></textarea>`,
        "https://chat.deepseek.com/a/chat/s/test",
      );
      const { response } = run({ mode: "inspect" });
      expect(fencedCodeBlocks(response!)).toEqual([
        expect.objectContaining({
          language: "powershell",
          code: `${expected}\n`,
        }),
      ]);
      expect(parseResponse(response!).batches).toEqual([expected]);
      expect(parseResponse(response!).questions).toEqual([
        { id: "q1", text: "Paste the output." },
      ]);
      expect(response).not.toMatch(/Copy|Download|Hidden|Toolbar/);
      dom.window.close();
    },
  );
  it("preserves whitespace across syntax tokens without inserting extra line breaks", () => {
    const { dom, run } = page(
      '<div class="ds-assistant-message-main-content"><p>RESPONSE NUMBER 2 | actor-&gt;watcher</p><pre data-language="bash"><code>clear\n\n  printf </code><span>"%s\\n"</span><code> "a &amp; b"  \n\n</code><code>pwd</code>\n</pre><p>Summary</p><p>Ready.</p></div><textarea placeholder="Message DeepSeek"></textarea>',
      "https://chat.deepseek.com/a/chat/s/test",
    );
    expect(fencedCodeBlocks(run({ mode: "inspect" }).response!)[0].code).toBe(
      'clear\n\n  printf "%s\\n" "a & b"  \n\npwd\n',
    );
    dom.window.close();
  });
  it("leaves outer language toolbars out of captured code on other providers", () => {
    const { dom, run } = page(
      '<div data-message-author-role="assistant"><div class="markdown"><p>RESPONSE NUMBER 2 | actor-&gt;watcher</p><pre><div><div><span>powershell</span><button>Copy code</button></div><div><code class="language-powershell">clear\nGet</code><span>-</span><code>ChildItem</code></div></div></pre><p>Summary</p><p>Inspect files.</p></div></div><div id="prompt-textarea" contenteditable="true"></div>',
      "https://chatgpt.com/c/test",
    );
    expect(fencedCodeBlocks(run({ mode: "inspect" }).response!)[0]).toEqual(
      expect.objectContaining({
        language: "powershell",
        code: "clear\nGet-ChildItem\n",
      }),
    );
    dom.window.close();
  });
  it("keeps exactly the four requested adapters", () =>
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "chatgpt",
      "qwen",
      "deepseek",
      "glm",
    ]));

  it("keeps an entire DeepSeek file-writing batch when only its first nested token is a code element", () => {
    const script = [
      "clear",
      String.raw`New-Item -ItemType Directory -Path .\docs -Force | Out-Null`,
      "@'",
      "def main():",
      '    print("hello world")',
      "",
      'if __name__ == "__main__":',
      "    main()",
      String.raw`'@ | Set-Content -Path .\hello.py -Encoding UTF8`,
      "@'",
      "# Hello World CLI",
      "",
      "## Behavior",
      "Running the program prints hello world.",
      "- hello.py defines main().",
      String.raw`'@ | Set-Content -Path .\docs\README.md -Encoding UTF8`,
      String.raw`python -m py_compile .\hello.py`,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      String.raw`python .\hello.py`,
      'Write-Output "VERIFIED: exact output: hello world"',
      String.raw`Get-Content .\docs\README.md`,
    ].join("\n");
    const split = script.indexOf("def") + 3;
    const escape = (text: string) =>
      text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const { dom, run } = page(
      `<div class="ds-assistant-message-main-content"><p>RESPONSE NUMBER 3 | watcher-&gt;operator</p><div class="md-code-block"><div class="md-code-block-banner-wrap"><span>powershell</span><div role="button">Copy code</div></div><div class="code-scroll"><pre><span class="first-token"><code class="language-sql">${escape(script.slice(0, split))}</code></span><span class="remaining-tokens">${escape(script.slice(split))}</span></pre></div></div><p>q1: Return the actual output.</p><p>Summary: Proposed file creation and verification.</p></div><textarea placeholder="Message DeepSeek"></textarea>`,
      "https://chat.deepseek.com/a/chat/s/test",
    );
    const result = run({ mode: "inspect" });
    expect(fencedCodeBlocks(result.response!)[0]).toEqual(
      expect.objectContaining({ language: "powershell", code: `${script}\n` }),
    );
    expect(parseResponse(result.response!).batches).toEqual([script]);
    expect(parseResponse(result.response!).batchShells).toEqual(["powershell"]);
    expect(result.response).not.toContain("Copy code");
    dom.window.close();
  });
});
