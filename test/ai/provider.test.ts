// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import { createModelProvider } from "../../src/ai/provider.js";
import { AnthropicProvider } from "../../src/ai/providers/anthropic.js";
import { OpenAiCompatibleProvider } from "../../src/ai/providers/openai-compatible.js";
import { OpenAiProvider } from "../../src/ai/providers/openai.js";
import type { EnabledAiConfig } from "../../src/config.js";

const config = (provider: EnabledAiConfig["provider"]): EnabledAiConfig => ({
  apiKey: "secret",
  enabled: true,
  forbiddenPatterns: [],
  immutablePatterns: ["**/migrations/**"],
  label: "AI backport",
  maxConflictedFiles: 3,
  maxResolutionLines: 60,
  model: "small-model",
  provider,
  timeoutMs: 120_000,
  validationCommands: ["yarn test"],
  ...(provider === "openai-compatible"
    ? { baseUrl: "https://models.example.test/v1" }
    : {}),
});

describe("createModelProvider", () => {
  it("creates an Anthropic adapter", () => {
    expect(createModelProvider(config("anthropic"))).toBeInstanceOf(
      AnthropicProvider,
    );
  });

  it("creates an OpenAI adapter", () => {
    expect(createModelProvider(config("openai"))).toBeInstanceOf(
      OpenAiProvider,
    );
  });

  it("creates an OpenAI-compatible adapter", () => {
    expect(createModelProvider(config("openai-compatible"))).toBeInstanceOf(
      OpenAiCompatibleProvider,
    );
  });
});
