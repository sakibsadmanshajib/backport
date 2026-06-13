// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  type InputReader,
  getSafeAiConfigSummary,
  readAiConfig,
} from "../src/config.js";

const inputReader = (
  inputs: Readonly<{ [name: string]: string }>,
): InputReader => ({
  get: (name) => inputs[name] ?? "",
});

const enabledInputs = {
  ai_api_key: "secret-key",
  ai_enabled: "true",
  ai_model: "cheap-model",
  ai_provider: "anthropic",
  ai_validation_commands: '["yarn test"]',
} as const;

describe("readAiConfig", () => {
  it("keeps AI disabled by default", () => {
    expect(readAiConfig(inputReader({}))).toEqual({ enabled: false });
  });

  it.each(["anthropic", "openai", "openai-compatible"] as const)(
    "accepts the %s provider",
    (provider) => {
      const config = readAiConfig(
        inputReader({
          ...enabledInputs,
          ai_base_url:
            provider === "openai-compatible"
              ? "https://models.example.test/v1"
              : "",
          ai_provider: provider,
        }),
      );

      expect(config).toMatchObject({ enabled: true, provider });
    },
  );

  it.each(["ai_model", "ai_api_key", "ai_validation_commands"] as const)(
    "requires %s when AI is enabled",
    (name) => {
      expect(() =>
        readAiConfig(inputReader({ ...enabledInputs, [name]: "" })),
      ).toThrow(name);
    },
  );

  it("requires a base URL for an OpenAI-compatible provider", () => {
    expect(() =>
      readAiConfig(
        inputReader({
          ...enabledInputs,
          ai_provider: "openai-compatible",
        }),
      ),
    ).toThrow("ai_base_url");
  });

  it("rejects an unsupported provider", () => {
    expect(() =>
      readAiConfig(
        inputReader({ ...enabledInputs, ai_provider: "unsupported" }),
      ),
    ).toThrow("ai_provider");
  });

  it("rejects malformed JSON arrays", () => {
    expect(() =>
      readAiConfig(
        inputReader({ ...enabledInputs, ai_validation_commands: "not-json" }),
      ),
    ).toThrow("ai_validation_commands");
  });

  it.each([
    ["ai_max_conflicted_files", "0"],
    ["ai_max_resolution_lines", "-1"],
    ["ai_timeout_seconds", "0"],
  ] as const)("rejects an invalid %s limit", (name, value) => {
    expect(() =>
      readAiConfig(inputReader({ ...enabledInputs, [name]: value })),
    ).toThrow(name);
  });

  it("uses conservative defaults", () => {
    expect(readAiConfig(inputReader(enabledInputs))).toMatchObject({
      enabled: true,
      forbiddenPatterns: [],
      immutablePatterns: ["**/migrations/**", "**/migration/**"],
      label: "AI backport",
      maxConflictedFiles: 3,
      maxResolutionLines: 60,
      timeoutMs: 120_000,
    });
  });

  it("parses repository-specific path patterns", () => {
    expect(
      readAiConfig(
        inputReader({
          ...enabledInputs,
          ai_forbidden_patterns: '["**/authorization/**"]',
          ai_immutable_patterns: '["data/migrations/**"]',
        }),
      ),
    ).toMatchObject({
      forbiddenPatterns: ["**/authorization/**"],
      immutablePatterns: ["data/migrations/**"],
    });
  });

  it("omits the API key from safe summaries", () => {
    const config = readAiConfig(inputReader(enabledInputs));

    expect(getSafeAiConfigSummary(config)).toEqual({
      enabled: true,
      model: "cheap-model",
      provider: "anthropic",
    });
    expect(JSON.stringify(getSafeAiConfigSummary(config))).not.toContain(
      "secret-key",
    );
  });
});
