import { group, info, warning } from "@actions/core";
import { exec } from "@actions/exec";
import { getOctokit } from "@actions/github";
import type {
  PullRequestClosedEvent,
  PullRequestLabeledEvent,
} from "@octokit/webhooks-types";
import { compact } from "lodash-es";
import { createModelProvider } from "./ai/provider.js";
import type { AiConfig } from "./config.js";
import { backportDestination } from "./destination.js";
import type { DestinationResult } from "./domain.js";
import { GitRepository } from "./git.js";
import { GitHubGateway, type GitHubRequestClient } from "./github.js";
import { GitBackportWorkspace } from "./workspace.js";

const getBaseBranchFromLabel = (
  label: string,
  labelRegExp: RegExp,
): string | undefined => {
  const result = labelRegExp.exec(label);

  if (!result?.groups) {
    return;
  }

  const { base } = result.groups;

  if (!base) {
    throw new Error(
      `RegExp "${String(
        labelRegExp,
      )}" matched "${label}" but missed a "base" named capturing group.`,
    );
  }

  return base;
};

const getBaseBranches = ({
  labelRegExp,
  payload,
}: Readonly<{
  labelRegExp: RegExp;
  payload: PullRequestClosedEvent | PullRequestLabeledEvent;
}>): string[] => {
  if ("label" in payload) {
    const base = getBaseBranchFromLabel(payload.label.name, labelRegExp);
    return base ? [base] : [];
  }

  return compact(
    payload.pull_request.labels.map((label) =>
      getBaseBranchFromLabel(label.name, labelRegExp),
    ),
  );
};

const warnIfSquashIsNotTheOnlyAllowedMergeMethod = async ({
  github,
  owner,
  repo,
}: {
  github: {
    request: (
      route: string,
      parameters: { [key: string]: unknown },
    ) => Promise<{
      // Fields from the GitHub REST GET /repos/{owner}/{repo} response.
      data: {
        allow_merge_commit?: boolean | null;
        allow_rebase_merge?: boolean | null;
        allow_squash_merge?: boolean | null;
      };
    }>;
  };
  owner: string;
  repo: string;
}) => {
  const {
    data: { allow_merge_commit, allow_rebase_merge },
  } = await github.request("GET /repos/{owner}/{repo}", { owner, repo });

  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (allow_merge_commit || allow_rebase_merge) {
    warning(
      [
        "Your repository allows merge commits and rebase merging.",
        " However, Backport only supports rebased and merged pull requests with a single commit and squashed and merged pull requests.",
        " Consider only allowing squash merging.",
        " See https://help.github.com/en/github/administering-a-repository/about-merge-methods-on-github for more information.",
      ].join("\n"),
    );
  }
};

type BackportResult = Readonly<{
  createdPullRequests: Readonly<{ [base: string]: number }>;
  destinations: readonly DestinationResult[];
}>;

const backport = async ({
  aiConfig,
  getBody,
  getHead,
  getLabels,
  getTitle,
  labelRegExp,
  payload,
  token,
}: {
  aiConfig: AiConfig;
  getBody: (
    props: Readonly<{
      base: string;
      body: string;
      mergeCommitSha: string;
      number: number;
    }>,
  ) => string;
  getHead: (
    props: Readonly<{
      base: string;
      number: number;
    }>,
  ) => string;
  getLabels: (
    props: Readonly<{
      base: string;
      labels: readonly string[];
    }>,
  ) => string[];
  getTitle: (
    props: Readonly<{
      base: string;
      number: number;
      title: string;
    }>,
  ) => string;
  labelRegExp: RegExp;
  payload: PullRequestClosedEvent | PullRequestLabeledEvent;
  token: string;
}): Promise<BackportResult> => {
  const {
    pull_request: {
      body: originalBody,
      labels: originalLabels,
      merge_commit_sha: mergeCommitSha,
      merged,
      number,
      title: originalTitle,
    },
    repository: {
      name: repo,
      owner: { login: owner },
    },
  } = payload;

  if (merged !== true || !mergeCommitSha) {
    throw new Error(
      "For security reasons, this action should only run on merged PRs.",
    );
  }

  const baseBranches = getBaseBranches({ labelRegExp, payload });

  if (baseBranches.length === 0) {
    info("No backports required.");
    return { createdPullRequests: {}, destinations: [] };
  }

  const octokit = getOctokit(token);
  await warnIfSquashIsNotTheOnlyAllowedMergeMethod({
    github: octokit,
    owner,
    repo,
  });

  info(`Backporting ${mergeCommitSha} from #${number}.`);

  if (aiConfig.enabled) {
    info(
      `AI conflict fallback enabled with ${aiConfig.provider}/${aiConfig.model}.`,
    );
  }

  const cloneUrl = new URL(payload.repository.clone_url);
  cloneUrl.username = "x-access-token";
  cloneUrl.password = token;

  await exec("git", ["clone", cloneUrl.toString()]);

  const git = new GitRepository(repo);
  await git.configureIdentity(
    "github-actions[bot]",
    "github-actions[bot]@users.noreply.github.com",
  );
  const workspace = new GitBackportWorkspace(git);
  const requestClient: GitHubRequestClient = {
    async paginate(route, parameters) {
      return octokit.paginate(route, parameters);
    },
    async request(route, parameters) {
      const response = await octokit.request(route, parameters);
      return { data: response.data };
    },
  };
  const github = new GitHubGateway(requestClient);
  const destinations: DestinationResult[] = [];

  for (const base of baseBranches) {
    const body = getBody({
      base,
      body: originalBody ?? "",
      mergeCommitSha,
      number,
    });
    const head = getHead({ base, number });
    const labels = getLabels({
      base,
      labels: originalLabels
        .map(({ name }) => name)
        .filter((label) => !labelRegExp.test(label)),
    });
    const title = getTitle({ base, number, title: originalTitle });

    // Branches are handled sequentially to keep Git state isolated.
    // eslint-disable-next-line no-await-in-loop
    const destination = await group(
      `Backporting to ${base} on ${head}.`,
      async () =>
        backportDestination({
          aiConfig,
          base,
          body,
          commitSha: mergeCommitSha,
          createProvider: createModelProvider,
          github,
          head,
          labels,
          owner,
          repo,
          sourcePullRequestNumber: number,
          title,
          workspace,
        }),
    );
    destinations.push(destination);

    if (destination.status === "created") {
      info(`PR #${destination.pullRequestNumber} has been created.`);
    }
  }

  const createdPullRequests = Object.fromEntries(
    destinations
      .filter(
        (
          destination,
        ): destination is Extract<DestinationResult, { status: "created" }> =>
          destination.status === "created",
      )
      .map(({ base, pullRequestNumber }) => [base, pullRequestNumber]),
  );

  return { createdPullRequests, destinations };
};

export { backport, type BackportResult };
