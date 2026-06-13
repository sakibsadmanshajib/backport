import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { Anthropic } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod.mjs";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";
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

type AnthropicRequestOptions = Readonly<{
  maxRetries: number;
  timeout: number;
}>;

type AnthropicClientFactory = (
  options: AnthropicRequestOptions,
) => AnthropicClient;

type BedrockAuth = Readonly<{
  accessKeyId?: string;
  region: string;
  secretAccessKey?: string;
  sessionToken?: string;
}>;

type VertexAuth = Readonly<{
  project: string;
  region: string;
  serviceAccountJson?: string;
}>;

const normalizeResponse = (response: {
  parsed_output?: unknown;
  stop_details?: unknown;
  stop_reason?: string | null;
  usage: {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    input_tokens?: number | null;
    output_tokens: number;
  };
}): AnthropicResponse => ({
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
});

const wrapClient = (
  parse: (
    parameters: AnthropicParseParameters,
    options?: { timeout?: number },
  ) => Promise<Parameters<typeof normalizeResponse>[0]>,
): AnthropicClient => ({
  messages: {
    async parse(parameters, options) {
      return normalizeResponse(await parse(parameters, options));
    },
  },
});

const nativeClientFactory =
  (apiKey: string): AnthropicClientFactory =>
  (options) => {
    const client = new Anthropic({ apiKey, ...options });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

const compatibleClientFactory =
  (apiKey: string, baseURL: string): AnthropicClientFactory =>
  (options) => {
    const client = new Anthropic({ apiKey, baseURL, ...options });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

const bedrockClientFactory =
  (auth: BedrockAuth): AnthropicClientFactory =>
  (options) => {
    const { accessKeyId, secretAccessKey } = auth;
    const hasExplicitKeys =
      accessKeyId !== undefined && secretAccessKey !== undefined;
    const client = new AnthropicBedrock({
      awsRegion: auth.region,
      ...(hasExplicitKeys
        ? {
            providerChainResolver: async () => async () => ({
              accessKeyId,
              secretAccessKey,
              ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
            }),
          }
        : {}),
      ...options,
    });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

const vertexClientFactory =
  (auth: VertexAuth): AnthropicClientFactory =>
  (options) => {
    const { serviceAccountJson } = auth;
    const googleAuth = serviceAccountJson
      ? new GoogleAuth({
          credentials: JSON.parse(serviceAccountJson) as {
            [key: string]: unknown;
          },
          scopes: "https://www.googleapis.com/auth/cloud-platform",
        })
      : undefined;
    const client = new AnthropicVertex({
      projectId: auth.project,
      region: auth.region,
      ...(googleAuth ? { googleAuth } : {}),
      ...options,
    });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

class AnthropicFamilyProvider implements StructuredModelProvider {
  readonly #clientFactory: AnthropicClientFactory;
  readonly #model: string;
  readonly #secrets: readonly string[];

  constructor(parameters: {
    clientFactory: AnthropicClientFactory;
    model: string;
    secrets: readonly string[];
  }) {
    this.#clientFactory = parameters.clientFactory;
    this.#model = parameters.model;
    this.#secrets = parameters.secrets;
  }

  async generate<TSchema extends z.ZodTypeAny>(
    request: StructuredModelRequest<TSchema>,
  ): Promise<ModelResult<z.infer<TSchema>>> {
    try {
      const client = this.#clientFactory({
        maxRetries: 0,
        timeout: request.timeoutMs,
      });

      const response = await client.messages.parse(
        {
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map(({ content, role }) => ({
            content,
            role,
          })),
          model: this.#model,
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
      return normalizeProviderError(error, this.#secrets);
    }
  }
}

export {
  AnthropicFamilyProvider,
  bedrockClientFactory,
  compatibleClientFactory,
  nativeClientFactory,
  vertexClientFactory,
  type AnthropicClient,
  type AnthropicClientFactory,
  type AnthropicRequestOptions,
  type BedrockAuth,
  type VertexAuth,
};
