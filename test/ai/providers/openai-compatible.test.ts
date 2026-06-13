import { describe, expect, it } from "vitest";
import {
  type OpenAiCompatibleClient,
  type OpenAiCompatibleClientOptions,
  OpenAiCompatibleProvider,
} from "../../../src/ai/providers/openai-compatible.js";
import { structuredRequest } from "../../helpers/fakes.js";

const successResponse = {
  choices: [
    {
      finish_reason: "stop",
      message: { parsed: { answer: "resolved" } },
    },
  ],
  usage: { completion_tokens: 4, prompt_tokens: 12 },
} as const;

describe("OpenAiCompatibleProvider", () => {
  it("maps strict Chat Completions and configures the base URL", async () => {
    let clientOptions: OpenAiCompatibleClientOptions | undefined;
    let parseParameters: unknown;
    let requestOptions: unknown;
    const client: OpenAiCompatibleClient = {
      chat: {
        completions: {
          async parse(parameters, options) {
            parseParameters = parameters;
            requestOptions = options;
            return successResponse;
          },
        },
      },
    };
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compatible-secret",
        baseUrl: "https://models.example.test/v1",
        model: "small-compatible-model",
      },
      (options) => {
        clientOptions = options;
        return client;
      },
    );

    await expect(provider.generate(structuredRequest())).resolves.toEqual({
      data: { answer: "resolved" },
      ok: true,
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(clientOptions).toEqual({
      apiKey: "compatible-secret",
      baseURL: "https://models.example.test/v1",
      maxRetries: 0,
      timeout: 15_000,
    });
    expect(parseParameters).toMatchObject({
      max_completion_tokens: 512,
      messages: [
        { content: "Return a safe structured answer.", role: "system" },
        { content: "Resolve the conflict.", role: "user" },
      ],
      model: "small-compatible-model",
    });
    expect(requestOptions).toEqual({ timeout: 15_000 });
  });

  it.each([
    ["length", "incomplete"],
    ["content_filter", "refusal"],
  ] as const)("normalizes %s as %s", async (finishReason, category) => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "secret",
        baseUrl: "https://example.test/v1",
        model: "model",
      },
      () => ({
        chat: {
          completions: {
            parse: async () => ({
              ...successResponse,
              choices: [
                {
                  finish_reason: finishReason,
                  message: {},
                },
              ],
            }),
          },
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      {
        category,
        ok: false,
      },
    );
  });

  it("normalizes an explicit refusal", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "secret",
        baseUrl: "https://example.test/v1",
        model: "model",
      },
      () => ({
        chat: {
          completions: {
            parse: async () => ({
              ...successResponse,
              choices: [
                {
                  finish_reason: "stop",
                  message: { refusal: "Cannot comply." },
                },
              ],
            }),
          },
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      {
        category: "refusal",
        ok: false,
      },
    );
  });

  it("rejects missing strict parsed output without text fallback", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "secret",
        baseUrl: "https://example.test/v1",
        model: "model",
      },
      () => ({
        chat: {
          completions: {
            parse: async () => ({
              ...successResponse,
              choices: [
                {
                  finish_reason: "stop",
                  message: {},
                },
              ],
            }),
          },
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      {
        category: "invalid-output",
        ok: false,
      },
    );
  });
});
