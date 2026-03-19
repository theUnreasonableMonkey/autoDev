import type { TelegramBridge } from "../telegram/bridge.js";
import type { GitHubIssue } from "../machine/context.js";

/**
 * Tier 3: Escalate to human via Telegram.
 * Returns the chosen option label, or "__TIMEOUT__" if no response.
 */
export async function escalateToTelegram(
  question: string,
  options: Array<{ label: string; description: string }>,
  _issue: GitHubIssue,
  bridge: TelegramBridge,
): Promise<string> {
  return bridge.askQuestion(question, options);
}
