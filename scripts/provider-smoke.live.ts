/**
 * Throwaway LIVE provider smoke. This is intentionally NOT part of the default
 * suite: the filename ends in `.live.ts`, and the default Vitest include only
 * matches `*.test.ts` / `*.spec.ts`, so `yarn test` and CI never run it.
 *
 * It drives the real provider factory and the exact prompt builders the action
 * uses, then asserts each adapter returns strict, schema-valid structured
 * output from its live API. No GitHub side effects. A few cents of tokens.
 *
 * Run (keys sourced from a gitignored file so they never enter the transcript):
 *   set -a; . ./.smoke.env; set +a
 *   npx vitest run --config vitest.live.config.mts
 *
 * Each provider test is skipped unless its key is present.
 */
import { env } from "node:process";
// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  buildResolutionRequest,
  buildReviewRequest,
} from "../src/ai/prompts.js";
import { createModelProvider } from "../src/ai/provider.js";
import type { StructuredModelProvider } from "../src/ai/types.js";
import type { EnabledAiConfig } from "../src/config.js";
import type { ConflictContext } from "../src/conflicts/types.js";

const timeoutMs = 120_000;

const context: ConflictContext = {
  destinationHead: "destination",
  files: [
    {
      base: "Pending\n",
      blame: "blame evidence",
      conflictRanges: [{ endLine: 5, startLine: 1 }],
      history: "history evidence",
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

const baseConfig = {
  enabled: true,
  forbiddenPatterns: ["**/authorization/**"],
  immutablePatterns: ["**/migrations/**"],
  label: "AI backport",
  maxConflictedFiles: 3,
  maxResolutionLines: 60,
  timeoutMs,
  validationCommands: ["yarn test"],
} as const;

const describeResult = (result: {
  category?: string;
  message?: string;
  ok: boolean;
  usage?: unknown;
}): string =>
  result.ok
    ? `ok usage=${JSON.stringify(result.usage ?? {})}`
    : `FAIL ${result.category}: ${result.message}`;

const smoke = async (
  name: string,
  provider: StructuredModelProvider,
  config: EnabledAiConfig,
): Promise<void> => {
  const resolution = await provider.generate(
    buildResolutionRequest(context, config),
  );
  // eslint-disable-next-line no-console
  console.log(
    `[${name}] resolution ${describeResult(resolution)}${
      resolution.ok ? ` decision=${resolution.data.decision}` : ""
    }`,
  );
  expect(
    resolution.ok,
    resolution.ok ? "" : `${resolution.category}: ${resolution.message}`,
  ).toBe(true);

  if (resolution.ok && resolution.data.decision === "resolved") {
    const review = await provider.generate(
      buildReviewRequest(context, config, resolution.data),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[${name}] review ${describeResult(review)}${
        review.ok ? ` decision=${review.data.decision}` : ""
      }`,
    );
    expect(
      review.ok,
      review.ok ? "" : `${review.category}: ${review.message}`,
    ).toBe(true);
  }
};

describe("live provider smoke", () => {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  it.runIf(Boolean(anthropicKey))(
    "anthropic returns strict structured output",
    async () => {
      const config: EnabledAiConfig = {
        ...baseConfig,
        apiKey: anthropicKey!,
        model: env.SMOKE_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
        provider: "anthropic",
      };
      await smoke("anthropic", createModelProvider(config), config);
    },
    timeoutMs,
  );

  const openaiKey = env.OPENAI_API_KEY;
  it.runIf(Boolean(openaiKey))(
    "openai returns strict structured output",
    async () => {
      const config: EnabledAiConfig = {
        ...baseConfig,
        apiKey: openaiKey!,
        model: env.SMOKE_OPENAI_MODEL ?? "gpt-4o-mini",
        provider: "openai",
      };
      await smoke("openai", createModelProvider(config), config);
    },
    timeoutMs,
  );

  const compatKey = env.SMOKE_COMPAT_API_KEY;
  const compatBase = env.SMOKE_COMPAT_BASE_URL;
  const compatModel = env.SMOKE_COMPAT_MODEL;
  it.runIf(Boolean(compatKey && compatBase && compatModel))(
    "openai-compatible returns strict structured output",
    async () => {
      const config: EnabledAiConfig = {
        ...baseConfig,
        apiKey: compatKey!,
        baseUrl: compatBase!,
        model: compatModel!,
        provider: "openai-compatible",
      };
      await smoke("openai-compatible", createModelProvider(config), config);
    },
    timeoutMs,
  );
});
