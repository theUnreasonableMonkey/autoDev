import { describe, it, expect } from "vitest";
import { detectRateLimit, calculateBackoff } from "../src/utils/rate-limit.js";

describe("detectRateLimit", () => {
  it("detects rate limit from error message", () => {
    const result = detectRateLimit(new Error("Rate limit exceeded. Try again in 30 seconds."));
    expect(result).not.toBeNull();
    expect(result!.retryAfterMs).toBe(30_000);
  });

  it("detects usage limit", () => {
    const result = detectRateLimit("Usage limit reached");
    expect(result).not.toBeNull();
  });

  it("detects 429 status", () => {
    const result = detectRateLimit("HTTP 429 Too Many Requests");
    expect(result).not.toBeNull();
  });

  it("returns null for non-rate-limit errors", () => {
    const result = detectRateLimit(new Error("File not found"));
    expect(result).toBeNull();
  });

  it("parses minutes from error message", () => {
    const result = detectRateLimit("Rate limit. Try again in 5 minutes.");
    expect(result).not.toBeNull();
    expect(result!.retryAfterMs).toBe(300_000);
  });
});

describe("calculateBackoff", () => {
  it("starts at 30 seconds", () => {
    const backoff = calculateBackoff(0);
    expect(backoff).toBeGreaterThanOrEqual(30_000);
    expect(backoff).toBeLessThan(40_000); // 30s + up to 5s jitter
  });

  it("doubles with each retry", () => {
    const b0 = calculateBackoff(0);
    const b1 = calculateBackoff(1);
    // b1 base should be ~60s vs b0 base ~30s (plus jitter)
    expect(b1).toBeGreaterThan(b0 * 1.5);
  });

  it("caps at 5 minutes", () => {
    const backoff = calculateBackoff(100);
    expect(backoff).toBeLessThanOrEqual(305_000); // 300s + 5s jitter
  });
});
