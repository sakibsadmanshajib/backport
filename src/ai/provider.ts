import type { EnabledAiConfig } from "../config.js";
import {
  AnthropicFamilyProvider,
  bedrockClientFactory,
  compatibleClientFactory,
  nativeClientFactory,
  vertexClientFactory,
} from "./providers/anthropic.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import { OpenAiProvider } from "./providers/openai.js";
import type { StructuredModelProvider } from "./types.js";

const createModelProvider = (
  config: EnabledAiConfig,
): StructuredModelProvider => {
  switch (config.provider) {
    case "anthropic": {
      return new AnthropicFamilyProvider({
        clientFactory: nativeClientFactory(config.apiKey),
        model: config.model,
        secrets: [config.apiKey],
      });
    }

    case "anthropic-compatible": {
      if (!config.baseUrl) {
        throw new Error(
          "An Anthropic-compatible provider requires a configured base URL.",
        );
      }

      return new AnthropicFamilyProvider({
        clientFactory: compatibleClientFactory(config.apiKey, config.baseUrl),
        model: config.model,
        secrets: [config.apiKey],
      });
    }

    case "anthropic-bedrock": {
      if (!config.awsRegion) {
        throw new Error(
          "The anthropic-bedrock provider requires an AWS region.",
        );
      }

      return new AnthropicFamilyProvider({
        clientFactory: bedrockClientFactory({
          accessKeyId: config.awsAccessKeyId,
          region: config.awsRegion,
          secretAccessKey: config.awsSecretAccessKey,
          sessionToken: config.awsSessionToken,
        }),
        model: config.model,
        secrets: [config.awsSecretAccessKey, config.awsSessionToken].filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        ),
      });
    }

    case "anthropic-vertex": {
      if (!config.gcpProject || !config.gcpRegion) {
        throw new Error(
          "The anthropic-vertex provider requires a GCP project and region.",
        );
      }

      return new AnthropicFamilyProvider({
        clientFactory: vertexClientFactory({
          project: config.gcpProject,
          region: config.gcpRegion,
          serviceAccountJson: config.gcpServiceAccountJson,
        }),
        model: config.model,
        secrets: config.gcpServiceAccountJson
          ? [config.gcpServiceAccountJson]
          : [],
      });
    }

    case "openai": {
      return new OpenAiProvider(config);
    }

    case "openai-compatible": {
      if (!config.baseUrl) {
        throw new Error(
          "An OpenAI-compatible provider requires a configured base URL.",
        );
      }

      return new OpenAiCompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
    }
  }
};

export { createModelProvider };
