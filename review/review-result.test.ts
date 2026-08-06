import { describe, expect, it } from "vitest";
import { REVIEW_RUBRIC, buildReviewPrompt } from "./prompts";
import { hasBlockingReviewFindings } from "./review-result";

describe("hasBlockingReviewFindings", () => {
  it("treats P0-P2 findings as blocking", () => {
    expect(hasBlockingReviewFindings("## Findings\n- [P2] Fix race — `src/a.ts:4`\n\n## Verdict\nneeds attention")).toBe(true);
  });

  it("treats P3-only findings as non-blocking", () => {
    expect(hasBlockingReviewFindings("## Findings\n- [P3] Rename helper — `src/a.ts:4`\n\n## Verdict\ncorrect")).toBe(false);
  });

  it("falls back to a needs-attention verdict", () => {
    expect(hasBlockingReviewFindings("## Verdict\nneeds attention")).toBe(true);
  });

  it("does not mistake the rubric priority legend for findings", () => {
    expect(hasBlockingReviewFindings("- [P0] - Drop everything to fix.\n- [P1] - Urgent.\n\nVerdict: correct")).toBe(false);
  });

  it("ignores priority tags in code fences", () => {
    expect(hasBlockingReviewFindings("## Findings\n```md\n- [P1] example\n```\n\nVerdict: correct")).toBe(false);
  });
});

describe("review prompts", () => {
  it("uses the Pi review rubric verbatim", () => {
    expect(REVIEW_RUBRIC).toContain("You are acting as a code reviewer for a proposed code change made by another engineer.");
    expect(REVIEW_RUBRIC).toContain("Ensure that errors are always checked against codes or stable identifiers, never error messages.");
    expect(REVIEW_RUBRIC).toContain("Don't stop at the first finding - list every qualifying issue.");
  });

  it("uses the Pi uncommitted mode wording", () => {
    expect(buildReviewPrompt({ type: "uncommitted" })).toContain(
      "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.",
    );
  });

  it("adds Pi local-change instructions during base-branch loop passes", () => {
    const prompt = buildReviewPrompt(
      { type: "baseBranch", branch: "main" },
      { includeLocalChanges: true },
    );
    expect(prompt).toContain("Use `git status --porcelain`, `git diff`, `git diff --staged`, and `git ls-files --others --exclude-standard`");
  });
});
