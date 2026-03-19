import type { QuestionHandler } from "../executors/types.js";
import type { GitHubIssue } from "../machine/context.js";
import type { TelegramBridge } from "../telegram/bridge.js";
import { checkContext } from "./context-checker.js";
import { askDelegate } from "./ai-delegate.js";
import { escalateToTelegram } from "./telegram.js";
import type { Logger } from "pino";

export class ThreeTierQuestionHandler implements QuestionHandler {
  private bridge: TelegramBridge | null;
  private apiKey: string;
  private logger: Logger;
  private questionCounts = new Map<number, number>();
  private maxQuestionsPerIssue: number;

  constructor(
    bridge: TelegramBridge | null,
    apiKey: string,
    logger: Logger,
    maxQuestionsPerIssue: number,
  ) {
    this.bridge = bridge;
    this.apiKey = apiKey;
    this.logger = logger;
    this.maxQuestionsPerIssue = maxQuestionsPerIssue;
  }

  async handle(
    question: string,
    options: Array<{ label: string; description: string }>,
    issue: GitHubIssue,
  ): Promise<string> {
    // Check question count for this issue
    const count = (this.questionCounts.get(issue.number) ?? 0) + 1;
    this.questionCounts.set(issue.number, count);

    if (count > this.maxQuestionsPerIssue) {
      this.logger.warn(
        { issue: issue.number, count },
        "Max questions per issue exceeded — using first option",
      );
      return options[0]?.label ?? "yes";
    }

    // Tier 1: Context check
    const contextAnswer = checkContext(question, options, issue);
    if (contextAnswer) {
      this.logger.info(
        { issue: issue.number, tier: 1, answer: contextAnswer },
        "Question answered from context",
      );
      return contextAnswer;
    }

    // Tier 2: AI delegate
    const delegateAnswer = await askDelegate(question, options, issue, this.apiKey);
    if (delegateAnswer) {
      this.logger.info(
        { issue: issue.number, tier: 2, answer: delegateAnswer },
        "Question answered by AI delegate",
      );
      return delegateAnswer;
    }

    // Tier 3: Telegram escalation
    if (this.bridge) {
      this.logger.info(
        { issue: issue.number, tier: 3 },
        "Escalating question to Telegram",
      );
      const telegramAnswer = await escalateToTelegram(question, options, issue, this.bridge);
      if (telegramAnswer !== "__TIMEOUT__") {
        this.logger.info(
          { issue: issue.number, tier: 3, answer: telegramAnswer },
          "Question answered via Telegram",
        );
        return telegramAnswer;
      }
      this.logger.warn(
        { issue: issue.number },
        "Telegram escalation timed out — using first option",
      );
    }

    // Fallback: use the first option
    return options[0]?.label ?? "yes";
  }

  resetForIssue(issueNumber: number): void {
    this.questionCounts.delete(issueNumber);
  }
}
