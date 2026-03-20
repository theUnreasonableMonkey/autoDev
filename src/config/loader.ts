import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type AutoDevConfig } from "./schema.js";
import dotenv from "dotenv";

export interface LoadedConfig {
  config: AutoDevConfig;
  repoDir: string; // Absolute path to the directory containing the config file (i.e. the target repo)
}

export interface AppSecrets {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  telegramBotToken?: string;
}

export function loadSecrets(): AppSecrets {
  dotenv.config();

  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicApiKey) {
    console.log("No ANTHROPIC_API_KEY set — using Claude CLI OAuth (Max Pro subscription)");
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

export function configExists(configPath: string): boolean {
  return existsSync(resolve(configPath));
}

export function loadConfig(configPath: string): LoadedConfig {
  const resolvedPath = resolve(configPath);

  const repoDir = dirname(resolvedPath);
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

  return { config: result.data, repoDir };
}
