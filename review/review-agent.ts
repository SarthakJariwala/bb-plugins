export const REVIEW_WORKER_INSTRUCTIONS =
  "You are the isolated code reviewer started by the Review plugin. Perform the requested code review directly in this thread. Do not use the review skill, run `bb review`, or start another review thread.";

export function isReviewWorker(
  pluginId: string,
  originPluginId: string | null | undefined,
): boolean {
  return originPluginId === pluginId;
}

export function reviewAgentConfiguration(
  pluginId: string,
  originPluginId: string | null | undefined,
): { tools: string[]; skills: string[]; instructions?: string } {
  if (isReviewWorker(pluginId, originPluginId)) {
    return {
      tools: [],
      skills: [],
      instructions: REVIEW_WORKER_INSTRUCTIONS,
    };
  }

  return { tools: [], skills: ["review"] };
}

export function assertCanStartReview(
  pluginId: string,
  originPluginId: string | null | undefined,
): void {
  if (isReviewWorker(pluginId, originPluginId)) {
    throw new Error(
      "This thread is already an isolated review worker. Complete the review directly instead of starting another review thread.",
    );
  }
}

export function buildIsolatedReviewPrompt(reviewPrompt: string): string {
  return `${reviewPrompt}\n\n---\n\n${REVIEW_WORKER_INSTRUCTIONS}`;
}
