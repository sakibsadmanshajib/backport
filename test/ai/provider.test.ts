// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import { createModelProvider } from "../../src/ai/provider.js";
import { AnthropicFamilyProvider } from "../../src/ai/providers/anthropic.js";
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
  ...(provider === "openai-compatible" || provider === "anthropic-compatible"
    ? { baseUrl: "https://models.example.test/v1" }
    : {}),
  ...(provider === "anthropic-bedrock" ? { awsRegion: "us-east-1" } : {}),
  ...(provider === "anthropic-vertex"
    ? { gcpProject: "demo-project", gcpRegion: "us-central1" }
    : {}),
});

describe("createModelProvider", () => {
  it("creates an Anthropic adapter", () => {
    expect(createModelProvider(config("anthropic"))).toBeInstanceOf(
      AnthropicFamilyProvider,
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

  it.each([
    "anthropic-bedrock",
    "anthropic-compatible",
    "anthropic-vertex",
  ] as const)("creates the %s family adapter", (provider) => {
    expect(createModelProvider(config(provider))).toBeInstanceOf(
      AnthropicFamilyProvider,
    );
  });

  it("rejects an anthropic-compatible provider without a base URL", () => {
    expect(() =>
      createModelProvider({
        ...config("anthropic-compatible"),
        baseUrl: undefined,
      }),
    ).toThrow("base URL");
  });
});
