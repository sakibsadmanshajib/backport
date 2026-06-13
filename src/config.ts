import { z } from "zod";

const aiProviderSchema = z.enum(["anthropic", "openai", "openai-compatible"]);
const stringArraySchema = z.array(z.string().trim().min(1));

type AiProviderName = z.infer<typeof aiProviderSchema>;

type InputReader = {
  get: (name: string, options?: { required?: boolean }) => string;
};

type DisabledAiConfig = {
  enabled: false;
};

type EnabledAiConfig = {
  apiKey: string;
  baseUrl?: string;
  enabled: true;
  forbiddenPatterns: readonly string[];
  immutablePatterns: readonly string[];
  label: string;
  maxConflictedFiles: number;
  maxResolutionLines: number;
  model: string;
  provider: AiProviderName;
  timeoutMs: number;
  validationCommands: readonly string[];
};

type AiConfig = DisabledAiConfig | EnabledAiConfig;

const getRequiredInput = (reader: InputReader, name: string): string => {
  const value = reader.get(name).trim();

  if (value.length === 0) {
    throw new Error(`Input "${name}" is required when AI is enabled.`);
  }

  return value;
};

const parseEnabled = (value: string): boolean => {
  const normalized = value.trim();

  if (normalized === "" || normalized === "false") {
    return false;
  }

  if (normalized === "true") {
    return true;
  }

  throw new Error('Input "ai_enabled" must be either "true" or "false".');
};

const parsePositiveInteger = (
  reader: InputReader,
  name: string,
  fallback: number,
): number => {
  const value = reader.get(name).trim();

  if (value.length === 0) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Input "${name}" must be a positive integer.`);
  }

  return parsed;
};

const parseStringArray = ({
  fallback,
  name,
  reader,
  requireValues = false,
}: {
  fallback: readonly string[];
  name: string;
  reader: InputReader;
  requireValues?: boolean;
}): readonly string[] => {
  const value = reader.get(name).trim();

  if (value.length === 0) {
    if (requireValues && fallback.length === 0) {
      throw new Error(`Input "${name}" is required when AI is enabled.`);
    }

    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    const result = stringArraySchema.parse(parsed);

    if (requireValues && result.length === 0) {
      throw new Error("The array must contain at least one value.");
    }

    return result;
  } catch (error: unknown) {
    throw new Error(
      `Input "${name}" must be a JSON array of non-empty strings.`,
      { cause: error },
    );
  }
};

const readAiConfig = (reader: InputReader): AiConfig => {
  if (!parseEnabled(reader.get("ai_enabled"))) {
    return { enabled: false };
  }

  const providerInput = getRequiredInput(reader, "ai_provider");
  const providerResult = aiProviderSchema.safeParse(providerInput);

  if (!providerResult.success) {
    throw new Error(
      'Input "ai_provider" must be "anthropic", "openai", or "openai-compatible".',
    );
  }

  const provider = providerResult.data;
  const baseUrl = reader.get("ai_base_url").trim();

  if (provider === "openai-compatible" && baseUrl.length === 0) {
    throw new Error(
      'Input "ai_base_url" is required for the openai-compatible provider.',
    );
  }

  return {
    apiKey: getRequiredInput(reader, "ai_api_key"),
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
    enabled: true,
    forbiddenPatterns: parseStringArray({
      fallback: [],
      name: "ai_forbidden_patterns",
      reader,
    }),
    immutablePatterns: parseStringArray({
      fallback: ["**/migrations/**", "**/migration/**"],
      name: "ai_immutable_patterns",
      reader,
    }),
    label: reader.get("ai_label").trim() || "AI backport",
    maxConflictedFiles: parsePositiveInteger(
      reader,
      "ai_max_conflicted_files",
      3,
    ),
    maxResolutionLines: parsePositiveInteger(
      reader,
      "ai_max_resolution_lines",
      60,
    ),
    model: getRequiredInput(reader, "ai_model"),
    provider,
    timeoutMs: parsePositiveInteger(reader, "ai_timeout_seconds", 120) * 1000,
    validationCommands: parseStringArray({
      fallback: [],
      name: "ai_validation_commands",
      reader,
      requireValues: true,
    }),
  };
};

const getSafeAiConfigSummary = (
  config: AiConfig,
):
  | DisabledAiConfig
  | Readonly<{
      enabled: true;
      model: string;
      provider: AiProviderName;
    }> =>
  config.enabled
    ? {
        enabled: true,
        model: config.model,
        provider: config.provider,
      }
    : config;

export {
  getSafeAiConfigSummary,
  readAiConfig,
  type AiConfig,
  type AiProviderName,
  type EnabledAiConfig,
  type InputReader,
};
