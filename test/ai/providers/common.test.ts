// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  normalizeProviderError,
  sanitizeProviderError,
} from "../../../src/ai/providers/common.js";

describe("sanitizeProviderError", () => {
  it("redacts a single secret", () => {
    const error = new Error("call failed for key sk-live-123");

    expect(sanitizeProviderError(error, "sk-live-123")).toBe(
      "call failed for key [REDACTED]",
    );
  });

  it("redacts every secret in a list", () => {
    const error = new Error('aws AKIA-secret and json {"private":1} leaked');

    expect(sanitizeProviderError(error, ["AKIA-secret", '{"private":1}'])).toBe(
      "aws [REDACTED] and json [REDACTED] leaked",
    );
  });

  it("ignores empty secrets instead of corrupting the message", () => {
    const error = new Error("plain message");

    expect(sanitizeProviderError(error, ["", "missing"])).toBe("plain message");
  });

  it("truncates to 500 characters", () => {
    const error = new Error("x".repeat(900));

    expect(sanitizeProviderError(error, "unused").length).toBe(500);
  });
});

describe("normalizeProviderError", () => {
  it("classifies timeouts and redacts a list of secrets", () => {
    const error = new Error("request with secret-aws timed out");
    error.name = "APIConnectionTimeoutError";

    const result = normalizeProviderError(error, ["secret-aws"]);

    expect(result).toMatchObject({ category: "timeout", ok: false });
    expect(result.ok ? "" : result.message).not.toContain("secret-aws");
  });
});
