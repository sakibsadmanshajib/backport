// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  GitHubGateway,
  type GitHubRequestClient,
  type GitHubRequestParameters,
} from "../src/github.js";

describe("GitHubGateway", () => {
  it("creates draft pull requests and adds labels and comments", async () => {
    const calls: Array<{
      parameters: GitHubRequestParameters;
      route: string;
    }> = [];
    const client: GitHubRequestClient = {
      async paginate(route) {
        throw new Error(`Unexpected paginate: ${route}`);
      },
      async request(route, parameters) {
        calls.push({ parameters, route });
        return { data: route.includes("/pulls") ? { number: 77 } : {} };
      },
    };
    const gateway = new GitHubGateway(client);

    await expect(
      gateway.createPullRequest({
        base: "release",
        body: "Backport body",
        draft: true,
        head: "backport-42-to-release",
        owner: "owner",
        repo: "repo",
        title: "Backport title",
      }),
    ).resolves.toBe(77);
    await gateway.addLabels({
      issueNumber: 77,
      labels: ["AI backport"],
      owner: "owner",
      repo: "repo",
    });
    await gateway.addComment({
      body: "Review carefully.",
      issueNumber: 77,
      owner: "owner",
      repo: "repo",
    });

    expect(calls.map(({ route }) => route)).toEqual([
      "POST /repos/{owner}/{repo}/pulls",
      "PUT /repos/{owner}/{repo}/issues/{issue_number}/labels",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    ]);
    expect(calls[0]?.parameters.draft).toBe(true);
  });

  it("finds only merged backports referencing the exact source", async () => {
    const client: GitHubRequestClient = {
      async paginate(route) {
        if (route === "GET /search/issues") {
          return [
            {
              body: "Backport source-sha from #42.",
              number: 101,
              pull_request: {},
            },
            {
              body: "Unrelated pull request.",
              number: 102,
              pull_request: {},
            },
          ];
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return [{ filename: "status.ts" }];
        }

        throw new Error(`Unexpected paginate route: ${route}`);
      },
      async request(route) {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              base: { sha: "base-sha" },
              head: { sha: "head-sha" },
              merge_commit_sha: "result-sha",
              merged_at: "2026-06-12T00:00:00Z",
            },
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const gateway = new GitHubGateway(client);

    await expect(
      gateway.findSiblingBackports({
        owner: "owner",
        repo: "repo",
        sourceCommit: "source-sha",
        sourcePullRequestNumber: 42,
      }),
    ).resolves.toEqual([
      {
        baseSha: "base-sha",
        changedPaths: ["status.ts"],
        merged: true,
        number: 101,
        resultSha: "result-sha",
        sourceCommit: "source-sha",
        sourcePullRequestNumber: 42,
      },
    ]);
  });

  it("skips the labels request when the labels array is empty", async () => {
    const calls: Array<{ route: string }> = [];
    const client: GitHubRequestClient = {
      async paginate(route) {
        throw new Error(`Unexpected paginate: ${route}`);
      },
      async request(route) {
        calls.push({ route });
        return { data: {} };
      },
    };
    const gateway = new GitHubGateway(client);

    await gateway.addLabels({
      issueNumber: 1,
      labels: [],
      owner: "owner",
      repo: "repo",
    });

    expect(calls).toHaveLength(0);
  });

  it("excludes unmerged pull requests from sibling backport results", async () => {
    const client: GitHubRequestClient = {
      async paginate(route) {
        if (route === "GET /search/issues") {
          return [
            {
              body: "Backport source-sha from #42.",
              number: 201,
              pull_request: {},
            },
          ];
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return [{ filename: "status.ts" }];
        }

        throw new Error(`Unexpected paginate route: ${route}`);
      },
      async request(route) {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              base: { sha: "base-sha" },
              head: { sha: "head-sha" },
              merge_commit_sha: null,
              merged_at: null,
            },
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const gateway = new GitHubGateway(client);

    const results = await gateway.findSiblingBackports({
      owner: "owner",
      repo: "repo",
      sourceCommit: "source-sha",
      sourcePullRequestNumber: 42,
    });

    expect(results).toHaveLength(0);
  });

  it("falls back to head sha when merge_commit_sha is null for a merged pull request", async () => {
    const client: GitHubRequestClient = {
      async paginate(route) {
        if (route === "GET /search/issues") {
          return [
            {
              body: "Backport source-sha from #42.",
              number: 202,
              pull_request: {},
            },
          ];
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return [{ filename: "status.ts" }];
        }

        throw new Error(`Unexpected paginate route: ${route}`);
      },
      async request(route) {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              base: { sha: "base-sha" },
              head: { sha: "head-sha" },
              merge_commit_sha: null,
              merged_at: "2026-06-12T00:00:00Z",
            },
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const gateway = new GitHubGateway(client);

    const results = await gateway.findSiblingBackports({
      owner: "owner",
      repo: "repo",
      sourceCommit: "source-sha",
      sourcePullRequestNumber: 42,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.resultSha).toBe("head-sha");
  });

  it("aggregates all pages from sibling search and changed-files when results exceed one page", async () => {
    const page1SearchItems = Array.from({ length: 100 }, (_, i) => ({
      body: `Backport source-sha from #42.`,
      number: 200 + i,
      pull_request: {},
    }));
    const page2SearchItems = [
      {
        body: "Backport source-sha from #42.",
        number: 301,
        pull_request: {},
      },
    ];
    const allSearchItems = [...page1SearchItems, ...page2SearchItems];

    const page1Files = Array.from({ length: 100 }, (_, i) => ({
      filename: `file${i}.ts`,
    }));
    const page2Files = [{ filename: "extra.ts" }];
    const allFiles = [...page1Files, ...page2Files];

    const client: GitHubRequestClient = {
      async paginate(route) {
        if (route === "GET /search/issues") {
          return allSearchItems;
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return allFiles;
        }

        throw new Error(`Unexpected paginate route: ${route}`);
      },
      async request(route) {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              base: { sha: "base-sha" },
              head: { sha: "head-sha" },
              merge_commit_sha: "result-sha",
              merged_at: "2026-06-12T00:00:00Z",
            },
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const gateway = new GitHubGateway(client);

    const results = await gateway.findSiblingBackports({
      owner: "owner",
      repo: "repo",
      sourceCommit: "source-sha",
      sourcePullRequestNumber: 42,
    });

    expect(results).toHaveLength(101);
    expect(results[100]).toMatchObject({
      changedPaths: allFiles.map(({ filename }) => filename),
      number: 301,
    });
  });
});
