// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import type { EnabledAiConfig } from "../../src/config.js";
import {
  type SiblingResolutionRepository,
  findReusableSiblingResolution,
} from "../../src/conflicts/sibling-resolution.js";
import type { ConflictContext } from "../../src/conflicts/types.js";
import type { SiblingBackportCandidate } from "../../src/github.js";

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

const conflictContext: ConflictContext = {
  destinationHead: "destination-head",
  files: [
    {
      base: "Pending\n",
      blame: "",
      conflictRanges: [{ endLine: 5, startLine: 1 }],
      history: "",
      ours: "Pending\nArchived\n",
      path: "status.ts",
      theirs: "Pending\nActive\n",
      workingTree:
        "<<<<<<< HEAD\nPending\nArchived\n=======\nPending\nActive\n>>>>>>> source\n",
    },
  ],
  mergeBase: "merge-base",
  sourceChangedPaths: ["status.ts"],
  sourceCommit: "source-commit",
  sourceDiff: "+Active",
  sourceParent: "source-parent",
};

const candidate = (
  overrides: Partial<SiblingBackportCandidate> = {},
): SiblingBackportCandidate => ({
  baseSha: "sibling-base",
  changedPaths: ["status.ts"],
  merged: true,
  number: 101,
  resultSha: "sibling-result",
  sourceCommit: "source-commit",
  sourcePullRequestNumber: 42,
  ...overrides,
});

const repository = (
  blobs: Readonly<{ [revisionAndPath: string]: string | undefined }> = {},
): SiblingResolutionRepository => ({
  showOptional: async (revisionAndPath) =>
    blobs[revisionAndPath] ??
    {
      "sibling-base:status.ts": "Pending\nArchived\n",
      "sibling-result:status.ts": "Pending\nArchived\nActive\n",
    }[revisionAndPath],
  stablePatchId: async () => "stable-patch-id",
});

describe("findReusableSiblingResolution", () => {
  it("reuses a sibling only when its base blobs match ours", async () => {
    await expect(
      findReusableSiblingResolution({
        candidates: [candidate()],
        config,
        context: conflictContext,
        repository: repository(),
        sourcePullRequestNumber: 42,
      }),
    ).resolves.toEqual({
      decision: {
        assumptions: [],
        decision: "resolved",
        files: [
          {
            content: "Pending\nArchived\nActive\n",
            path: "status.ts",
            reason: "Reuse the exact resolution from merged backport PR #101.",
          },
        ],
        risks: [],
        summary: "Reused the exact resolution from merged backport PR #101.",
      },
      evidence: {
        patchId: "stable-patch-id",
        pullRequestNumber: 101,
      },
    });
  });

  it.each([
    candidate({ merged: false }),
    candidate({ sourceCommit: "different-source" }),
    candidate({ sourcePullRequestNumber: 99 }),
    candidate({ changedPaths: ["status.ts", "unrelated.ts"] }),
  ])("rejects an ineligible sibling candidate", async (sibling) => {
    await expect(
      findReusableSiblingResolution({
        candidates: [sibling],
        config,
        context: conflictContext,
        repository: repository(),
        sourcePullRequestNumber: 42,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a sibling whose base blob differs from ours", async () => {
    await expect(
      findReusableSiblingResolution({
        candidates: [candidate()],
        config,
        context: conflictContext,
        repository: repository({
          "sibling-base:status.ts": "Different destination content\n",
        }),
        sourcePullRequestNumber: 42,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a sibling that changed an immutable path", async () => {
    await expect(
      findReusableSiblingResolution({
        candidates: [
          candidate({
            changedPaths: ["status.ts", "data/migrations/20260101-setting.ts"],
          }),
        ],
        config,
        context: {
          ...conflictContext,
          sourceChangedPaths: [
            "status.ts",
            "data/migrations/20260101-setting.ts",
          ],
        },
        repository: repository(),
        sourcePullRequestNumber: 42,
      }),
    ).resolves.toBeUndefined();
  });
});
