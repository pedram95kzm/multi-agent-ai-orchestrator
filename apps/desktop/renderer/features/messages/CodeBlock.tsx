import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import { copy } from "../../ui";
import type { ReactNode } from "react";

for (const [name, grammar] of Object.entries({
  bash,
  powershell,
  python,
  javascript,
  typescript,
  json,
  css,
  xml,
  sql,
  yaml,
  diff,
}))
  hljs.registerLanguage(name, grammar);
hljs.registerAliases(["shell", "shell-session", "console", "terminal"], {
  languageName: "bash",
});
hljs.registerAliases(["pwsh", "ps1"], { languageName: "powershell" });

export function CodeBlock({
  code,
  language = "",
  label,
  actions,
}: {
  code: string;
  language?: string;
  label?: string;
  actions?: ReactNode;
}) {
  const [copied, setCopied] = useState("");
  useEffect(() => setCopied(""), [code]);
  const detected =
    language.toLowerCase() || (/^clear\r?\n/.test(code) ? "bash" : "text");
  const highlighted = useMemo(() => {
    if (!hljs.getLanguage(detected) || code.length > 100_000) return undefined;
    try {
      return hljs.highlight(code, { language: detected, ignoreIllegals: true })
        .value;
    } catch {
      return undefined;
    }
  }, [code, detected]);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{label ?? detected}</span>
        <div className="code-actions">
          <button
            type="button"
            aria-label={`Copy ${label ?? detected} code`}
            onClick={async () => {
              try {
                await copy(code);
                setCopied("Copied");
              } catch {
                setCopied("Copy failed — try again");
              }
            }}
          >
            {copied || "Copy code"}
          </button>
          {actions}
        </div>
      </div>
      <pre>
        <code
          className={`hljs language-${detected}`}
          {...(highlighted === undefined
            ? { children: code }
            : { dangerouslySetInnerHTML: { __html: highlighted } })}
        />
      </pre>
    </div>
  );
}
