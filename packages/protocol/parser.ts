import type { BatchShell, ContextCheck, Parsed } from "../shared/types";

// Fence-aware parsing keeps examples, quoted protocol headers, and shell output out of metadata.
export function parseResponse(
  content: string,
  options: { handover?: boolean } = {},
): Parsed {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const result: Parsed = {
    recipient: "unknown",
    questions: [],
    batches: [],
    batchShells: [],
    issues: [],
    approval: false,
  };
  const first = lines.findIndex((l) => l.trim().length > 0);
  const header =
    /^RESPONSE NUMBER ([1-9]\d*) \| (watcher|actor|setup)->(operator|actor|watcher)$/.exec(
      lines[first]?.trim() ?? "",
    );
  if (header) {
    result.number = Number(header[1]);
    result.sender = header[2] as Parsed["sender"];
    result.recipient = header[3] as Parsed["recipient"];
    if (
      (result.sender === "setup" &&
        (result.number !== 1 || result.recipient !== "operator")) ||
      result.sender === result.recipient
    )
      result.issues.push("Invalid sender or recipient prefix.");
  } else
    result.issues.push(
      "Missing exact RESPONSE NUMBER n | sender->recipient header. Select a recipient manually.",
    );
  const packet = /^\s*ONBOARDING PACKET:\s*(actor|watcher)\s*$/i.exec(
    lines.slice(first + 1).find((line) => line.trim()) ?? "",
  );
  if (packet)
    result.onboardingRole = packet[1].toLowerCase() as "actor" | "watcher";
  result.handover =
    options.handover ||
    /^\s*HANDOVER PACKET\s*$/i.test(
      lines.slice(first + 1).find((line) => line.trim()) ?? "",
    ) ||
    undefined;
  let fence = "",
    language = "",
    block: string[] = [],
    outside: string[] = [],
    summaryAt = -1,
    operatorLines: string[] | undefined;
  const contextChecks = new Set<ContextCheck>();
  for (const line of lines.slice(first + 1)) {
    if (operatorLines) {
      operatorLines.push(line);
      continue;
    }
    if (!fence && /^_{4,}\s*$/.test(line)) {
      operatorLines = [];
      continue;
    }
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (fence) {
        if (
          marker[1][0] !== fence[0] ||
          marker[1].length < fence.length ||
          marker[2].trim()
        ) {
          block.push(line);
          continue;
        }
        const shell: BatchShell | undefined = /^(powershell|pwsh|ps1)$/i.test(
          language,
        )
          ? "powershell"
          : /^(bash|sh|shell)$/i.test(language) ||
              (!language && block[0]?.trim() === "clear")
            ? "bash"
            : undefined;
        if (shell) {
          result.batches.push(block.join("\n"));
          result.batchShells!.push(shell);
        }
        fence = "";
        language = "";
        block = [];
      } else {
        fence = marker[1];
        language = marker[2].trim();
      }
      continue;
    }
    if (fence) {
      block.push(line);
      continue;
    }
    const contextCheck =
      /^\s*CONTEXT CHECK:\s*RESPONSE 1\s*=\s*(READABLE|UNAVAILABLE|NOT_ESTABLISHED)\s*$/i.exec(
        line,
      );
    if (contextCheck) {
      // A legacy packet may quote the entire protocol without fences. Its last
      // status before the final Summary is the preparer's current context check.
      if (result.onboardingRole || result.handover) contextChecks.clear();
      contextChecks.add(
        contextCheck[1].toLowerCase().replace("_", "-") as ContextCheck,
      );
      continue;
    }
    outside.push(line);
    const directory =
      /^\s*(?:\*\*)?Working directory(?:\*\*)?\s*:(?:\*\*)?\s*(.+?)\s*$/i.exec(
        line,
      );
    if (directory && !result.onboardingRole && !result.handover) {
      const path = directory[1].replace(/^([`"'])(.*)\1$/, "$2").trim();
      if (result.workingDirectory && result.workingDirectory !== path)
        result.issues.push(
          "Conflicting working directories; confirm one directory for the batch.",
        );
      else result.workingDirectory = path;
    }
    const heading = line
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*\*\*(Summary:?)\*\*/i, "$1");
    const summary = /^\s*Summary(?:\s*:\s*(.*)|\s*)$/i.exec(heading);
    if (summary) {
      summaryAt = outside.length - 1;
      outside[summaryAt] = summary[1] ?? "";
    }
    const q = /^\s*(q\d+):\s+(.+)$/i.exec(line);
    if (q && !result.onboardingRole && !result.handover)
      result.questions.push({ id: q[1], text: q[2] });
    if (
      /^\s*(?:I explicitly approve (?:this|the exact) batch[.!:]?|APPROVED(?: BATCH)?[.!:]?)\s*$/i.test(
        line,
      )
    )
      if (!result.onboardingRole && !result.handover) result.approval = true;
  }
  // A transfer is a continuation document. Its directories and question examples
  // describe history, not a current execution request or an Operator answer form.
  if (result.onboardingRole || result.handover) {
    result.questions = [];
    result.workingDirectory = undefined;
    result.approval = false;
    result.issues = result.issues.filter(
      (issue) => !issue.startsWith("Conflicting working directories"),
    );
  }
  if (fence)
    result.issues.push(
      "Unclosed code fence; no incomplete batch will be executed.",
    );
  if (summaryAt >= 0)
    result.summary = outside.slice(summaryAt).join("\n").trim() || undefined;
  if (operatorLines) result.operatorInput = operatorLines.join("\n");
  if (contextChecks.size === 1) result.contextCheck = [...contextChecks][0];
  else if (contextChecks.size > 1)
    result.issues.push(
      "Conflicting context-check statuses; request a single current status.",
    );
  if (!result.summary && result.sender !== "setup")
    result.issues.push("Missing agent-authored Summary section.");
  if (
    result.summary &&
    result.summary.split("\n").filter((l) => l.trim()).length > 3
  )
    result.issues.push("Summary exceeds the protocol limit of three lines.");
  if (
    new Set(result.questions.map((q) => q.id.toLowerCase())).size !==
    result.questions.length
  ) {
    result.questions = [];
    result.issues.push("Ambiguous repeated question IDs; use the composer.");
  }
  if (result.batches.length > 1)
    result.issues.push("Only one command batch is allowed per response.");
  for (const batch of result.batches)
    result.issues.push(...validateBatch(batch));
  return result;
}
export function validateBatch(batch: string): string[] {
  const issues: string[] = [];
  if (batch.split("\n")[0] !== "clear")
    issues.push("The first batch line must be exactly clear.");
  if (/\bgit\s+add\s+(?:-A|--all|\.)(?:\s|$)/m.test(batch))
    issues.push("Broad git staging is prohibited.");
  if (/\bgit\s+commit\b/m.test(batch))
    issues.push(
      "Git commits require separate explicit operator authorization; run them outside this service.",
    );
  return issues;
}
export function operatorPayload(
  input: string,
  separator = "__________",
): string {
  return /^_{4,}\s*$/.test(input.trimStart().split("\n")[0])
    ? input
    : `${separator}\n${input}`;
}
export function formatAnswers(
  questions: { id: string }[],
  answers: Record<string, string>,
): string {
  if (questions.some((q) => !answers[q.id]?.trim()))
    throw new Error("Answer every question before submitting.");
  return questions.map((q) => `${q.id}: ${answers[q.id].trim()}`).join("\n\n");
}

export function hasBlockingIssues(parsed: Parsed): boolean {
  return parsed.issues.some(
    (issue) =>
      !issue.startsWith("Missing agent-authored") &&
      !issue.startsWith("Summary exceeds"),
  );
}
