import { describe, it, expect } from "vitest";

describe("pr", () => {
  it("module exports createPullRequest", async () => {
    const mod = await import("./pr.js");
    expect(typeof mod.createPullRequest).toBe("function");
  });
});
