import { z } from "zod";
import type { StructuredModelRequest } from "../../src/ai/types.js";

const answerSchema = z.object({ answer: z.string() }).strict();

const structuredRequest = (
  overrides: Partial<StructuredModelRequest<typeof answerSchema>> = {},
): StructuredModelRequest<typeof answerSchema> => ({
  maxOutputTokens: 512,
  messages: [{ content: "Resolve the conflict.", role: "user" }],
  schema: answerSchema,
  schemaName: "answer",
  system: "Return a safe structured answer.",
  timeoutMs: 15_000,
  ...overrides,
});

export { answerSchema, structuredRequest };
