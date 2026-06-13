import { OpenAI } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type OpenAiCompatibleClientFactory,
  OpenAiCompatibleProvider,
} from "../../../src/ai/providers/openai-compatible.js";
import { structuredRequest } from "../../helpers/fakes.js";

vi.mock("openai", () => {
  const OpenAI = vi.fn(function () {
    return {
      chat: {
        completions: {
          parse: vi.fn().mockResolvedValue({
            choices: [
              {
                finish_reason: "stop",
                message: { parsed: { answer: "resolved" }, refusal: null },
              },
            ],
            usage: { completion_tokens: 4, prompt_tokens: 12 },
          }),
        },
      },
    };
  });
  return { OpenAI };
});

const MockOpenAI = vi.mocked(OpenAI);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultOpenAiCompatibleClientFactory (via OpenAI SDK mock)", () => {
  it("constructs OpenAI with apiKey, baseURL, maxRetries, and timeout", () => {
    const provider = new OpenAiCompatibleProvider({
      apiKey: "sk-compat-key",
      baseUrl: "https://models.example.test/v1",
      model: "small-model",
    });
    void provider.generate(structuredRequest());

    expect(MockOpenAI).toHaveBeenCalledOnce();
    expect(MockOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-compat-key",
      baseURL: "https://models.example.test/v1",
      maxRetries: 0,
      timeout: 15_000,
    });
  });

  it("returns structured output from the real default factory path", async () => {
    const provider = new OpenAiCompatibleProvider({
      apiKey: "sk-compat-key",
      baseUrl: "https://models.example.test/v1",
      model: "small-model",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
  });

  it("normalizes undefined usage to no usage property", async () => {
    const sdkInstance = {
      chat: {
        completions: {
          parse: vi.fn().mockResolvedValue({
            choices: [
              {
                finish_reason: "stop",
                message: { parsed: { answer: "ok" }, refusal: null },
              },
            ],
            usage: undefined,
          }),
        },
      },
    };
    MockOpenAI.mockImplementationOnce(function () {
      return sdkInstance as never;
    });

    const provider = new OpenAiCompatibleProvider({
      apiKey: "sk-key",
      baseUrl: "https://example.test/v1",
      model: "model",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("usage");
  });

  it("normalizes null finish_reason to undefined in choices", async () => {
    const sdkInstance = {
      chat: {
        completions: {
          parse: vi.fn().mockResolvedValue({
            choices: [
              {
                finish_reason: null,
                message: { parsed: { answer: "ok" }, refusal: null },
              },
            ],
            usage: { completion_tokens: 2, prompt_tokens: 5 },
          }),
        },
      },
    };
    MockOpenAI.mockImplementationOnce(function () {
      return sdkInstance as never;
    });

    const provider = new OpenAiCompatibleProvider({
      apiKey: "sk-key",
      baseUrl: "https://example.test/v1",
      model: "model",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
  });

  it("normalizes null parsed to undefined triggering invalid-output", async () => {
    const sdkInstance = {
      chat: {
        completions: {
          parse: vi.fn().mockResolvedValue({
            choices: [
              {
                finish_reason: "stop",
                message: { parsed: null, refusal: null },
              },
            ],
            usage: { completion_tokens: 1, prompt_tokens: 3 },
          }),
        },
      },
    };
    MockOpenAI.mockImplementationOnce(function () {
      return sdkInstance as never;
    });

    const provider = new OpenAiCompatibleProvider({
      apiKey: "sk-key",
      baseUrl: "https://example.test/v1",
      model: "model",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ category: "invalid-output", ok: false });
  });
});

describe("OpenAiCompatibleProvider — additional branches", () => {
  it("returns invalid-output when choices array is empty", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "sk-secret",
        baseUrl: "https://example.test/v1",
        model: "model",
      },
      (): ReturnType<OpenAiCompatibleClientFactory> => ({
        chat: {
          completions: {
            parse: async () => ({
              choices: [],
              usage: { completion_tokens: 0, prompt_tokens: 5 },
            }),
          },
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "invalid-output", ok: false },
    );
  });

  it("normalizes thrown errors and redacts apiKey from message", async () => {
    const error = new Error("Upstream error: sk-secret was rejected.");
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "sk-secret",
        baseUrl: "https://example.test/v1",
        model: "model",
      },
      (): ReturnType<OpenAiCompatibleClientFactory> => ({
        chat: {
          completions: {
            async parse() {
              throw error;
            },
          },
        },
      }),
    );

    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ category: "provider-error", ok: false });
    const message = result.ok ? "" : result.message;
    expect(message).not.toContain("sk-secret");
    expect(message).toContain("[REDACTED]");
  });

  it("normalizes timeout errors as timeout category", async () => {
    const timeoutError = new Error("Request timed out after 15000ms.");
    timeoutError.name = "APIConnectionTimeoutError";
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "sk-secret",
        baseUrl: "https://example.test/v1",
        model: "model",
      },
      (): ReturnType<OpenAiCompatibleClientFactory> => ({
        chat: {
          completions: {
            async parse() {
              throw timeoutError;
            },
          },
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "timeout", ok: false },
    );
  });

  it("treats empty-string refusal as non-refusal", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "sk-secret",
        baseUrl: "https://example.test/v1",
        model: "model",
      },
      (): ReturnType<OpenAiCompatibleClientFactory> => ({
        chat: {
          completions: {
            parse: async () => ({
              choices: [
                {
                  finish_reason: "stop",
                  message: { parsed: { answer: "ok" }, refusal: "" },
                },
              ],
              usage: { completion_tokens: 2, prompt_tokens: 4 },
            }),
          },
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { ok: true },
    );
  });
});
