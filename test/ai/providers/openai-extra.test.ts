import { OpenAI } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type OpenAiClientFactory,
  OpenAiProvider,
} from "../../../src/ai/providers/openai.js";
import { structuredRequest } from "../../helpers/fakes.js";

vi.mock("openai", () => {
  const OpenAI = vi.fn(function () {
    return {
      responses: {
        parse: vi.fn().mockResolvedValue({
          incomplete_details: undefined,
          output: [],
          output_parsed: { answer: "resolved" },
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      },
    };
  });
  return { OpenAI };
});

const MockOpenAI = vi.mocked(OpenAI);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultOpenAiClientFactory (via OpenAI SDK mock)", () => {
  it("constructs OpenAI with apiKey, maxRetries, and timeout", () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-openai-key",
      model: "gpt-test",
    });
    void provider.generate(structuredRequest());

    expect(MockOpenAI).toHaveBeenCalledOnce();
    expect(MockOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-openai-key",
      maxRetries: 0,
      timeout: 15_000,
    });
  });

  it("returns structured output from the real default factory path", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-openai-key",
      model: "gpt-test",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
  });

  it("maps incomplete_details reason into the failure message", async () => {
    const sdkInstance = {
      responses: {
        parse: vi.fn().mockResolvedValue({
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          output_parsed: undefined,
          status: "incomplete",
          usage: { input_tokens: 8, output_tokens: 2 },
        }),
      },
    };
    MockOpenAI.mockImplementationOnce(function () {
      return sdkInstance as never;
    });

    const provider = new OpenAiProvider({
      apiKey: "sk-key",
      model: "gpt-test",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ category: "incomplete", ok: false });
    const message = result.ok ? "" : result.message;
    expect(message).toContain("max_output_tokens");
  });

  it("normalizes output with undefined usage to no usage property", async () => {
    const sdkInstance = {
      responses: {
        parse: vi.fn().mockResolvedValue({
          incomplete_details: undefined,
          output: [],
          output_parsed: { answer: "resolved" },
          status: "completed",
          usage: undefined,
        }),
      },
    };
    MockOpenAI.mockImplementationOnce(function () {
      return sdkInstance as never;
    });

    const provider = new OpenAiProvider({
      apiKey: "sk-key",
      model: "gpt-test",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("usage");
  });

  it("normalizes refusal content items from output array", async () => {
    const sdkInstance = {
      responses: {
        parse: vi.fn().mockResolvedValue({
          incomplete_details: undefined,
          output: [
            {
              content: [{ refusal: "Policy violation.", type: "refusal" }],
              type: "message",
            },
          ],
          output_parsed: undefined,
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      },
    };
    MockOpenAI.mockImplementationOnce(function () {
      return sdkInstance as never;
    });

    const provider = new OpenAiProvider({
      apiKey: "sk-key",
      model: "gpt-test",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ category: "refusal", ok: false });
  });

  it("passes non-message output items through as type-only objects", async () => {
    const sdkInstance = {
      responses: {
        parse: vi.fn().mockResolvedValue({
          incomplete_details: undefined,
          output: [{ type: "function_call" }],
          output_parsed: { answer: "resolved" },
          status: "completed",
          usage: { input_tokens: 6, output_tokens: 2 },
        }),
      },
    };
    MockOpenAI.mockImplementationOnce(function () {
      return sdkInstance as never;
    });

    const provider = new OpenAiProvider({
      apiKey: "sk-key",
      model: "gpt-test",
    });
    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ ok: true });
  });
});

describe("OpenAiProvider — additional branches", () => {
  it("normalizes status=failed as provider-error", async () => {
    const provider = new OpenAiProvider(
      { apiKey: "sk-secret", model: "gpt-test" },
      (): ReturnType<OpenAiClientFactory> => ({
        responses: {
          parse: async () => ({
            output: [],
            output_parsed: undefined,
            status: "failed",
            usage: { input_tokens: 3, output_tokens: 0 },
          }),
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "provider-error", ok: false },
    );
  });

  it("normalizes output_parsed=undefined on completed status as invalid-output", async () => {
    const provider = new OpenAiProvider(
      { apiKey: "sk-secret", model: "gpt-test" },
      (): ReturnType<OpenAiClientFactory> => ({
        responses: {
          parse: async () => ({
            output: [],
            output_parsed: undefined,
            status: "completed",
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "invalid-output", ok: false },
    );
  });

  it("normalizes thrown errors and redacts apiKey from message", async () => {
    const error = new Error("Connection failed: sk-secret in header.");
    const provider = new OpenAiProvider(
      { apiKey: "sk-secret", model: "gpt-test" },
      (): ReturnType<OpenAiClientFactory> => ({
        responses: {
          async parse() {
            throw error;
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
    const provider = new OpenAiProvider(
      { apiKey: "sk-secret", model: "gpt-test" },
      (): ReturnType<OpenAiClientFactory> => ({
        responses: {
          async parse() {
            throw timeoutError;
          },
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "timeout", ok: false },
    );
  });

  it("normalizes incomplete response with no incomplete_details reason", async () => {
    const provider = new OpenAiProvider(
      { apiKey: "sk-secret", model: "gpt-test" },
      (): ReturnType<OpenAiClientFactory> => ({
        responses: {
          parse: async () => ({
            output: [],
            output_parsed: undefined,
            status: "incomplete",
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
        },
      }),
    );

    const result = await provider.generate(structuredRequest());
    expect(result).toMatchObject({ category: "incomplete", ok: false });
    const message = result.ok ? "" : result.message;
    expect(message).not.toContain("undefined");
  });
});
