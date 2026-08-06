import { describe, expect, it } from "vitest";
import {
  REVIEW_WORKER_INSTRUCTIONS,
  assertCanStartReview,
  buildIsolatedReviewPrompt,
  reviewAgentConfiguration,
} from "./review-agent";

describe("review worker isolation", () => {
  it("withholds the review skill and tells plugin-owned workers to review directly", () => {
    expect(reviewAgentConfiguration("review", "review")).toEqual({
      tools: [],
      skills: [],
      instructions: REVIEW_WORKER_INSTRUCTIONS,
    });
  });

  it("keeps the review skill available in ordinary threads", () => {
    expect(reviewAgentConfiguration("review", null)).toEqual({
      tools: [],
      skills: ["review"],
    });
  });

  it("rejects attempts to start a review from an isolated review worker", () => {
    expect(() => assertCanStartReview("review", "review")).toThrow(
      "already an isolated review worker",
    );
    expect(() => assertCanStartReview("review", null)).not.toThrow();
  });

  it("puts the no-recursion instruction in the isolated review prompt", () => {
    expect(buildIsolatedReviewPrompt("Review these changes.")).toBe(
      `Review these changes.\n\n---\n\n${REVIEW_WORKER_INSTRUCTIONS}`,
    );
  });
});
