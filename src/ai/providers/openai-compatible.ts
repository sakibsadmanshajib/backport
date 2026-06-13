import { OpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
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

type OpenAiCompatibleProviderConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
}>;

type OpenAiCompatibleClientOptions = Readonly<{
  apiKey: string;
  baseURL: string;
  maxRetries: number;
  timeout: number;
}>;

type OpenAiCompatibleParameters = Readonly<{
  max_completion_tokens: number;
  messages: Array<{
    content: string;
    role: "assistant" | "system" | "user";
  }>;
  model: string;
  response_format: ReturnType<typeof zodResponseFormat>;
}>;

type OpenAiCompatibleResponse = Readonly<{
  choices: ReadonlyArray<{
    finish_reason?: string;
    message: {
      parsed?: unknown;
      refusal?: string;
    };
  }>;
  usage?: {
    completion_tokens: number;
    prompt_tokens: number;
  };
}>;

type OpenAiCompatibleClient = {
  chat: {
    completions: {
      parse: (
        parameters: OpenAiCompatibleParameters,
        options?: { timeout?: number },
      ) => Promise<OpenAiCompatibleResponse>;
    };
  };
};

type OpenAiCompatibleClientFactory = (
  options: OpenAiCompatibleClientOptions,
) => OpenAiCompatibleClient;

const defaultOpenAiCompatibleClientFactory: OpenAiCompatibleClientFactory = (
  options,
) => {
  const client = new OpenAI(options);

  return {
    chat: {
      completions: {
        async parse(parameters, requestOptions) {
          const response = await client.chat.completions.parse<
            typeof parameters,
            unknown
          >(parameters, requestOptions);

          return {
            choices: response.choices.map((choice) => ({
              finish_reason: choice.finish_reason ?? undefined,
              message: {
                parsed: choice.message.parsed ?? undefined,
                refusal: choice.message.refusal ?? undefined,
              },
            })),
            usage: response.usage
              ? {
                  completion_tokens: response.usage.completion_tokens,
                  prompt_tokens: response.usage.prompt_tokens,
                }
              : undefined,
          };
        },
      },
    },
  };
};

class OpenAiCompatibleProvider implements StructuredModelProvider {
  readonly #clientFactory: OpenAiCompatibleClientFactory;
  readonly #config: OpenAiCompatibleProviderConfig;

  constructor(
    config: OpenAiCompatibleProviderConfig,
    clientFactory: OpenAiCompatibleClientFactory = defaultOpenAiCompatibleClientFactory,
  ) {
    this.#clientFactory = clientFactory;
    this.#config = config;
  }

  async generate<TSchema extends z.ZodTypeAny>(
    request: StructuredModelRequest<TSchema>,
  ): Promise<ModelResult<z.infer<TSchema>>> {
    const client = this.#clientFactory({
      apiKey: this.#config.apiKey,
      baseURL: this.#config.baseUrl,
      maxRetries: 0,
      timeout: request.timeoutMs,
    });

    try {
      const response = await client.chat.completions.parse(
        {
          max_completion_tokens: request.maxOutputTokens,
          messages: [
            { content: request.system, role: "system" },
            ...request.messages.map(({ content, role }) => ({ content, role })),
          ],
          model: this.#config.model,
          response_format: zodResponseFormat(
            request.schema,
            request.schemaName,
          ),
        },
        { timeout: request.timeoutMs },
      );
      const choice = response.choices[0];
      const usage = response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined;

      if (!choice) {
        return failure(
          "invalid-output",
          "The OpenAI-compatible endpoint returned no choices.",
          usage,
        );
      }

      if (
        choice.finish_reason === "content_filter" ||
        (choice.message.refusal?.length ?? 0) > 0
      ) {
        return failure(
          "refusal",
          "The OpenAI-compatible endpoint refused the request.",
          usage,
        );
      }

      if (choice.finish_reason === "length") {
        return failure(
          "incomplete",
          "The OpenAI-compatible endpoint reached its output limit.",
          usage,
        );
      }

      if (choice.message.parsed === undefined) {
        return failure(
          "invalid-output",
          "The OpenAI-compatible endpoint returned no strict structured output.",
          usage,
        );
      }

      return validateParsedOutput(request.schema, choice.message.parsed, usage);
    } catch (error: unknown) {
      return normalizeProviderError(error, this.#config.apiKey);
    }
  }
}

export {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleClient,
  type OpenAiCompatibleClientFactory,
  type OpenAiCompatibleClientOptions,
  type OpenAiCompatibleProviderConfig,
};
