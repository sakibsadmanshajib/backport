// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  type OpenAiClient,
  type OpenAiClientOptions,
  OpenAiProvider,
} from "../../../src/ai/providers/openai.js";
import { structuredRequest } from "../../helpers/fakes.js";

const successResponse = {
  output: [],
  output_parsed: { answer: "resolved" },
  status: "completed",
  usage: { input_tokens: 20, output_tokens: 7 },
} as const;

describe("OpenAiProvider", () => {
  it("maps a Responses API request and normalizes usage", async () => {
    let clientOptions: OpenAiClientOptions | undefined;
    let parseParameters: unknown;
    let requestOptions: unknown;
    const client: OpenAiClient = {
      responses: {
        async parse(parameters, options) {
          parseParameters = parameters;
          requestOptions = options;
          return successResponse;
        },
      },
    };
    const provider = new OpenAiProvider(
      { apiKey: "openai-secret", model: "gpt-small-test" },
      (options) => {
        clientOptions = options;
        return client;
      },
    );

    await expect(provider.generate(structuredRequest())).resolves.toEqual({
      data: { answer: "resolved" },
      ok: true,
      usage: { inputTokens: 20, outputTokens: 7 },
    });
    expect(clientOptions).toEqual({
      apiKey: "openai-secret",
      maxRetries: 0,
      timeout: 15_000,
    });
    expect(parseParameters).toMatchObject({
      input: [{ content: "Resolve the conflict.", role: "user" }],
      instructions: "Return a safe structured answer.",
      max_output_tokens: 512,
      model: "gpt-small-test",
    });
    expect(requestOptions).toEqual({ timeout: 15_000 });
  });

  it("normalizes incomplete responses", async () => {
    const provider = new OpenAiProvider(
      { apiKey: "secret", model: "model" },
      () => ({
        responses: {
          parse: async () => ({
            ...successResponse,
            incomplete_details: { reason: "max_output_tokens" },
            output_parsed: undefined,
            status: "incomplete",
          }),
        },
      }),
    );

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      {
        category: "incomplete",
        ok: false,
      },
    );
  });

  it("normalizes refusals", async () => {
    const provider = new OpenAiProvider(
      { apiKey: "secret", model: "model" },
      () => ({
        responses: {
          parse: async () => ({
            ...successResponse,
            output: [
              {
                content: [{ refusal: "Cannot comply.", type: "refusal" }],
                type: "message",
              },
            ],
            output_parsed: undefined,
          }),
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

  it("independently rejects invalid parsed output", async () => {
    const provider = new OpenAiProvider(
      { apiKey: "secret", model: "model" },
      () => ({
        responses: {
          parse: async () => ({
            ...successResponse,
            output_parsed: { wrong: true },
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
});
