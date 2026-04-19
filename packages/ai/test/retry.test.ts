import { describe, it, expect } from "vitest";
import { withRetry, isRetryable } from "../src/utils/retry.js";

describe("isRetryable", () => {
  it("returns true for retryable status codes", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(502)).toBe(true);
    expect(isRetryable(503)).toBe(true);
  });

  it("returns false for non-retryable status codes", () => {
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(401)).toBe(false);
    expect(isRetryable(403)).toBe(false);
    expect(isRetryable(404)).toBe(false);
    expect(isRetryable(200)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "success";
    });

    expect(result).toBe("success");
    expect(calls).toBe(1);
  });

  it("retries on retryable errors", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("Rate limited") as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return "success";
      },
      { maxRetries: 3, baseDelayMs: 10 },
    );

    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("throws immediately on non-retryable errors", async () => {
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls++;
          const err = new Error("Unauthorized") as Error & { status: number };
          err.status = 401;
          throw err;
        },
        { maxRetries: 3, baseDelayMs: 10 },
      ),
    ).rejects.toThrow("Unauthorized");

    expect(calls).toBe(1);
  });

  it("throws after max retries exceeded", async () => {
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls++;
          const err = new Error("Server error") as Error & { status: number };
          err.status = 500;
          throw err;
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow("Server error");

    expect(calls).toBe(3);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(async () => "success", {}, controller.signal),
    ).rejects.toThrow("Aborted");
  });
});
