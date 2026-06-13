// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import type { ResolutionDecision, ReviewDecision } from "../src/ai/schema.js";
import type { StructuredModelProvider } from "../src/ai/types.js";
import type { EnabledAiConfig } from "../src/config.js";
import type { ConflictContext } from "../src/conflicts/types.js";
import {
  type BackportDestinationInput,
  type BackportWorkspace,
  backportDestination,
} from "../src/destination.js";

const aiConfig: EnabledAiConfig = {
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

const conflictContext = (path = "status.ts"): ConflictContext => ({
  destinationHead: "destination",
  files: [
    {
      base: "Pending\n",
      blame: "",
      conflictRanges: [{ endLine: 5, startLine: 1 }],
      history: "",
      ours: "Pending\nArchived\n",
      path,
      theirs: "Pending\nActive\n",
      workingTree: "<<<<<<< HEAD\nArchived\n=======\nActive\n>>>>>>> source\n",
    },
  ],
  mergeBase: "merge-base",
  sourceChangedPaths: [path],
  sourceCommit: "source",
  sourceDiff: "+Active",
  sourceParent: "parent",
});

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
  summary: "The resolution is narrow.",
};

const noOp = async (): Promise<void> => undefined;

const modelProvider = (
  outputs: readonly [ResolutionDecision, ReviewDecision],
): StructuredModelProvider => {
  const queue: unknown[] = [...outputs];

  return {
    async generate(request) {
      const output = queue.shift();
      const parsed = request.schema.safeParse(output);

      if (!parsed.success) {
        return {
          category: "invalid-output",
          message: "Invalid test output.",
          ok: false,
        };
      }

      return { data: parsed.data, ok: true };
    },
  };
};

const workspace = ({
  context = conflictContext(),
  status,
}: {
  context?: ConflictContext;
  status: "clean" | "conflicted";
}): BackportWorkspace & {
  calls: string[];
} => {
  const calls: string[] = [];

  return {
    async abort() {
      calls.push("abort");
    },
    async applyAndValidate() {
      calls.push("validate");
      return { valid: true };
    },
    calls,
    async collectContext() {
      calls.push("context");
      return context;
    },
    async completeCherryPick() {
      calls.push("continue");
    },
    async findReusableSibling() {
      calls.push("sibling");
      return undefined;
    },
    async prepare() {
      calls.push("prepare");
    },
    async push() {
      calls.push("push");
    },
    async tryCherryPick() {
      calls.push("cherry-pick");
      return status === "clean"
        ? { status: "clean" }
        : {
            paths: context.files.map(({ path }) => path),
            status: "conflicted",
          };
    },
  };
};

const input = (
  overrides: Partial<BackportDestinationInput> = {},
): BackportDestinationInput => ({
  aiConfig,
  base: "release",
  body: "Backport source from #42.",
  commitSha: "source",
  createProvider: () => modelProvider([resolution, approval]),
  github: {
    addComment: noOp,
    addLabels: noOp,
    createPullRequest: async () => 77,
    findSiblingBackports: async () => [],
  },
  head: "backport-42-to-release",
  labels: [],
  owner: "owner",
  repo: "repo",
  sourcePullRequestNumber: 42,
  title: "Backport title",
  workspace: workspace({ status: "conflicted" }),
  ...overrides,
});

describe("backportDestination", () => {
  it("creates a normal pull request without calling a model", async () => {
    const work = workspace({ status: "clean" });
    let providerCreated = false;
    const pullRequests: boolean[] = [];

    const result = await backportDestination(
      input({
        createProvider() {
          providerCreated = true;
          return modelProvider([resolution, approval]);
        },
        github: {
          addComment: noOp,
          addLabels: noOp,
          async createPullRequest({ draft }) {
            pullRequests.push(draft);
            return 77;
          },
          findSiblingBackports: async () => [],
        },
        workspace: work,
      }),
    );

    expect(result).toEqual({
      base: "release",
      mode: "normal",
      pullRequestNumber: 77,
      status: "created",
    });
    expect(providerCreated).toBe(false);
    expect(pullRequests).toEqual([false]);
    expect(work.calls).toEqual(["prepare", "cherry-pick", "push"]);
  });

  it("creates a labeled draft pull request after AI resolution", async () => {
    const work = workspace({ status: "conflicted" });
    const drafts: boolean[] = [];
    const labels: string[][] = [];
    const comments: number[] = [];

    const result = await backportDestination(
      input({
        github: {
          async addComment({ issueNumber }) {
            comments.push(issueNumber);
          },
          async addLabels({ labels: addedLabels }) {
            labels.push([...addedLabels]);
          },
          async createPullRequest({ draft }) {
            drafts.push(draft);
            return 88;
          },
          findSiblingBackports: async () => [],
        },
        workspace: work,
      }),
    );

    expect(result).toMatchObject({
      mode: "ai",
      pullRequestNumber: 88,
      status: "created",
    });
    expect(drafts).toEqual([true]);
    expect(labels).toEqual([["AI backport"]]);
    expect(comments).toEqual([88]);
    expect(work.calls).toEqual([
      "prepare",
      "cherry-pick",
      "context",
      "sibling",
      "validate",
      "validate",
      "continue",
      "push",
    ]);
  });

  it("escalates a migration conflict without creating a provider", async () => {
    const work = workspace({
      context: conflictContext("data/migrations/setting.ts"),
      status: "conflicted",
    });
    let providerCreated = false;
    const sourceComments: number[] = [];

    const result = await backportDestination(
      input({
        createProvider() {
          providerCreated = true;
          return modelProvider([resolution, approval]);
        },
        github: {
          async addComment({ issueNumber }) {
            sourceComments.push(issueNumber);
          },
          addLabels: noOp,
          createPullRequest: async () => 99,
          findSiblingBackports: async () => [],
        },
        workspace: work,
      }),
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(providerCreated).toBe(false);
    expect(sourceComments).toEqual([42]);
    expect(work.calls).toContain("abort");
  });

  it("escalates reviewer rejection and does not push", async () => {
    const work = workspace({ status: "conflicted" });
    const rejection: ReviewDecision = {
      decision: "reject",
      findings: ["Business behavior is ambiguous."],
      summary: "Developer review required.",
    };

    const result = await backportDestination(
      input({
        createProvider: () => modelProvider([resolution, rejection]),
        workspace: work,
      }),
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(work.calls).toContain("abort");
    expect(work.calls).not.toContain("push");
  });

  it("escalates when a reused sibling resolution fails validation", async () => {
    const work = workspace({ status: "conflicted" });
    let providerCreated = false;
    work.findReusableSibling = async () => ({
      decision: resolution,
      evidence: {
        patchId: "patch-id",
        pullRequestNumber: 41,
      },
    });
    work.applyAndValidate = async () => ({
      reasons: ["Validation commands modified files: status.ts."],
      valid: false,
    });

    const result = await backportDestination(
      input({
        createProvider() {
          providerCreated = true;
          return modelProvider([resolution, approval]);
        },
        workspace: work,
      }),
    );

    expect(result).toMatchObject({
      reason: "Validation commands modified files: status.ts.",
      status: "failed",
    });
    expect(providerCreated).toBe(false);
    expect(work.calls).toContain("abort");
    expect(work.calls).not.toContain("push");
  });
});
