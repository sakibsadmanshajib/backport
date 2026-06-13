import ensureError from "ensure-error";
import type { z } from "zod";
import type {
  ModelFailure,
  ModelFailureCategory,
  ModelResult,
  ModelUsage,
} from "../types.js";

const failure = (
  category: ModelFailureCategory,
  message: string,
  usage?: ModelUsage,
): ModelFailure => ({
  category,
  message,
  ok: false,
  ...(usage ? { usage } : {}),
});

const sanitizeProviderError = (error: unknown, apiKey: string): string => {
  const message = ensureError(error).message.replaceAll(apiKey, "[REDACTED]");
  return message.slice(0, 500);
};

const normalizeProviderError = (
  error: unknown,
  apiKey: string,
): ModelFailure => {
  const normalized = ensureError(error);
  const category =
    normalized.name.toLowerCase().includes("timeout") ||
    normalized.message.toLowerCase().includes("timed out")
      ? "timeout"
      : "provider-error";

  return failure(category, sanitizeProviderError(normalized, apiKey));
};

const validateParsedOutput = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  output: unknown,
  usage?: ModelUsage,
): ModelResult<z.infer<TSchema>> => {
  const parsed = schema.safeParse(output);

  if (!parsed.success) {
    return failure(
      "invalid-output",
      "The provider returned output that did not match the required schema.",
      usage,
    );
  }

  return {
    data: parsed.data,
    ok: true,
    ...(usage ? { usage } : {}),
  };
};

export {
  failure,
  normalizeProviderError,
  sanitizeProviderError,
  validateParsedOutput,
};
