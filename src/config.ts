import { z } from "zod";

const aiProviderSchema = z.enum([
  "anthropic",
  "anthropic-bedrock",
  "anthropic-compatible",
  "anthropic-vertex",
  "openai",
  "openai-compatible",
]);
const stringArraySchema = z.array(z.string().trim().min(1));

const keyBasedProviders = new Set([
  "anthropic",
  "anthropic-compatible",
  "openai",
  "openai-compatible",
]);

const baseUrlProviders = new Set(["anthropic-compatible", "openai-compatible"]);

type AiProviderName = z.infer<typeof aiProviderSchema>;

type InputReader = {
  get: (name: string, options?: { required?: boolean }) => string;
};

type DisabledAiConfig = {
  enabled: false;
};

type EnabledAiConfig = {
  apiKey: string;
  awsAccessKeyId?: string;
  awsRegion?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  baseUrl?: string;
  enabled: true;
  forbiddenPatterns: readonly string[];
  gcpProject?: string;
  gcpRegion?: string;
  gcpServiceAccountJson?: string;
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
      'Input "ai_provider" must be one of "anthropic", "anthropic-bedrock", "anthropic-compatible", "anthropic-vertex", "openai", or "openai-compatible".',
    );
  }

  const provider = providerResult.data;
  const optional = (name: string): string | undefined => {
    const value = reader.get(name).trim();
    return value.length > 0 ? value : undefined;
  };

  const baseUrl = reader.get("ai_base_url").trim();

  if (baseUrlProviders.has(provider) && baseUrl.length === 0) {
    throw new Error(
      `Input "ai_base_url" is required for the ${provider} provider.`,
    );
  }

  if (
    provider === "anthropic-bedrock" &&
    optional("ai_aws_region") === undefined
  ) {
    throw new Error(
      'Input "ai_aws_region" is required for the anthropic-bedrock provider.',
    );
  }

  if (provider === "anthropic-vertex") {
    if (optional("ai_gcp_project") === undefined) {
      throw new Error(
        'Input "ai_gcp_project" is required for the anthropic-vertex provider.',
      );
    }

    if (optional("ai_gcp_region") === undefined) {
      throw new Error(
        'Input "ai_gcp_region" is required for the anthropic-vertex provider.',
      );
    }
  }

  const awsAccessKeyId = optional("ai_aws_access_key_id");
  const awsRegion = optional("ai_aws_region");
  const awsSecretAccessKey = optional("ai_aws_secret_access_key");
  const awsSessionToken = optional("ai_aws_session_token");
  const gcpProject = optional("ai_gcp_project");
  const gcpRegion = optional("ai_gcp_region");
  const gcpServiceAccountJsonRaw = optional("ai_gcp_service_account_json");

  if (gcpServiceAccountJsonRaw !== undefined) {
    try {
      JSON.parse(gcpServiceAccountJsonRaw);
    } catch {
      throw new Error(
        'Input "ai_gcp_service_account_json" must be valid JSON.',
      );
    }
  }

  const gcpServiceAccountJson = gcpServiceAccountJsonRaw;

  return {
    apiKey: keyBasedProviders.has(provider)
      ? getRequiredInput(reader, "ai_api_key")
      : "",
    ...(awsAccessKeyId ? { awsAccessKeyId } : {}),
    ...(awsRegion ? { awsRegion } : {}),
    ...(awsSecretAccessKey ? { awsSecretAccessKey } : {}),
    ...(awsSessionToken ? { awsSessionToken } : {}),
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
    enabled: true,
    forbiddenPatterns: parseStringArray({
      fallback: [],
      name: "ai_forbidden_patterns",
      reader,
    }),
    ...(gcpProject ? { gcpProject } : {}),
    ...(gcpRegion ? { gcpRegion } : {}),
    ...(gcpServiceAccountJson ? { gcpServiceAccountJson } : {}),
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
