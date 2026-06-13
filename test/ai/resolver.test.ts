// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import { resolveConflictWithAi } from "../../src/ai/resolver.js";
import type {
  ResolutionDecision,
  ReviewDecision,
} from "../../src/ai/schema.js";
import type {
  ModelResult,
  StructuredModelProvider,
} from "../../src/ai/types.js";
import type { EnabledAiConfig } from "../../src/config.js";
import type { ConflictContext } from "../../src/conflicts/types.js";

const config: EnabledAiConfig = {
  apiKey: "secret",
  enabled: true,
  forbiddenPatterns: [],
  immutablePatterns: ["**/migrations/**"],
  label: "AI backport",
  maxConflictedFiles: 3,
  maxResolutionLines: 60,
  model: "small-model",
  provider: "anthropic",
  timeoutMs: 120_000,
  validationCommands: ["yarn test"],
};

const context: ConflictContext = {
  destinationHead: "destination",
  files: [
    {
      base: "Pending\n",
      blame: "",
      conflictRanges: [{ endLine: 5, startLine: 1 }],
      history: "",
      ours: "Pending\nArchived\n",
      path: "status.ts",
      theirs: "Pending\nActive\n",
      workingTree: "<<<<<<< HEAD\nArchived\n=======\nActive\n>>>>>>> source\n",
    },
  ],
  mergeBase: "merge-base",
  sourceChangedPaths: ["status.ts"],
  sourceCommit: "source",
  sourceDiff: "+Active",
  sourceParent: "parent",
};

const resolution: ResolutionDecision = {
  assumptions: [],
  decision: "resolved",
  files: [
    {
      content: "Pending\nArchived\nActive\n",
      path: "status.ts",
      reason: "Combine both enum members.",
    },
  ],
  risks: [],
  summary: "Resolved the conflict.",
};

const approval: ReviewDecision = {
  decision: "approve",
  findings: [],
  summary: "The resolution is narrow and preserves intent.",
};

const provider = (
  results: Array<ModelResult<unknown>>,
): StructuredModelProvider => ({
  async generate(request) {
    const result = results.shift();

    if (!result) {
      throw new Error("Unexpected provider retry.");
    }

    if (!result.ok) {
      return result;
    }

    const parsed = request.schema.safeParse(result.data);

    if (!parsed.success) {
      return {
        category: "invalid-output",
        message: "Test provider output did not match the request schema.",
        ok: false,
      };
    }

    return { data: parsed.data, ok: true };
  },
});

describe("resolveConflictWithAi", () => {
  it("makes one resolution call and one independent review call", async () => {
    let validations = 0;
    const results: Array<ModelResult<unknown>> = [
      { data: resolution, ok: true },
      { data: approval, ok: true },
    ];

    await expect(
      resolveConflictWithAi({
        config,
        context,
        provider: provider(results),
        async validateCandidate() {
          validations += 1;
          return { valid: true };
        },
      }),
    ).resolves.toEqual({
      decision: resolution,
      review: approval,
      status: "resolved",
    });
    expect(results).toHaveLength(0);
    expect(validations).toBe(2);
  });

  it("does not review a model escalation", async () => {
    const results: Array<ModelResult<unknown>> = [
      {
        data: {
          ...resolution,
          decision: "escalate",
          files: [],
          summary: "Behavior is ambiguous.",
        },
        ok: true,
      },
    ];

    await expect(
      resolveConflictWithAi({
        config,
        context,
        provider: provider(results),
        validateCandidate: async () => ({ valid: true }),
      }),
    ).resolves.toMatchObject({ status: "escalated" });
    expect(results).toHaveLength(0);
  });

  it("does not retry a provider failure", async () => {
    const results: Array<ModelResult<unknown>> = [
      { category: "timeout", message: "Timed out.", ok: false },
    ];

    const outcome = await resolveConflictWithAi({
      config,
      context,
      provider: provider(results),
      validateCandidate: async () => ({ valid: true }),
    });

    expect(outcome.status).toBe("escalated");
    expect(outcome.status === "escalated" ? outcome.reason : "").toContain(
      "timeout",
    );
    expect(results).toHaveLength(0);
  });

  it("does not review a candidate that fails deterministic validation", async () => {
    const results: Array<ModelResult<unknown>> = [
      { data: resolution, ok: true },
    ];

    const outcome = await resolveConflictWithAi({
      config,
      context,
      provider: provider(results),
      validateCandidate: async () => ({
        reasons: ["Migration changed."],
        valid: false,
      }),
    });

    expect(outcome.status).toBe("escalated");
    expect(outcome.status === "escalated" ? outcome.reason : "").toContain(
      "Migration changed.",
    );
    expect(results).toHaveLength(0);
  });

  it("escalates a reviewer rejection without another resolution attempt", async () => {
    const results: Array<ModelResult<unknown>> = [
      { data: resolution, ok: true },
      {
        data: {
          decision: "reject",
          findings: ["The source behavior is not preserved."],
          summary: "Developer review is required.",
        },
        ok: true,
      },
    ];

    const outcome = await resolveConflictWithAi({
      config,
      context,
      provider: provider(results),
      validateCandidate: async () => ({ valid: true }),
    });

    expect(outcome.status).toBe("escalated");
    expect(outcome.status === "escalated" ? outcome.reason : "").toContain(
      "source behavior",
    );
    expect(results).toHaveLength(0);
  });
});
