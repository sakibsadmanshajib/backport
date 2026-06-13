import type { EnabledAiConfig } from "../config.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import { OpenAiProvider } from "./providers/openai.js";
import type { StructuredModelProvider } from "./types.js";

const createModelProvider = (
  config: EnabledAiConfig,
): StructuredModelProvider => {
  switch (config.provider) {
    case "anthropic": {
      return new AnthropicProvider(config);
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
