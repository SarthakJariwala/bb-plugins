export const SHIP_PROMPT_SETTING_KEYS = {
  asPullRequest: "shipAsPrPrompt",
  toMain: "shipToMainPrompt",
} as const;

export const SHIP_AS_PR_PROMPT =
  "Ship all committed and uncommitted changes as a pull request targeting origin/HEAD. Commit any uncommitted changes before pushing the current branch and creating the PR. If push fails because origin/HEAD is ahead, rebase and resolve merge conflicts, checking with me before proceeding if there are any substantive conflicts, then try pushing again. Run the full test suite before pushing. If test failures are unrelated to this change (due to a commit upstream that introduced the failure), they can be ignored. Wait for CI to pass and fix any failures that could have been caused by your changes. When done, archive the current thread.";

export const SHIP_TO_MAIN_PROMPT =
  "Ship all committed and uncommitted changes to origin/HEAD. Commit any uncommitted changes before pushing. If push fails because origin/HEAD is ahead, rebase and resolve merge conflicts, checking with me before proceeding if there are any substantive conflicts, then try pushing again. Run the full test suite before pushing. If test failures are unrelated to this change (due to a commit upstream that introduced the failure), they can be ignored. When done, archive the current thread.";

type ShipSettings = Record<string, string | boolean> | undefined;

export function getShipOptions(settings: ShipSettings) {
  const asPullRequest = settings?.[SHIP_PROMPT_SETTING_KEYS.asPullRequest];
  const toMain = settings?.[SHIP_PROMPT_SETTING_KEYS.toMain];

  return [
    {
      value: "pr",
      label: "Ship as PR",
      prompt: typeof asPullRequest === "string" ? asPullRequest : SHIP_AS_PR_PROMPT,
    },
    {
      value: "main",
      label: "Ship it to main",
      prompt: typeof toMain === "string" ? toMain : SHIP_TO_MAIN_PROMPT,
    },
  ] as const;
}

export const SHIP_OPTIONS = getShipOptions(undefined);
