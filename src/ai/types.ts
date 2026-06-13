import type { z } from "zod";

type ModelMessage = Readonly<{
  content: string;
  role: "assistant" | "user";
}>;

type ModelUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
}>;

type ModelFailureCategory =
  | "incomplete"
  | "invalid-output"
  | "provider-error"
  | "refusal"
  | "timeout";

type ModelFailure = Readonly<{
  category: ModelFailureCategory;
  message: string;
  ok: false;
  usage?: ModelUsage;
}>;

type ModelSuccess<T> = Readonly<{
  data: T;
  ok: true;
  usage?: ModelUsage;
}>;

type ModelResult<T> = ModelFailure | ModelSuccess<T>;

type StructuredModelRequest<TSchema extends z.ZodTypeAny> = Readonly<{
  maxOutputTokens: number;
  messages: readonly ModelMessage[];
  schema: TSchema;
  schemaName: string;
  system: string;
  timeoutMs: number;
}>;

type StructuredModelProvider = {
  generate: <TSchema extends z.ZodTypeAny>(
    request: StructuredModelRequest<TSchema>,
  ) => Promise<ModelResult<z.infer<TSchema>>>;
};

export type {
  ModelFailure,
  ModelFailureCategory,
  ModelMessage,
  ModelResult,
  ModelSuccess,
  ModelUsage,
  StructuredModelProvider,
  StructuredModelRequest,
};
