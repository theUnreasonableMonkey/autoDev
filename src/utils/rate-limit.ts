export interface RateLimitInfo {
  source: "claude" | "codex" | "github" | "telegram";
  retryAfterMs: number;
  message: string;
}

const RATE_LIMIT_PATTERNS = [
  { pattern: /rate.?limit/i, source: "claude" as const },
  { pattern: /usage.?limit/i, source: "claude" as const },
  { pattern: /429/i, source: "claude" as const },
  { pattern: /too many requests/i, source: "claude" as const },
  { pattern: /try again in/i, source: "claude" as const },
];

/**
 * Detect rate limit from an error message.
 * Returns rate limit info if detected, null otherwise.
 */
export function detectRateLimit(error: unknown): RateLimitInfo | null {
  const message = error instanceof Error ? error.message : String(error);

  for (const { pattern, source } of RATE_LIMIT_PATTERNS) {
    if (pattern.test(message)) {
      const retryAfterMs = parseRetryAfter(message);
      return { source, retryAfterMs, message };
    }
  }

  return null;
}

/**
 * Parse "retry after" duration from an error message.
 * Returns milliseconds to wait, or a default of 60 seconds.
 */
function parseRetryAfter(message: string): number {
  // Try to find "retry after X seconds" or "try again in X minutes"
  const secondsMatch = message.match(/(\d+)\s*second/i);
  if (secondsMatch?.[1]) {
    return parseInt(secondsMatch[1], 10) * 1000;
  }

  const minutesMatch = message.match(/(\d+)\s*minute/i);
  if (minutesMatch?.[1]) {
    return parseInt(minutesMatch[1], 10) * 60_000;
  }

  const hoursMatch = message.match(/(\d+)\s*hour/i);
  if (hoursMatch?.[1]) {
    return parseInt(hoursMatch[1], 10) * 3_600_000;
  }

  // Default: 60 seconds
  return 60_000;
}

/**
 * Calculate exponential backoff with jitter.
 */
export function calculateBackoff(retryCount: number): number {
  const base = 30_000; // 30 seconds
  const maxBackoff = 300_000; // 5 minutes
  const backoff = Math.min(base * Math.pow(2, retryCount), maxBackoff);
  const jitter = Math.random() * 5_000;
  return backoff + jitter;
}
