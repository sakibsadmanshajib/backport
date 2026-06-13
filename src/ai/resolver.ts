import ensureError from "ensure-error";
import type { EnabledAiConfig } from "../config.js";
import type { ValidationResult } from "../conflicts/policy.js";
import type { ConflictContext } from "../conflicts/types.js";
import { buildResolutionRequest, buildReviewRequest } from "./prompts.js";
import type { ResolutionDecision, ReviewDecision } from "./schema.js";
import type { StructuredModelProvider } from "./types.js";

type AiResolutionOutcome =
  | Readonly<{
      decision: ResolutionDecision;
      review: ReviewDecision;
      status: "resolved";
    }>
  | Readonly<{
      reason: string;
      status: "escalated";
    }>;

type ResolveConflictInput = Readonly<{
  config: EnabledAiConfig;
  context: ConflictContext;
  provider: StructuredModelProvider;
  validateCandidate: (
    decision: ResolutionDecision,
  ) => Promise<ValidationResult>;
}>;

const validationFailureReason = (validation: ValidationResult): string =>
  validation.valid
    ? ""
    : `Deterministic validation failed: ${validation.reasons.join(" ")}`;

const resolveConflictWithAi = async ({
  config,
  context,
  provider,
  validateCandidate,
}: ResolveConflictInput): Promise<AiResolutionOutcome> => {
  try {
    const resolutionResult = await provider.generate(
      buildResolutionRequest(context, config),
    );

    if (!resolutionResult.ok) {
      return {
        reason: `Resolution ${resolutionResult.category}: ${resolutionResult.message}`,
        status: "escalated",
      };
    }

    const resolution = resolutionResult.data;

    if (resolution.decision === "escalate") {
      return {
        reason: `Model escalation: ${resolution.summary}`,
        status: "escalated",
      };
    }

    const initialValidation = await validateCandidate(resolution);

    if (!initialValidation.valid) {
      return {
        reason: validationFailureReason(initialValidation),
        status: "escalated",
      };
    }

    const reviewResult = await provider.generate(
      buildReviewRequest(context, config, resolution),
    );

    if (!reviewResult.ok) {
      return {
        reason: `Review ${reviewResult.category}: ${reviewResult.message}`,
        status: "escalated",
      };
    }

    const review = reviewResult.data;

    if (review.decision === "reject") {
      return {
        reason: `Reviewer rejected the resolution: ${review.findings.join(
          " ",
        )}`,
        status: "escalated",
      };
    }

    const finalValidation = await validateCandidate(resolution);

    if (!finalValidation.valid) {
      return {
        reason: validationFailureReason(finalValidation),
        status: "escalated",
      };
    }

    return {
      decision: resolution,
      review,
      status: "resolved",
    };
  } catch (error: unknown) {
    return {
      reason: `AI resolution failed: ${ensureError(error).message}`,
      status: "escalated",
    };
  }
};

export {
  resolveConflictWithAi,
  type AiResolutionOutcome,
  type ResolveConflictInput,
};
