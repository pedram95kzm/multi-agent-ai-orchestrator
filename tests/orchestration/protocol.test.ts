import { describe, expect, it } from "vitest";
import {
  formatAnswers,
  operatorPayload,
  parseResponse,
  validateBatch,
} from "../../packages/protocol/parser";

describe("protocol parsing", () => {
  it.each(["watcher->actor", "actor->watcher", "watcher->operator"])(
    "treats a %s onboarding packet's historical directories and question IDs as document content",
    (route) => {
      const target = route === "actor->watcher" ? "watcher" : "actor";
      const parsed = parseResponse(
        `RESPONSE NUMBER 5 | ${route}\nONBOARDING PACKET: ${target}\nWorking directory: C:\\project\nWorking directory: C:\\project.\nq1: Historical role question.\nq1: Historical output question.\nAPPROVED\nCONTEXT CHECK: RESPONSE 1 = UNAVAILABLE\nCONTEXT CHECK: RESPONSE 1 = READABLE\nSummary: Transfer ready.`,
      );
      expect(parsed.onboardingRole).toBe(target);
      expect(parsed.workingDirectory).toBeUndefined();
      expect(parsed.questions).toEqual([]);
      expect(parsed.approval).toBe(false);
      expect(parsed.contextCheck).toBe("readable");
      expect(parsed.summary).toBe("Transfer ready.");
      expect(parsed.issues).toEqual([]);
    },
  );
  it("does not recognize a quoted onboarding marker as live metadata", () => {
    const parsed = parseResponse(
      "RESPONSE NUMBER 1 | watcher->operator\n```text\nONBOARDING PACKET: actor\n```\nq1: First?\nq1: Second?\nWorking directory: /one\nWorking directory: /two\nSummary: Current request.",
    );
    expect(parsed.onboardingRole).toBeUndefined();
    expect(parsed.issues).toContain(
      "Ambiguous repeated question IDs; use the composer.",
    );
    expect(
      parsed.issues.some((issue) =>
        issue.startsWith("Conflicting working directories"),
      ),
    ).toBe(true);
  });
  it.each([
    'Working directory: "C:\\Projects\\my app"',
    "**Working directory:** `C:\\Projects\\my app`",
    "Working directory: 'C:\\Projects\\my app'",
  ])("captures a chat working directory outside fences: %s", (line) => {
    const parsed = parseResponse(
      `RESPONSE NUMBER 1 | actor->watcher\n${line}\n\`\`\`powershell\nclear\nWrite-Output 'Working directory: fake'\n\`\`\`\nSummary: Inspect.`,
    );
    expect(parsed.workingDirectory).toBe("C:\\Projects\\my app");
    expect(parsed.issues).toEqual([]);
  });
  it("blocks conflicting directories and ignores directory lines inside code or operator input", () => {
    const parsed = parseResponse(
      "RESPONSE NUMBER 1 | watcher->operator\nWorking directory: /one\nWorking directory: /two\nSummary: Inspect.",
    );
    expect(parsed.issues.join(" ")).toContain(
      "Conflicting working directories",
    );
    expect(
      parseResponse(
        "RESPONSE NUMBER 1 | watcher->operator\n```text\nWorking directory: /fake\n```\nSummary: Inspect.\n__________\nWorking directory: /operator",
      ).workingDirectory,
    ).toBeUndefined();
  });
  it.each(["powershell", "pwsh", "ps1"])(
    "recognizes %s batches without interpreting their code as questions or Summary",
    (language) => {
      const code =
        "clear\nSet-Content temp.py @'\nSummary: file content\nq1: example\n'@\npython -m py_compile temp.py";
      const parsed = parseResponse(
        `RESPONSE NUMBER 1 | actor->watcher\n\`\`\`${language}\n${code}\n\`\`\`\nSummary: Propose the script.`,
      );
      expect(parsed.batches).toEqual([code]);
      expect(parsed.batchShells).toEqual(["powershell"]);
      expect(parsed.questions).toEqual([]);
      expect(parsed.summary).toBe("Propose the script.");
      expect(parsed.issues).toEqual([]);
    },
  );
  it.each([
    "Summary: Ready.",
    "**Summary:** Ready.",
    "**Summary**: Ready.",
    "### **Summary:** Ready.",
    "## Summary: Ready.",
    "Summary\nReady.",
    "**Summary:**\nReady.",
  ])("recognizes agent-authored summary format %s", (summary) => {
    const result = parseResponse(
      `RESPONSE NUMBER 1 | watcher->operator\n${summary}`,
    );
    expect(result.summary).toBe("Ready.");
    expect(result.issues).toEqual([]);
  });
  it("does not confuse Summary prose, code, or operator input with an agent summary", () => {
    const result = parseResponse(
      "RESPONSE NUMBER 1 | actor->watcher\nSummary of the task is pending.\n````text\n```bash\nSummary: fake\n```\n````\n__________\nSummary: operator text",
    );
    expect(result.summary).toBeUndefined();
    expect(result.batches).toEqual([]);
    expect(result.issues).toContain("Missing agent-authored Summary section.");
  });
  it("keeps a single copyable Bash batch in Summary without counting its code as prose lines", () => {
    const result = parseResponse(
      "RESPONSE NUMBER 1 | actor->watcher\nSummary: Inspect the project.\n~~~bash\nclear\npwd && ls\ngit status --short\nnode --version\n~~~",
    );
    expect(result.summary).toBe("Inspect the project.");
    expect(result.batches).toEqual([
      "clear\npwd && ls\ngit status --short\nnode --version",
    ]);
    expect(result.issues).toEqual([]);
  });
  it("separates direct operator text without treating its questions, approval, or code as agent metadata", () => {
    const result = parseResponse(
      "RESPONSE NUMBER 1 | watcher->actor\nSummary\nBriefing.\n__________\nq1: User question\nAPPROVED\n```bash\nclear\npwd\n```",
    );
    expect(result.summary).toBe("Briefing.");
    expect(result.approval).toBe(false);
    expect(result.batches).toEqual([]);
    expect(result.questions).toEqual([]);
    expect(result.operatorInput).toContain("q1: User question");
  });
  it("recognizes bold Summary headings with an internal colon and avoids duplicate operator separators after blank lines", () => {
    expect(
      parseResponse(
        "RESPONSE NUMBER 1 | watcher->operator\n**Summary:**\nReady.",
      ).summary,
    ).toBe("Ready.");
    expect(operatorPayload("\n__________\ntext")).toBe("\n__________\ntext");
  });
  it("keeps independent supplied response numbers and extracts the summary and ordered questions", () => {
    const result = parseResponse(
      "RESPONSE NUMBER 17 | watcher->operator\nq1: Framework?\nq2: Platform?\nq11: Other?\n## Summary\nNeed three answers.",
    );
    expect(result.number).toBe(17);
    expect(result.recipient).toBe("operator");
    expect(result.questions.map((q) => q.id)).toEqual(["q1", "q2", "q11"]);
    expect(result.summary).toBe("Need three answers.");
    expect(result.issues).toEqual([]);
  });
  it("ignores quoted examples inside fences", () => {
    const result = parseResponse(
      "RESPONSE NUMBER 1 | actor->watcher\n```text\nq2: Fake?\nSummary\nFake\n```\nSummary\nReal",
    );
    expect(result.questions).toEqual([]);
    expect(result.summary).toBe("Real");
  });
  it("parses exact Bash text and explicit approval", () => {
    const result = parseResponse(
      "RESPONSE NUMBER 2 | watcher->actor\nAPPROVED\n```bash\nclear\npwd\n```\nSummary\nReviewed.",
    );
    expect(result.approval).toBe(true);
    expect(result.batches).toEqual(["clear\npwd"]);
  });
  it("does not infer approval from vague prose or a code example", () => {
    expect(
      parseResponse(
        "RESPONSE NUMBER 1 | watcher->actor\nLooks fine.\n```text\nAPPROVED\n```\nSummary\nDiscuss",
      ).approval,
    ).toBe(false);
  });
  it("falls back when there is no protocol or summary", () => {
    const r = parseResponse("plain response");
    expect(r.recipient).toBe("unknown");
    expect(r.summary).toBeUndefined();
    expect(r.issues.length).toBeGreaterThan(0);
  });
  it("rejects ambiguous question IDs and incomplete batches", () => {
    expect(
      parseResponse(
        "RESPONSE NUMBER 1 | watcher->operator\nq1: A\nQ1: B\nSummary\nNeed answers",
      ).questions,
    ).toEqual([]);
    expect(
      parseResponse("RESPONSE NUMBER 1 | actor->watcher\n```bash\nclear\npwd")
        .batches,
    ).toEqual([]);
  });
  it("validates the Bash and git rules", () => {
    expect(validateBatch("pwd")).toHaveLength(1);
    expect(validateBatch("clear\npwd && ls")).toEqual([]);
    expect(validateBatch("clear\ngit add .")).toHaveLength(1);
    expect(validateBatch("clear\ngit add src/main.ts")).toEqual([]);
  });
  it("prefixes only operator input once, retaining all original input", () => {
    expect(operatorPayload("q1: React")).toBe("__________\nq1: React");
    expect(operatorPayload("____\nhello")).toBe("____\nhello");
    expect(operatorPayload("hello", "______")).toBe("______\nhello");
  });
  it("formats any number of answers in original order and requires each", () => {
    expect(
      formatAnswers([{ id: "q9" }, { id: "q1" }], {
        q1: "Windows",
        q9: "React",
      }),
    ).toBe("q9: React\n\nq1: Windows");
    expect(() => formatAnswers([{ id: "q1" }], {})).toThrow("Answer every");
  });
});
