import pino from "pino";
import { mkdirSync } from "node:fs";
import type { AutoDevConfig } from "../config/schema.js";

export function createLogger(config: AutoDevConfig, runId: string): pino.Logger {
  mkdirSync(config.logging.dir, { recursive: true });

  return pino({
    level: config.logging.level,
    transport: {
      targets: [
        {
          target: "pino/file",
          options: {
            destination: `${config.logging.dir}/run-${runId}.log`,
            mkdir: true,
          },
          level: config.logging.level,
        },
        {
          target: "pino-pretty",
          options: { colorize: true },
          level: config.logging.level,
        },
      ],
    },
  });
}

export function createSimpleLogger(): pino.Logger {
  return pino({
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  });
}
