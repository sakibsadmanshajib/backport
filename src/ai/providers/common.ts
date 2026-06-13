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

const sanitizeProviderError = (
  error: unknown,
  secrets: string | readonly string[],
): string => {
  const secretList = typeof secrets === "string" ? [secrets] : secrets;
  let message = ensureError(error).message;

  for (const secret of secretList) {
    if (secret.length > 0) {
      message = message.replaceAll(secret, "[REDACTED]");
    }
  }

  return message.slice(0, 500);
};

const normalizeProviderError = (
  error: unknown,
  secrets: string | readonly string[],
): ModelFailure => {
  const normalized = ensureError(error);
  const category =
    normalized.name.toLowerCase().includes("timeout") ||
    normalized.message.toLowerCase().includes("timed out")
      ? "timeout"
      : "provider-error";

  return failure(category, sanitizeProviderError(normalized, secrets));
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
