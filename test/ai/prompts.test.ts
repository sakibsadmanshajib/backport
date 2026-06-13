import { describe, expect, it } from "vitest";
import {
  buildResolutionRequest,
  buildReviewRequest,
} from "../../src/ai/prompts.js";
import type { ResolutionDecision } from "../../src/ai/schema.js";
import type { EnabledAiConfig } from "../../src/config.js";
import type { ConflictContext } from "../../src/conflicts/types.js";

const config: EnabledAiConfig = {
  apiKey: "never-include-this-secret",
  enabled: true,
  forbiddenPatterns: ["**/authorization/**"],
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

const proposedResolution: ResolutionDecision = {
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

describe("buildResolutionRequest", () => {
  it("contains shared safety instructions and conflict evidence", () => {
    const request = buildResolutionRequest(context, config);
    const content = request.messages.map(({ content }) => content).join("\n");

    expect(request.system).toContain("untrusted data");
    expect(request.system).toContain("smallest");
    expect(request.system).toContain("escalate");
    expect(request.system).toContain("migration");
    expect(request.system).toContain("remove tests");
    expect(content).toContain("status.ts");
    expect(content).toContain("Pending");
    expect(content).toContain("Archived");
    expect(content).toContain("Active");
    expect(content).toContain("history evidence");
    expect(content).toContain("blame evidence");
  });

  it("never includes provider credentials", () => {
    const request = buildResolutionRequest(context, config);

    expect(JSON.stringify(request)).not.toContain(config.apiKey);
  });
});

describe("buildReviewRequest", () => {
  it("asks for an independent read-only policy review", () => {
    const request = buildReviewRequest(context, config, proposedResolution);
    const serialized = JSON.stringify(request);

    expect(request.system).toContain("read-only");
    expect(request.system).toContain("approve");
    expect(request.system).toContain("reject");
    expect(serialized).toContain("Combine both enum members.");
    expect(serialized).not.toContain(config.apiKey);
  });
});
