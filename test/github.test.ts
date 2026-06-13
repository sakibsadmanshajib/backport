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
      async request(route) {
        if (route === "GET /search/issues") {
          return {
            data: {
              items: [
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
              ],
            },
          };
        }

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

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return { data: [{ filename: "status.ts" }] };
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
});
