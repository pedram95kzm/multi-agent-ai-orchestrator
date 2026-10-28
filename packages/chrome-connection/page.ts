import type { ChatAdapter } from "./adapters";
export interface PageRequest {
  mode: "inspect" | "fill" | "submit";
  expectedURL: string;
  content?: string;
  adapter: ChatAdapter;
}
export interface PageState {
  url: string;
  ready: boolean;
  busy: boolean;
  empty: boolean;
  matches: boolean;
  sendReady: boolean;
  composerFound: boolean;
  response?: string;
  responseId?: string;
  turnCount: number;
  lastNumber: number;
  lastRole?: "actor" | "watcher" | "setup";
  submitted?: boolean;
  error?: string;
}

export function isNewTurn(
  page: Pick<PageState, "turnCount" | "responseId" | "lastNumber">,
  baseline: { turnCount: number; responseId?: string; lastNumber: number },
) {
  return (
    page.turnCount > baseline.turnCount ||
    !!(page.responseId && page.responseId !== baseline.responseId) ||
    page.lastNumber > baseline.lastNumber
  );
}

export function matchesExpectedResponse(
  content: string | undefined,
  role: "actor" | "watcher",
  number: number,
) {
  const header =
    /^RESPONSE NUMBER ([1-9]\d*) \| (actor|watcher)->(operator|actor|watcher)(?:\r?\n|$)/.exec(
      content?.trimStart() ?? "",
    );
  return (
    !!header &&
    Number(header[1]) === number &&
    header[2] === role &&
    header[3] !== role
  );
}

// Injected into the page's main world by the extension, including already-open tabs.
export function chatPage(request: PageRequest): PageState {
  const config = request.adapter;
  const canonical = (value: string) => {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  };
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !el.closest('[hidden],[aria-hidden="true"]')
    );
  };
  const choose = (selectors: string[]) => {
    for (const selector of selectors) {
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>(selector),
      ).filter(visible);
      if (elements.length) return elements;
    }
    return [] as HTMLElement[];
  };
  const editors = choose(config.composers).filter(
    (el) => !el.matches(":disabled,[readonly]"),
  );
  const editor = editors.length === 1 ? editors[0] : undefined;
  const value = () =>
    editor instanceof HTMLTextAreaElement
      ? editor.value
      : (editor?.innerText ?? editor?.textContent ?? "");
  const normalize = (text: string) =>
    text
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/\n$/, "");
  const insertion = (request.content ?? "").replace(/\r\n?/g, "\n");
  // Providers may use different supported wrappers for old and new turns.
  // Merge selectors in document order and count nested wrappers only once.
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(config.responses.join(",")),
  ).filter(visible);
  const turns = candidates.filter(
    (node) =>
      !candidates.some((other) => node !== other && node.contains(other)),
  );
  const turn = turns.at(-1);
  const answer =
    turn &&
    (config.answer ? (turn.querySelector(config.answer) ?? turn) : turn);
  const excluded = (node: HTMLElement) => {
    const style = getComputedStyle(node);
    return (
      node.hidden ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      node.matches(
        `button,svg,script,style,[role="button"],[aria-hidden="true"],${config.thinking}`,
      ) ||
      !!(config.codeHeader && node.matches(config.codeHeader))
    );
  };
  const codeText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement) || excluded(node)) return "";
    if (node.tagName === "BR") return "\n";
    let text = "";
    let previousBlock = false;
    for (const child of Array.from(node.childNodes)) {
      const value = codeText(child);
      if (!value) continue;
      const block =
        child instanceof HTMLElement && /^(DIV|P|LI)$/.test(child.tagName);
      if (
        (block || previousBlock) &&
        text &&
        !text.endsWith("\n") &&
        !value.startsWith("\n")
      )
        text += "\n";
      text += value;
      previousBlock = block;
    }
    return text;
  };
  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (excluded(node)) return "";
    if (node.tagName === "PRE") {
      const code = node.querySelector("code");
      const tokens = Array.from(node.querySelectorAll("code"));
      // DeepSeek can wrap just the first plain token in <code> and put the
      // remaining syntax tokens outside that wrapper. Its entire pre is code.
      let container = config.codeBlock ? node : (code?.parentElement ?? node);
      while (
        container !== node &&
        tokens.some((token) => !container.contains(token))
      )
        container = container.parentElement!;
      const block = config.codeBlock
        ? node.closest(config.codeBlock)
        : node.parentElement;
      const label = config.codeLanguage
        ? block?.querySelector(config.codeLanguage)?.textContent?.trim()
        : undefined;
      const declaredLanguage =
        (label && /^[\w+-]+$/.test(label) ? label : undefined) ??
        node.getAttribute("data-language");
      const tokenLanguage = /language-([\w-]+)/.exec(
        code?.className ?? "",
      )?.[1];
      // The outer banner describes the real fence; an inner token may carry a
      // different language class (for example Python/SQL inside PowerShell).
      const language =
        (config.codeBlock
          ? (declaredLanguage ?? tokenLanguage)
          : (tokenLanguage ?? declaredLanguage)) ?? "";
      // Highlighting may split a single block across sibling <code> elements.
      // Include every token while leaving any outer language toolbar behind.
      const body = codeText(container).replace(/\n$/, "");
      let width = 3;
      for (const run of body.matchAll(/`{3,}/g))
        width = Math.max(width, run[0].length + 1);
      const fence = "`".repeat(width);
      return `\n${fence}${language}\n${body}\n${fence}\n`;
    }
    if (node.tagName === "BR") return "\n";
    const text = Array.from(node.childNodes).map(serialize).join("");
    return /^(P|DIV|ARTICLE|SECTION|H[1-6]|LI|BLOCKQUOTE)$/.test(node.tagName)
      ? `\n${text}\n`
      : text;
  };
  const response = answer ? serialize(answer).trim() : undefined;
  const busy =
    !!choose([config.stop]).length ||
    !!(turn && !response && turn.querySelector(config.thinking));
  let error: string | undefined;
  if (canonical(location.href) !== canonical(request.expectedURL))
    error =
      "The tab left this task's saved chat URL. Update the URL before sending.";
  else if (!editor)
    error = `${config.name}: expected one visible composer, found ${editors.length}. Sign in and open the chat in Chrome.`;
  else if (busy) error = `${config.name} is still generating a response.`;
  if (request.mode === "fill" && !error) {
    if (value().trim())
      error =
        "The composer already contains a draft. Clear or submit it in Chrome first.";
    else {
      editor!.focus();
      if (editor instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(editor, insertion);
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor!);
        selection?.removeAllRanges();
        selection?.addRange(range);
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, insertion);
        } catch {}
        if (
          !inserted ||
          normalize(editor!.innerText ?? editor!.textContent ?? "") !==
            normalize(insertion)
        ) {
          const paragraph = document.createElement("p");
          paragraph.textContent = insertion;
          editor!.replaceChildren(paragraph);
        }
      }
      editor!.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: insertion,
        }),
      );
      editor!.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  const matches = normalize(value()) === normalize(request.content ?? "");
  const buttons = choose(config.send).filter(
    (el) => !el.matches(":disabled,[aria-disabled=true],.ds-button--disabled"),
  );
  const sendReady = buttons.length === 1;
  let submitted = false;
  if (request.mode === "submit" && !error) {
    if (!matches || !value().trim())
      error =
        "The composer differs from the exact outgoing message. Nothing was submitted.";
    else if (!sendReady)
      error = `${config.name}: expected one enabled Send control, found ${buttons.length}.`;
    else {
      buttons[0].click();
      submitted = true;
    }
  }
  return {
    url: location.href,
    ready: !error,
    busy,
    empty: !value().trim(),
    matches,
    sendReady,
    composerFound: !!editor,
    response,
    responseId: turn?.getAttribute("data-message-id") ?? turn?.id ?? undefined,
    turnCount: turns.length,
    lastNumber: Number(
      /^RESPONSE NUMBER ([1-9]\d*) \| /.exec(response ?? "")?.[1] ?? 0,
    ),
    lastRole: /^RESPONSE NUMBER [1-9]\d* \| (actor|watcher|setup)->/.exec(
      response ?? "",
    )?.[1] as PageState["lastRole"],
    submitted,
    error,
  };
}
