import type { ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";
import { fencedCodeBlocks } from "../../../../../packages/protocol/fences";

// Render fenced code as text, without interpreting HTML or changing the saved message.
export function MessageContent({
  content,
  codeOnly = false,
  codeActions,
}: {
  content: string;
  codeOnly?: boolean;
  codeActions?: (code: string, language: string) => ReactNode;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const block of fencedCodeBlocks(content)) {
    if (!codeOnly && block.start > cursor)
      parts.push(
        <span key={`text-${cursor}`}>
          {content.slice(cursor, block.start)}
        </span>,
      );
    parts.push(
      <CodeBlock
        key={`code-${block.start}`}
        code={block.code}
        language={block.language}
        actions={codeActions?.(block.code, block.language)}
      />,
    );
    cursor = block.end;
  }
  if (!codeOnly && cursor < content.length)
    parts.push(<span key={`text-${cursor}`}>{content.slice(cursor)}</span>);
  return <div className="complete">{parts}</div>;
}
