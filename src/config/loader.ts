import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type AutoDevConfig } from "./schema.js";
import dotenv from "dotenv";

export interface AppSecrets {
  anthropicApiKey: string;
  openaiApiKey?: string;
  telegramBotToken?: string;
}

export function loadSecrets(): AppSecrets {
  dotenv.config();

  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const telegramBotToken = process.env["TELEGRAM_BOT_TOKEN"];
  if (!telegramBotToken) {
    console.warn("Warning: TELEGRAM_BOT_TOKEN not set — Telegram escalation disabled");
  }

  return {
    anthropicApiKey,
    openaiApiKey: process.env["OPENAI_API_KEY"],
    telegramBotToken,
  };
}

export function loadConfig(configPath: string): AutoDevConfig {
  const resolvedPath = resolve(configPath);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found: ${resolvedPath}\n` +
        `Create one from the example: cp autodev.config.yaml your-config.yaml`,
    );
  }

  const raw = readFileSync(resolvedPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML config: ${message}`);
  }

  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }

  return result.data;
}
