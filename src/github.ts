import { z } from "zod";

type SiblingBackportCandidate = Readonly<{
  baseSha: string;
  changedPaths: readonly string[];
  merged: boolean;
  number: number;
  resultSha: string;
  sourceCommit: string;
  sourcePullRequestNumber: number;
}>;

type GitHubRequestParameters = { [key: string]: unknown };

type GitHubRequestClient = {
  paginate: (
    route: string,
    parameters?: GitHubRequestParameters,
  ) => Promise<unknown[]>;
  request: (
    route: string,
    parameters: GitHubRequestParameters,
  ) => Promise<{ data: unknown }>;
};

type RepositoryCoordinates = Readonly<{
  owner: string;
  repo: string;
}>;

type CreatePullRequestInput = RepositoryCoordinates &
  Readonly<{
    base: string;
    body: string;
    draft: boolean;
    head: string;
    title: string;
  }>;

type AddLabelsInput = RepositoryCoordinates &
  Readonly<{
    issueNumber: number;
    labels: readonly string[];
  }>;

type AddCommentInput = RepositoryCoordinates &
  Readonly<{
    body: string;
    issueNumber: number;
  }>;

type FindSiblingBackportsInput = RepositoryCoordinates &
  Readonly<{
    sourceCommit: string;
    sourcePullRequestNumber: number;
  }>;

const pullRequestNumberSchema = z.object({
  number: z.number().int().positive(),
});
const searchResultSchema = z.object({
  items: z.array(
    z.object({
      body: z
        .string()
        .nullable()
        .transform((body) => body ?? ""),
      number: z.number().int().positive(),
      pull_request: z.unknown(),
    }),
  ),
});
const pullRequestSchema = z.object({
  base: z.object({ sha: z.string().min(1) }),
  head: z.object({ sha: z.string().min(1) }),
  merge_commit_sha: z.string().min(1).nullable(),
  merged_at: z.string().min(1).nullable(),
});
const pullRequestFilesSchema = z.array(
  z.object({ filename: z.string().min(1) }),
);

class GitHubGateway {
  readonly #client: GitHubRequestClient;

  constructor(client: GitHubRequestClient) {
    this.#client = client;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<number> {
    const response = await this.#client.request(
      "POST /repos/{owner}/{repo}/pulls",
      input,
    );
    return pullRequestNumberSchema.parse(response.data).number;
  }

  async addLabels({
    issueNumber,
    labels,
    owner,
    repo,
  }: AddLabelsInput): Promise<void> {
    if (labels.length === 0) {
      return;
    }

    await this.#client.request(
      "PUT /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        issue_number: issueNumber,
        labels: [...labels],
        owner,
        repo,
      },
    );
  }

  async addComment({
    body,
    issueNumber,
    owner,
    repo,
  }: AddCommentInput): Promise<void> {
    await this.#client.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        body,
        issue_number: issueNumber,
        owner,
        repo,
      },
    );
  }

  async findSiblingBackports({
    owner,
    repo,
    sourceCommit,
    sourcePullRequestNumber,
  }: FindSiblingBackportsInput): Promise<readonly SiblingBackportCandidate[]> {
    const searchItems = await this.#client.paginate("GET /search/issues", {
      per_page: 100,
      q: `repo:${owner}/${repo} is:pr "${sourceCommit}" "#${sourcePullRequestNumber}"`,
    });
    const searchResult = searchResultSchema.parse({ items: searchItems });
    const expectedReference = `#${sourcePullRequestNumber}`;
    const matchingItems = searchResult.items.filter(
      (item) =>
        item.number !== sourcePullRequestNumber &&
        item.body.includes(sourceCommit) &&
        item.body.includes(expectedReference),
    );
    const candidates = await Promise.all(
      matchingItems.map(async (item) => {
        const [pullResponse, filesData] = await Promise.all([
          this.#client.request(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}",
            {
              owner,
              pull_number: item.number,
              repo,
            },
          ),
          this.#client.paginate(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
            {
              owner,
              per_page: 100,
              pull_number: item.number,
              repo,
            },
          ),
        ]);
        const pull = pullRequestSchema.parse(pullResponse.data);

        if (pull.merged_at === null) {
          return;
        }

        const files = pullRequestFilesSchema.parse(filesData);

        const candidate: SiblingBackportCandidate = {
          baseSha: pull.base.sha,
          changedPaths: files.map(({ filename }) => filename),
          merged: true,
          number: item.number,
          resultSha: pull.merge_commit_sha ?? pull.head.sha,
          sourceCommit,
          sourcePullRequestNumber,
        };

        return candidate;
      }),
    );

    return candidates.filter(
      (candidate): candidate is SiblingBackportCandidate =>
        candidate !== undefined,
    );
  }
}

export {
  GitHubGateway,
  type AddCommentInput,
  type AddLabelsInput,
  type CreatePullRequestInput,
  type FindSiblingBackportsInput,
  type GitHubRequestClient,
  type GitHubRequestParameters,
  type RepositoryCoordinates,
  type SiblingBackportCandidate,
};
