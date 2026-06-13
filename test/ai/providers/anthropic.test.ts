// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  type AnthropicClient,
  type AnthropicClientOptions,
  AnthropicProvider,
} from "../../../src/ai/providers/anthropic.js";
import { structuredRequest } from "../../helpers/fakes.js";

const successResponse = {
  parsed_output: { answer: "resolved" },
  stop_details: null,
  stop_reason: "end_turn",
  usage: {
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    input_tokens: 10,
    output_tokens: 5,
  },
} as const;

describe("AnthropicProvider", () => {
  it("maps a structured request and normalizes usage", async () => {
    let clientOptions: AnthropicClientOptions | undefined;
    let parseParameters: unknown;
    let requestOptions: unknown;
    const client: AnthropicClient = {
      messages: {
        async parse(parameters, options) {
          parseParameters = parameters;
          requestOptions = options;
          return successResponse;
        },
      },
    };
    const provider = new AnthropicProvider(
      {
        apiKey: "anthropic-secret",
        model: "claude-haiku-test",
      },
      (options) => {
        clientOptions = options;
        return client;
      },
    );

    await expect(provider.generate(structuredRequest())).resolves.toEqual({
      data: { answer: "resolved" },
      ok: true,
      usage: { inputTokens: 15, outputTokens: 5 },
    });
    expect(clientOptions).toEqual({
      apiKey: "anthropic-secret",
      maxRetries: 0,
      timeout: 15_000,
    });
    expect(parseParameters).toMatchObject({
      max_tokens: 512,
      messages: [{ content: "Resolve the conflict.", role: "user" }],
      model: "claude-haiku-test",
      system: "Return a safe structured answer.",
    });
    expect(requestOptions).toEqual({ timeout: 15_000 });
  });

  it.each([
    ["refusal", "refusal"],
    ["max_tokens", "incomplete"],
    ["pause_turn", "incomplete"],
  ] as const)("normalizes %s as %s", async (stopReason, category) => {
    const provider = new AnthropicProvider(
      { apiKey: "secret", model: "model" },
      () => ({
        messages: {
          parse: async () => ({
            ...successResponse,
            parsed_output: null,
            stop_reason: stopReason,
          }),
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

  it("independently rejects invalid parsed output", async () => {
    const provider = new AnthropicProvider(
      { apiKey: "secret", model: "model" },
      () => ({
        messages: {
          parse: async () => ({
            ...successResponse,
            parsed_output: { wrong: true },
          }),
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

  it("normalizes timeouts and redacts API keys", async () => {
    const timeout = new Error("Request with anthropic-secret timed out.");
    timeout.name = "APIConnectionTimeoutError";
    const provider = new AnthropicProvider(
      { apiKey: "anthropic-secret", model: "model" },
      () => ({
        messages: {
          async parse() {
            throw timeout;
          },
        },
      }),
    );

    const result = await provider.generate(structuredRequest());

    expect(result).toMatchObject({ category: "timeout", ok: false });
    expect(result.ok ? "" : result.message).not.toContain("anthropic-secret");
  });
});
