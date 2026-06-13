import { Anthropic } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod.mjs";
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

type AnthropicProviderConfig = Readonly<{
  apiKey: string;
  model: string;
}>;

type AnthropicClientOptions = Readonly<{
  apiKey: string;
  maxRetries: number;
  timeout: number;
}>;

type AnthropicParseParameters = Readonly<{
  max_tokens: number;
  messages: Array<{
    content: string;
    role: "assistant" | "user";
  }>;
  model: string;
  output_config: {
    format: ReturnType<typeof zodOutputFormat>;
  };
  system: string;
}>;

type AnthropicResponse = Readonly<{
  parsed_output?: unknown;
  stop_details?: unknown;
  stop_reason?: string;
  usage: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens: number;
  };
}>;

type AnthropicClient = {
  messages: {
    parse: (
      parameters: AnthropicParseParameters,
      options?: { timeout?: number },
    ) => Promise<AnthropicResponse>;
  };
};

type AnthropicClientFactory = (
  options: AnthropicClientOptions,
) => AnthropicClient;

const defaultAnthropicClientFactory: AnthropicClientFactory = (options) => {
  const client = new Anthropic(options);

  return {
    messages: {
      async parse(parameters, requestOptions) {
        const response = await client.messages.parse(
          parameters,
          requestOptions,
        );

        return {
          parsed_output: response.parsed_output ?? undefined,
          stop_details: response.stop_details ?? undefined,
          stop_reason: response.stop_reason ?? undefined,
          usage: {
            cache_creation_input_tokens:
              response.usage.cache_creation_input_tokens ?? undefined,
            cache_read_input_tokens:
              response.usage.cache_read_input_tokens ?? undefined,
            input_tokens: response.usage.input_tokens ?? undefined,
            output_tokens: response.usage.output_tokens,
          },
        };
      },
    },
  };
};

class AnthropicProvider implements StructuredModelProvider {
  readonly #clientFactory: AnthropicClientFactory;
  readonly #config: AnthropicProviderConfig;

  constructor(
    config: AnthropicProviderConfig,
    clientFactory: AnthropicClientFactory = defaultAnthropicClientFactory,
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
      const response = await client.messages.parse(
        {
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map(({ content, role }) => ({
            content,
            role,
          })),
          model: this.#config.model,
          output_config: {
            format: zodOutputFormat(request.schema),
          },
          system: request.system,
        },
        { timeout: request.timeoutMs },
      );
      const usage = {
        inputTokens:
          (response.usage.input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
      };

      if (response.stop_reason === "refusal") {
        return failure("refusal", "Anthropic refused the request.", usage);
      }

      if (
        response.stop_reason === "max_tokens" ||
        response.stop_reason === "pause_turn"
      ) {
        return failure(
          "incomplete",
          `Anthropic stopped with ${response.stop_reason}.`,
          usage,
        );
      }

      if (response.parsed_output === undefined) {
        return failure(
          "invalid-output",
          "Anthropic returned no structured output.",
          usage,
        );
      }

      return validateParsedOutput(
        request.schema,
        response.parsed_output,
        usage,
      );
    } catch (error: unknown) {
      return normalizeProviderError(error, this.#config.apiKey);
    }
  }
}

export {
  AnthropicProvider,
  type AnthropicClient,
  type AnthropicClientFactory,
  type AnthropicClientOptions,
  type AnthropicProviderConfig,
};
