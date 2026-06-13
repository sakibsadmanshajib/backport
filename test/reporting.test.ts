import { describe, expect, it } from "vitest";
import type { ResolutionDecision, ReviewDecision } from "../src/ai/schema.js";
import {
  getAiBackportCommentBody,
  getDeveloperHandoffCommentBody,
} from "../src/reporting.js";

const resolution: ResolutionDecision = {
  assumptions: ["The destination enum retains the same meaning."],
  decision: "resolved",
  files: [
    {
      content: "secret proprietary content",
      path: "status.ts",
      reason: "Added the source enum member beside the older branch member.",
    },
  ],
  risks: ["Review enum ordering."],
  summary: "Resolved a one-line enum conflict.",
};

const review: ReviewDecision = {
  decision: "approve",
  findings: [],
  summary: "The resolution is narrow.",
};

describe("getAiBackportCommentBody", () => {
  it("includes the warning and review evidence without file contents", () => {
    const body = getAiBackportCommentBody({
      base: "release",
      model: "small-model",
      provider: "anthropic",
      resolution,
      review,
      sourceCommit: "abc123",
      sourcePullRequestNumber: 42,
      validationCommands: ["yarn test"],
    });

    expect(body).toContain("AI-assisted backport");
    expect(body).toContain("carefully");
    expect(body).toContain("anthropic");
    expect(body).toContain("small-model");
    expect(body).toContain("#42");
    expect(body).toContain("release");
    expect(body).toContain("status.ts");
    expect(body).toContain("yarn test");
    expect(body).toContain("Review enum ordering.");
    expect(body).not.toContain("secret proprietary content");
  });
});

describe("getDeveloperHandoffCommentBody", () => {
  it("includes evidence and reproducible manual commands", () => {
    const body = getDeveloperHandoffCommentBody({
      base: "release",
      conflictPaths: ["status.ts"],
      head: "backport-42-to-release",
      mergeBase: "merge-base",
      reason: "Reviewer rejected the resolution.",
      sourceCommit: "abc123",
      sourceParent: "parent123",
      stage: "AI review",
    });

    expect(body).toContain("AI review");
    expect(body).toContain("Reviewer rejected");
    expect(body).toContain("status.ts");
    expect(body).toContain("abc123");
    expect(body).toContain("parent123");
    expect(body).toContain("merge-base");
    expect(body).toContain("git cherry-pick -x abc123");
    expect(body).toContain("backport-42-to-release");
  });

  it("caps and sanitizes provider errors", () => {
    const body = getDeveloperHandoffCommentBody({
      base: "release",
      conflictPaths: ["status.ts"],
      head: "backport-42-to-release",
      mergeBase: "merge-base",
      reason: `${"x".repeat(2000)} api-key-value`,
      secrets: ["api-key-value"],
      sourceCommit: "abc123",
      sourceParent: "parent123",
      stage: "Provider",
    });

    expect(body).not.toContain("api-key-value");
    expect(body.length).toBeLessThan(2500);
  });
});
