import { z } from "zod";

const modelMessageSchema = z
  .object({
    content: z.string().min(1),
    role: z.enum(["assistant", "user"]),
  })
  .strict();

const resolvedFileSchema = z
  .object({
    content: z.string(),
    path: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const resolutionDecisionSchema = z
  .object({
    assumptions: z.array(z.string()),
    decision: z.enum(["escalate", "resolved"]),
    files: z.array(resolvedFileSchema),
    risks: z.array(z.string()),
    summary: z.string().min(1),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.decision === "escalate" && decision.files.length > 0) {
      context.addIssue({
        code: "custom",
        message: "An escalation must not contain proposed files.",
        path: ["files"],
      });
    }

    if (decision.decision === "resolved" && decision.files.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A resolved decision must contain at least one file.",
        path: ["files"],
      });
    }

    const seenPaths = new Set<string>();

    for (const [index, file] of decision.files.entries()) {
      if (seenPaths.has(file.path)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate output path: ${file.path}.`,
          path: ["files", index, "path"],
        });
      }

      seenPaths.add(file.path);
    }
  });

const reviewDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    findings: z.array(z.string().min(1)),
    summary: z.string().min(1),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.decision === "reject" && review.findings.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A rejected review must contain at least one finding.",
        path: ["findings"],
      });
    }
  });

type ResolutionDecision = z.infer<typeof resolutionDecisionSchema>;
type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export {
  modelMessageSchema,
  resolutionDecisionSchema,
  reviewDecisionSchema,
  type ResolutionDecision,
  type ReviewDecision,
};
