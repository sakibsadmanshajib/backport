import { OpenAI } from "openai";
import { zodTextFormat } from "openai/helpers/zod.mjs";
import type { z } from "zod";
import type {
  ModelResult,
  StructuredModelProvider,
  StructuredModelRequest,
} from "../types.js";
import {
  failure,
  normalizeProviderError,
  validateParsedOutput,
} from "./common.js";

type OpenAiProviderConfig = Readonly<{
  apiKey: string;
  model: string;
}>;

type OpenAiClientOptions = Readonly<{
  apiKey: string;
  maxRetries: number;
  timeout: number;
}>;

type OpenAiResponseParameters = Readonly<{
  input: Array<{
    content: string;
    role: "assistant" | "user";
  }>;
  instructions: string;
  max_output_tokens: number;
  model: string;
  text: {
    format: ReturnType<typeof zodTextFormat>;
  };
}>;

type OpenAiResponse = Readonly<{
  incomplete_details?: { reason?: string };
  output: ReadonlyArray<{
    content?: ReadonlyArray<{
      refusal?: string;
      type?: string;
    }>;
    type?: string;
  }>;
  output_parsed?: unknown;
  status?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}>;

type OpenAiClient = {
  responses: {
    parse: (
      parameters: OpenAiResponseParameters,
      options?: { timeout?: number },
    ) => Promise<OpenAiResponse>;
  };
};

type OpenAiClientFactory = (options: OpenAiClientOptions) => OpenAiClient;

const defaultOpenAiClientFactory: OpenAiClientFactory = (options) => {
  const client = new OpenAI(options);

  return {
    responses: {
      async parse(parameters, requestOptions) {
        const response = await client.responses.parse(
          parameters,
          requestOptions,
        );

        return {
          incomplete_details: response.incomplete_details
            ? { reason: response.incomplete_details.reason }
            : undefined,
          output: response.output.map((item) =>
            item.type === "message"
              ? {
                  content: item.content.map((content) =>
                    content.type === "refusal"
                      ? {
                          refusal: content.refusal,
                          type: content.type,
                        }
                      : { type: content.type },
                  ),
                  type: item.type,
                }
              : { type: item.type },
          ),
          output_parsed: response.output_parsed ?? undefined,
          status: response.status,
          usage: response.usage
            ? {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
              }
            : undefined,
        };
      },
    },
  };
};

const hasRefusal = (response: OpenAiResponse): boolean =>
  response.output.some((item) =>
    item.content?.some(
      (content) =>
        content.type === "refusal" &&
        typeof content.refusal === "string" &&
        content.refusal.length > 0,
    ),
  );

class OpenAiProvider implements StructuredModelProvider {
  readonly #clientFactory: OpenAiClientFactory;
  readonly #config: OpenAiProviderConfig;

  constructor(
    config: OpenAiProviderConfig,
    clientFactory: OpenAiClientFactory = defaultOpenAiClientFactory,
  ) {
    this.#clientFactory = clientFactory;
    this.#config = config;
  }

  async generate<TSchema extends z.ZodTypeAny>(
    request: StructuredModelRequest<TSchema>,
  ): Promise<ModelResult<z.infer<TSchema>>> {
    const client = this.#clientFactory({
      apiKey: this.#config.apiKey,
      maxRetries: 0,
      timeout: request.timeoutMs,
    });

    try {
      const response = await client.responses.parse(
        {
          input: request.messages.map(({ content, role }) => ({
            content,
            role,
          })),
          instructions: request.system,
          max_output_tokens: request.maxOutputTokens,
          model: this.#config.model,
          text: {
            format: zodTextFormat(request.schema, request.schemaName),
          },
        },
        { timeout: request.timeoutMs },
      );
      const usage = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined;

      if (hasRefusal(response)) {
        return failure("refusal", "OpenAI refused the request.", usage);
      }

      if (response.status === "incomplete") {
        return failure(
          "incomplete",
          `OpenAI returned an incomplete response${
            response.incomplete_details?.reason
              ? `: ${response.incomplete_details.reason}`
              : ""
          }.`,
          usage,
        );
      }

      if (response.status === "failed") {
        return failure(
          "provider-error",
          "OpenAI failed to generate a response.",
          usage,
        );
      }

      if (response.output_parsed === undefined) {
        return failure(
          "invalid-output",
          "OpenAI returned no structured output.",
          usage,
        );
      }

      return validateParsedOutput(
        request.schema,
        response.output_parsed,
        usage,
      );
    } catch (error: unknown) {
      return normalizeProviderError(error, this.#config.apiKey);
    }
  }
}

export {
  OpenAiProvider,
  type OpenAiClient,
  type OpenAiClientFactory,
  type OpenAiClientOptions,
  type OpenAiProviderConfig,
};
