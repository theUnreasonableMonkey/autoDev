import { Bot } from "grammy";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  // Default error handler
  bot.catch((err) => {
    console.error("Telegram bot error:", err.message);
  });

  return bot;
}

export async function startBot(bot: Bot): Promise<void> {
  // Start long polling in the background
  bot.start({
    onStart: () => {
      console.log("Telegram bot started (long polling).");
    },
  });
}

export function stopBot(bot: Bot): void {
  bot.stop();
}
