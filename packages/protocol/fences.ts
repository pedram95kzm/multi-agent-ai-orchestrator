// Preserve the exact code bytes for display and copying, including line endings.
export function fencedCodeBlocks(content: string) {
  const blocks: {
    start: number;
    end: number;
    language: string;
    code: string;
  }[] = [];
  const opening = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(content))) {
    const start = opening.lastIndex;
    const closing = new RegExp(
      String.raw`^[ \t]{0,3}${match[1][0]}{${match[1].length},}[ \t]*(?:\r?\n|$)`,
      "gm",
    );
    closing.lastIndex = start;
    const end = closing.exec(content);
    blocks.push({
      start: match.index,
      end: end ? closing.lastIndex : content.length,
      language: match[2].trim().split(/\s+/)[0],
      code: content.slice(start, end?.index ?? content.length),
    });
    opening.lastIndex = end ? closing.lastIndex : content.length;
    if (!end) break;
  }
  return blocks;
}

// Reproduce the older DOM capture's fixed triple fences for strict comparison.
// Only the delimiters change; never decode or repair the code bodies themselves.
export function legacyCapturedFences(content: string): string {
  let result = "";
  let end = 0;
  for (const block of fencedCodeBlocks(content)) {
    const serialized = content.slice(block.start, block.end);
    result += content.slice(end, block.start);
    result += serialized
      .replace(/^`{3,}([^\r\n]*)\n/, "```$1\n")
      .replace(/\n`{3,}(\n?)$/, "\n```$1");
    end = block.end;
  }
  return result + content.slice(end);
}
