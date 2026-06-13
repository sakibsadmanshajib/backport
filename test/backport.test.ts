// eslint-disable-next-line import/no-extraneous-dependencies
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backport } from "../src/backport.js";
import type { AiConfig } from "../src/config.js";
import { backportDestination } from "../src/destination.js";
import type { DestinationResult } from "../src/domain.js";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before imports execute
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  group: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/exec", () => ({
  exec: vi.fn(async () => 0),
}));

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn(() => ({
    paginate: vi.fn(async () => []),
    request: vi.fn(async () => ({
      data: { allow_merge_commit: false, allow_rebase_merge: false },
    })),
  })),
}));

vi.mock("../src/git.js", () => ({
  GitRepository: vi.fn().mockImplementation(() => ({
    configureIdentity: vi.fn(async () => undefined),
  })),
}));

vi.mock("../src/workspace.js", () => ({
  GitBackportWorkspace: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/github.js", () => ({
  GitHubGateway: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/destination.js", () => ({
  backportDestination: vi.fn(),
}));

vi.mock("../src/ai/provider.js", () => ({
  createModelProvider: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockBackportDestination = vi.mocked(backportDestination);

// ---------------------------------------------------------------------------
// Payload factories
// ---------------------------------------------------------------------------

const basePullRequest = {
  body: "Fixes #1",
  labels: [{ name: "backport release" }, { name: "other-label" }],
  merge_commit_sha: "abc123",
  merged: true,
  number: 42,
  title: "Fix the thing",
};

const baseRepository = {
  clone_url: "https://github.com/owner/repo.git",
  name: "repo",
  owner: { login: "owner" },
};

const closedPayload = (
  overrides: Partial<typeof basePullRequest> = {},
): {
  pull_request: typeof basePullRequest & Partial<typeof basePullRequest>;
  repository: typeof baseRepository;
} => ({
  pull_request: { ...basePullRequest, ...overrides },
  repository: baseRepository,
});

const labeledPayload = (
  labelName: string,
): {
  label: { name: string };
  pull_request: typeof basePullRequest;
  repository: typeof baseRepository;
} => ({
  label: { name: labelName },
  pull_request: basePullRequest,
  repository: baseRepository,
});

// ---------------------------------------------------------------------------
// Shared config / helpers
// ---------------------------------------------------------------------------

const disabledAiConfig: AiConfig = { enabled: false };

const enabledAiConfig: AiConfig = {
  apiKey: "key",
  enabled: true,
  forbiddenPatterns: [],
  immutablePatterns: ["**/migrations/**"],
  label: "AI backport",
  maxConflictedFiles: 3,
  maxResolutionLines: 60,
  model: "claude-3",
  provider: "anthropic",
  timeoutMs: 120_000,
  validationCommands: [],
};

const labelRegExp = /^backport (?<base>.+)$/u;

const identityGetters = {
  getBody: ({
    body,
  }: Readonly<{
    base: string;
    body: string;
    mergeCommitSha: string;
    number: number;
  }>) => body,
  getHead: ({ base, number }: Readonly<{ base: string; number: number }>) =>
    `backport-${number}-to-${base}`,
  getLabels: ({
    labels,
  }: Readonly<{ base: string; labels: readonly string[] }>) => [...labels],
  getTitle: ({
    title,
  }: Readonly<{ base: string; number: number; title: string }>) => title,
};

const createdResult = (base: string): DestinationResult => ({
  base,
  mode: "normal",
  pullRequestNumber: 99,
  status: "created",
});

const failedResult = (base: string): DestinationResult => ({
  base,
  reason: "cherry-pick conflict",
  status: "failed",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

describe("backport", () => {
  describe("pre-flight guard", () => {
    it("throws when pull request is not merged", async () => {
      await expect(
        backport({
          ...identityGetters,
          aiConfig: disabledAiConfig,
          labelRegExp,
          payload: closedPayload({ merged: false }) as never,
          token: "tok",
        }),
      ).rejects.toThrow("only run on merged PRs");
    });

    it("throws when merge_commit_sha is null", async () => {
      await expect(
        backport({
          ...identityGetters,
          aiConfig: disabledAiConfig,
          labelRegExp,
          payload: closedPayload({
            merge_commit_sha: null as unknown as string,
          }) as never,
          token: "tok",
        }),
      ).rejects.toThrow("only run on merged PRs");
    });
  });

  describe("no matching labels", () => {
    it("returns empty result when closed PR has no matching labels", async () => {
      const result = await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: closedPayload({
          labels: [{ name: "unrelated" }],
        }) as never,
        token: "tok",
      });

      expect(result).toEqual({
        createdPullRequests: {},
        destinations: [],
      });
      expect(mockBackportDestination).not.toHaveBeenCalled();
    });

    it("returns empty result when labeled event label does not match", async () => {
      const result = await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: labeledPayload("unrelated-label") as never,
        token: "tok",
      });

      expect(result).toEqual({
        createdPullRequests: {},
        destinations: [],
      });
      expect(mockBackportDestination).not.toHaveBeenCalled();
    });
  });

  describe("labeled event (single destination)", () => {
    beforeEach(() => {
      mockBackportDestination.mockResolvedValue(createdResult("release"));
    });

    it("extracts base from label and returns created pull request", async () => {
      const result = await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      expect(result).toEqual({
        createdPullRequests: { release: 99 },
        destinations: [createdResult("release")],
      });
      expect(mockBackportDestination).toHaveBeenCalledOnce();
    });

    it("passes correct base, head, and commit sha to backportDestination", async () => {
      await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      const call = mockBackportDestination.mock.calls[0]?.[0];
      expect(call?.base).toBe("release");
      expect(call?.commitSha).toBe("abc123");
      expect(call?.sourcePullRequestNumber).toBe(42);
      expect(call?.owner).toBe("owner");
      expect(call?.repo).toBe("repo");
    });

    it("filters backport labels from getLabels input", async () => {
      const capturedLabels: string[][] = [];

      await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        getLabels({ labels }) {
          capturedLabels.push([...labels]);
          return [...labels];
        },
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      // The backport label itself must be stripped before passing to getLabels
      expect(capturedLabels[0]).not.toContain("backport release");
    });
  });

  describe("closed event (multiple destinations)", () => {
    it("backports to all matching labels in order", async () => {
      mockBackportDestination
        .mockResolvedValueOnce(createdResult("v1"))
        .mockResolvedValueOnce(createdResult("v2"));

      const payload = closedPayload({
        labels: [
          { name: "backport v1" },
          { name: "backport v2" },
          { name: "other" },
        ],
      });

      const result = await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: payload as never,
        token: "tok",
      });

      expect(result.destinations).toHaveLength(2);
      expect(result.createdPullRequests).toEqual({ v1: 99, v2: 99 });
      expect(mockBackportDestination).toHaveBeenCalledTimes(2);
    });

    it("includes failed destinations in result and excludes them from createdPullRequests", async () => {
      mockBackportDestination
        .mockResolvedValueOnce(createdResult("v1"))
        .mockResolvedValueOnce(failedResult("v2"));

      const payload = closedPayload({
        labels: [{ name: "backport v1" }, { name: "backport v2" }],
      });

      const result = await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: payload as never,
        token: "tok",
      });

      expect(result.destinations).toHaveLength(2);
      expect(result.createdPullRequests).toEqual({ v1: 99 });
      expect(result.destinations[1]).toMatchObject({
        base: "v2",
        status: "failed",
      });
    });

    it("returns empty createdPullRequests when all destinations fail", async () => {
      mockBackportDestination.mockResolvedValue(failedResult("v1"));

      const payload = closedPayload({
        labels: [{ name: "backport v1" }],
      });

      const result = await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: payload as never,
        token: "tok",
      });

      expect(result.createdPullRequests).toEqual({});
      expect(result.destinations).toHaveLength(1);
    });
  });

  describe("AI config logging", () => {
    it("does not log AI info when AI is disabled", async () => {
      const { info } = await import("@actions/core");
      const mockInfo = vi.mocked(info);
      mockBackportDestination.mockResolvedValue(createdResult("release"));

      await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      const aiInfoCalls = mockInfo.mock.calls.filter(([message]) =>
        String(message).includes("AI conflict fallback"),
      );
      expect(aiInfoCalls).toHaveLength(0);
    });

    it("logs AI provider info when AI is enabled", async () => {
      const { info } = await import("@actions/core");
      const mockInfo = vi.mocked(info);
      mockBackportDestination.mockResolvedValue(createdResult("release"));

      await backport({
        ...identityGetters,
        aiConfig: enabledAiConfig,
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      const aiInfoCalls = mockInfo.mock.calls.filter(([message]) =>
        String(message).includes("AI conflict fallback"),
      );
      expect(aiInfoCalls).toHaveLength(1);
    });
  });

  describe("squash-only warning", () => {
    it("warns when repository allows merge commits", async () => {
      const { getOctokit } = await import("@actions/github");
      const { warning } = await import("@actions/core");
      vi.mocked(getOctokit).mockReturnValue({
        paginate: vi.fn(async () => []),
        request: vi.fn(async () => ({
          data: { allow_merge_commit: true, allow_rebase_merge: false },
        })),
      } as never);
      mockBackportDestination.mockResolvedValue(createdResult("release"));

      await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      expect(vi.mocked(warning)).toHaveBeenCalledOnce();
    });

    it("warns when repository allows rebase merging", async () => {
      const { getOctokit } = await import("@actions/github");
      const { warning } = await import("@actions/core");
      vi.mocked(getOctokit).mockReturnValue({
        paginate: vi.fn(async () => []),
        request: vi.fn(async () => ({
          data: { allow_merge_commit: false, allow_rebase_merge: true },
        })),
      } as never);
      mockBackportDestination.mockResolvedValue(createdResult("release"));

      await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      expect(vi.mocked(warning)).toHaveBeenCalledOnce();
    });

    it("does not warn when only squash merging is allowed", async () => {
      const { getOctokit } = await import("@actions/github");
      const { warning } = await import("@actions/core");
      vi.mocked(getOctokit).mockReturnValue({
        paginate: vi.fn(async () => []),
        request: vi.fn(async () => ({
          data: { allow_merge_commit: false, allow_rebase_merge: false },
        })),
      } as never);
      mockBackportDestination.mockResolvedValue(createdResult("release"));

      await backport({
        ...identityGetters,
        aiConfig: disabledAiConfig,
        labelRegExp,
        payload: labeledPayload("backport release") as never,
        token: "tok",
      });

      expect(vi.mocked(warning)).not.toHaveBeenCalled();
    });
  });

  describe("label regex named-group validation", () => {
    it("throws when regexp matches but has no base named group", async () => {
      const badRegExp = /^backport (?<branch>.+)$/u;

      mockBackportDestination.mockResolvedValue(createdResult("release"));

      await expect(
        backport({
          ...identityGetters,
          aiConfig: disabledAiConfig,
          labelRegExp: badRegExp,
          payload: labeledPayload("backport release") as never,
          token: "tok",
        }),
      ).rejects.toThrow('missed a "base" named capturing group');
    });
  });
});
