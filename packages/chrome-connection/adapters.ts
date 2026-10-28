export interface ChatAdapter {
  id: "chatgpt" | "qwen" | "deepseek" | "glm";
  name: string;
  hosts: string[];
  composers: string[];
  send: string[];
  responses: string[];
  answer?: string;
  thinking: string;
  stop: string;
  codeHeader?: string;
  codeLanguage?: string;
  codeBlock?: string;
}
export const adapters: ChatAdapter[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    composers: [
      '#prompt-textarea[contenteditable="true"]',
      "textarea#prompt-textarea,textarea#mobile-composer-prompt",
      '[contenteditable="true"][role="textbox"]',
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"],button[aria-label="Send message"]',
    ],
    responses: [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
    ],
    answer: ".markdown",
    thinking: '[data-testid="thoughts"],[data-testid="reasoning-summary"]',
    stop: '[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="Stop generating"]',
  },
  {
    id: "qwen",
    name: "Qwen",
    hosts: ["chat.qwen.ai"],
    composers: [
      "textarea.message-input-textarea",
      'textarea[placeholder*="Qwen" i],textarea[placeholder*="Message" i]',
    ],
    send: [
      'button.send-button[aria-label="Send"]',
      'button[aria-label="Send"]',
    ],
    responses: [".qwen-chat-message-assistant"],
    answer: ".response-message-content.phase-answer",
    thinking: ".phase-thinking,.thinking-content",
    stop: '.stop-button,button[aria-label="Stop"],button[aria-label*="Stop generating" i]',
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hosts: ["chat.deepseek.com"],
    composers: [
      'textarea#chat-input,textarea[data-testid="chat-input"]',
      'textarea[placeholder*="DeepSeek" i]',
      'textarea[name="search"]',
    ],
    send: [
      '[data-testid="send-button"],button[aria-label="Send message"]',
      ".ds-button.ds-button--primary.ds-button--circle",
      '[role="button"][aria-label="Send"]',
    ],
    responses: [
      ".ds-assistant-message-main-content",
      '[data-message-role="assistant"]',
    ],
    thinking: ".ds-think-content",
    codeHeader: ".md-code-block-banner-wrap",
    codeLanguage: ".md-code-block-banner-wrap span",
    codeBlock: ".md-code-block",
    stop: '[data-testid="stop-button"],button[aria-label="Stop"],[role="button"][aria-label="Stop"]',
  },
  {
    id: "glm",
    name: "GLM",
    hosts: ["chat.z.ai"],
    composers: ["textarea#chat-input"],
    send: ["button#send-message-button"],
    responses: [".chat-assistant", '[class*="chat-assistant"]'],
    thinking:
      '.thinking-chain-container,[class*="thinking-chain"],[class*="Thinking"]',
    stop: '#stop-message-button,.stopGeneratingButton,button[aria-label="Stop"],button[aria-label="Stop generating"]',
  },
];
export function adapterForURL(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Use an HTTPS chat URL without credentials.");
  const adapter = adapters.find((candidate) =>
    candidate.hosts.includes(url.hostname),
  );
  if (!adapter)
    throw new Error(
      "Supported chats: ChatGPT, Qwen, DeepSeek, and GLM (chat.z.ai).",
    );
  return adapter;
}
