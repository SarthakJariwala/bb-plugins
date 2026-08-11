import { describe, expect, it } from "vitest";
import { SHIP_AS_PR_PROMPT, SHIP_OPTIONS, SHIP_TO_MAIN_PROMPT } from "./prompts";

describe("ship prompts", () => {
  it("lists the pull-request action first", () => {
    expect(SHIP_OPTIONS.map(({ label }) => label)).toEqual([
      "Ship as PR",
      "Ship it to main",
    ]);
  });

  it("preserves the direct-to-main shipping instructions", () => {
    expect(SHIP_TO_MAIN_PROMPT).toContain("Ship all committed and uncommitted changes to origin/HEAD.");
    expect(SHIP_TO_MAIN_PROMPT).toContain("Run the full test suite before pushing.");
    expect(SHIP_TO_MAIN_PROMPT).toContain("checking with me before proceeding if there are any substantive conflicts");
    expect(SHIP_TO_MAIN_PROMPT).toMatch(/When done, archive the current thread\.$/);
  });

  it("creates a PR and waits for CI", () => {
    expect(SHIP_AS_PR_PROMPT).toContain("as a pull request targeting origin/HEAD");
    expect(SHIP_AS_PR_PROMPT).toContain("before pushing the current branch and creating the PR");
    expect(SHIP_AS_PR_PROMPT).toContain("Wait for CI to pass and fix any failures that could have been caused by your changes.");
    expect(SHIP_AS_PR_PROMPT).toMatch(/When done, archive the current thread\.$/);
  });
});
