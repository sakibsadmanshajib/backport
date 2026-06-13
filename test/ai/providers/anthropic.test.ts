// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  type AnthropicClient,
  AnthropicFamilyProvider,
  type AnthropicRequestOptions,
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

const familyProvider = (
  client: AnthropicClient,
  capture?: (options: AnthropicRequestOptions) => void,
  secrets: readonly string[] = ["anthropic-secret"],
): AnthropicFamilyProvider =>
  new AnthropicFamilyProvider({
    clientFactory(options) {
      capture?.(options);
      return client;
    },
    model: "claude-haiku-test",
    secrets,
  });

describe("AnthropicFamilyProvider", () => {
  it("maps a structured request and normalizes usage", async () => {
    let requestOptions: AnthropicRequestOptions | undefined;
    let parseParameters: unknown;
    let parseOptions: unknown;
    const client: AnthropicClient = {
      messages: {
        async parse(parameters, options) {
          parseParameters = parameters;
          parseOptions = options;
          return successResponse;
        },
      },
    };

    await expect(
      familyProvider(client, (options) => {
        requestOptions = options;
      }).generate(structuredRequest()),
    ).resolves.toEqual({
      data: { answer: "resolved" },
      ok: true,
      usage: { inputTokens: 15, outputTokens: 5 },
    });
    expect(requestOptions).toEqual({ maxRetries: 0, timeout: 15_000 });
    expect(parseParameters).toMatchObject({
      max_tokens: 512,
      messages: [{ content: "Resolve the conflict.", role: "user" }],
      model: "claude-haiku-test",
      system: "Return a safe structured answer.",
    });
    expect(parseOptions).toEqual({ timeout: 15_000 });
  });

  it.each([
    ["refusal", "refusal"],
    ["max_tokens", "incomplete"],
    ["pause_turn", "incomplete"],
  ] as const)("normalizes %s as %s", async (stopReason, category) => {
    const provider = familyProvider({
      messages: {
        parse: async () => ({
          ...successResponse,
          parsed_output: null,
          stop_reason: stopReason,
        }),
      },
    });

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category, ok: false },
    );
  });

  it("independently rejects invalid parsed output", async () => {
    const provider = familyProvider({
      messages: {
        parse: async () => ({
          ...successResponse,
          parsed_output: { wrong: true },
        }),
      },
    });

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "invalid-output", ok: false },
    );
  });

  it("normalizes timeouts and redacts every carried secret", async () => {
    const timeout = new Error(
      "Request with anthropic-secret and aws-secret timed out.",
    );
    timeout.name = "APIConnectionTimeoutError";
    const provider = familyProvider(
      {
        messages: {
          async parse() {
            throw timeout;
          },
        },
      },
      undefined,
      ["anthropic-secret", "aws-secret"],
    );

    const result = await provider.generate(structuredRequest());

    expect(result).toMatchObject({ category: "timeout", ok: false });
    const message = result.ok ? "" : result.message;
    expect(message).not.toContain("anthropic-secret");
    expect(message).not.toContain("aws-secret");
  });
});
