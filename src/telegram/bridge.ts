import { Bot, InlineKeyboard } from "grammy";
import { randomUUID } from "node:crypto";

interface PendingQuestion {
  resolve: (answer: string) => void;
  timeoutId: NodeJS.Timeout;
  reminderId?: NodeJS.Timeout;
}

export class TelegramBridge {
  private bot: Bot;
  private chatId: string;
  private pending = new Map<string, PendingQuestion>();
  private timeoutMinutes: number;
  private reminderMinutes: number;

  constructor(
    bot: Bot,
    chatId: string,
    timeoutMinutes: number,
    reminderMinutes: number,
  ) {
    this.bot = bot;
    this.chatId = chatId;
    this.timeoutMinutes = timeoutMinutes;
    this.reminderMinutes = reminderMinutes;

    // Listen for callback queries
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      // Format: questionId:answerIndex
      const [questionId, answer] = data.split(":", 2);
      if (!questionId || !answer) {
        await ctx.answerCallbackQuery({ text: "Invalid response." });
        return;
      }

      const pending = this.pending.get(questionId);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: "Question expired or already answered." });
        return;
      }

      // Clean up timers
      clearTimeout(pending.timeoutId);
      if (pending.reminderId) clearInterval(pending.reminderId);
      this.pending.delete(questionId);

      // Acknowledge and resolve
      await ctx.answerCallbackQuery({ text: "Got it!" });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      pending.resolve(answer);
    });
  }

  async askQuestion(
    question: string,
    options: Array<{ label: string; description: string }>,
  ): Promise<string> {
    const questionId = randomUUID().slice(0, 8);

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      keyboard.text(opt.label, `${questionId}:${opt.label}`);
      if (i < options.length - 1) keyboard.row();
    }

    const messageText = `🤖 *AutoDev needs your input:*\n\n${question}\n\n${options.map((o, i) => `${i + 1}. *${o.label}* — ${o.description}`).join("\n")}`;

    await this.bot.api.sendMessage(this.chatId, messageText, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    return new Promise<string>((resolve) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pending.get(questionId);
        if (pending?.reminderId) clearInterval(pending.reminderId);
        this.pending.delete(questionId);
        this.bot.api
          .sendMessage(this.chatId, "⏰ Question timed out. Skipping...")
          .catch(() => {});
        resolve("__TIMEOUT__");
      }, this.timeoutMinutes * 60_000);

      // Set up reminder
      let reminderId: NodeJS.Timeout | undefined;
      if (this.reminderMinutes > 0 && this.reminderMinutes < this.timeoutMinutes) {
        reminderId = setInterval(() => {
          this.bot.api
            .sendMessage(this.chatId, `⏳ Reminder: AutoDev is waiting for your answer.`)
            .catch(() => {});
        }, this.reminderMinutes * 60_000);
      }

      this.pending.set(questionId, { resolve, timeoutId, reminderId });
    });
  }

  async notify(message: string): Promise<void> {
    await this.bot.api.sendMessage(this.chatId, message, { parse_mode: "Markdown" });
  }

  cleanup(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      if (pending.reminderId) clearInterval(pending.reminderId);
    }
    this.pending.clear();
  }
}
