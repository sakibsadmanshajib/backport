import ensureError from "ensure-error";
import { resolveConflictWithAi } from "./ai/resolver.js";
import type { ResolutionDecision } from "./ai/schema.js";
import type { StructuredModelProvider } from "./ai/types.js";
import type { AiConfig, EnabledAiConfig } from "./config.js";
import {
  type ValidationResult,
  evaluateConflictEligibility,
} from "./conflicts/policy.js";
import type { ReusedSiblingResolution } from "./conflicts/sibling-resolution.js";
import type { ConflictContext } from "./conflicts/types.js";
import type { DestinationResult } from "./domain.js";
import type { CherryPickResult } from "./git.js";
import type {
  AddCommentInput,
  AddLabelsInput,
  CreatePullRequestInput,
  FindSiblingBackportsInput,
  SiblingBackportCandidate,
} from "./github.js";
import {
  getAiBackportCommentBody,
  getDeveloperHandoffCommentBody,
} from "./reporting.js";

type BackportGitHub = {
  addComment: (input: AddCommentInput) => Promise<void>;
  addLabels: (input: AddLabelsInput) => Promise<void>;
  createPullRequest: (input: CreatePullRequestInput) => Promise<number>;
  findSiblingBackports: (
    input: FindSiblingBackportsInput,
  ) => Promise<readonly SiblingBackportCandidate[]>;
};

type FindReusableSiblingInput = Readonly<{
  candidates: readonly SiblingBackportCandidate[];
  config: EnabledAiConfig;
  context: ConflictContext;
  sourcePullRequestNumber: number;
}>;

type BackportWorkspace = {
  abort: () => Promise<void>;
  applyAndValidate: (
    decision: ResolutionDecision,
    context: ConflictContext,
    config: EnabledAiConfig,
  ) => Promise<ValidationResult>;
  collectContext: (sourceCommit: string) => Promise<ConflictContext>;
  completeCherryPick: () => Promise<void>;
  findReusableSibling: (
    input: FindReusableSiblingInput,
  ) => Promise<ReusedSiblingResolution | undefined>;
  prepare: (base: string, head: string) => Promise<void>;
  push: (head: string) => Promise<void>;
  tryCherryPick: (sourceCommit: string) => Promise<CherryPickResult>;
};

type BackportDestinationInput = Readonly<{
  aiConfig: AiConfig;
  base: string;
  body: string;
  commitSha: string;
  createProvider: (config: EnabledAiConfig) => StructuredModelProvider;
  github: BackportGitHub;
  head: string;
  labels: readonly string[];
  owner: string;
  repo: string;
  sourcePullRequestNumber: number;
  title: string;
  workspace: BackportWorkspace;
}>;

const createPullRequest = async ({
  base,
  body,
  draft,
  github,
  head,
  labels,
  owner,
  repo,
  title,
}: Pick<
  BackportDestinationInput,
  "base" | "body" | "github" | "head" | "labels" | "owner" | "repo" | "title"
> & {
  draft: boolean;
}): Promise<number> => {
  const pullRequestNumber = await github.createPullRequest({
    base,
    body,
    draft,
    head,
    owner,
    repo,
    title,
  });
  await github.addLabels({
    issueNumber: pullRequestNumber,
    labels,
    owner,
    repo,
  });
  return pullRequestNumber;
};

const backportDestination = async (
  input: BackportDestinationInput,
): Promise<DestinationResult> => {
  const {
    aiConfig,
    base,
    body,
    commitSha,
    createProvider,
    github,
    head,
    labels,
    owner,
    repo,
    sourcePullRequestNumber,
    title,
    workspace,
  } = input;
  let context: ConflictContext | undefined;

  const fail = async (
    stage: string,
    reason: string,
  ): Promise<DestinationResult> => {
    await workspace.abort();
    await github.addComment({
      body:
        context === undefined
          ? `The backport to \`${base}\` failed during ${stage}: ${reason}`
          : getDeveloperHandoffCommentBody({
              base,
              conflictPaths: context.files.map(({ path }) => path),
              head,
              mergeBase: context.mergeBase,
              reason,
              secrets: aiConfig.enabled ? [aiConfig.apiKey] : [],
              sourceCommit: context.sourceCommit,
              sourceParent: context.sourceParent,
              stage,
            }),
      issueNumber: sourcePullRequestNumber,
      owner,
      repo,
    });
    return { base, reason, status: "failed" };
  };

  try {
    await workspace.prepare(base, head);
    const cherryPick = await workspace.tryCherryPick(commitSha);

    if (cherryPick.status === "clean") {
      await workspace.push(head);
      const pullRequestNumber = await createPullRequest({
        base,
        body,
        draft: false,
        github,
        head,
        labels,
        owner,
        repo,
        title,
      });
      return {
        base,
        mode: "normal",
        pullRequestNumber,
        status: "created",
      };
    }

    const conflictContext = await workspace.collectContext(commitSha);
    context = conflictContext;

    if (!aiConfig.enabled) {
      return await fail(
        "normal cherry-pick",
        "AI conflict resolution is disabled.",
      );
    }

    const eligibility = evaluateConflictEligibility(conflictContext, aiConfig);

    if (!eligibility.eligible) {
      return await fail("eligibility policy", eligibility.reasons.join(" "));
    }

    const candidates = await github.findSiblingBackports({
      owner,
      repo,
      sourceCommit: commitSha,
      sourcePullRequestNumber,
    });
    const sibling = await workspace.findReusableSibling({
      candidates,
      config: aiConfig,
      context: conflictContext,
      sourcePullRequestNumber,
    });

    if (sibling) {
      const validation = await workspace.applyAndValidate(
        sibling.decision,
        conflictContext,
        aiConfig,
      );

      if (validation.valid) {
        await workspace.completeCherryPick();
        await workspace.push(head);
        const pullRequestNumber = await createPullRequest({
          base,
          body,
          draft: false,
          github,
          head,
          labels,
          owner,
          repo,
          title,
        });
        return {
          base,
          mode: "sibling",
          pullRequestNumber,
          status: "created",
        };
      }

      return await fail(
        "sibling resolution validation",
        validation.reasons.join(" "),
      );
    }

    const outcome = await resolveConflictWithAi({
      config: aiConfig,
      context: conflictContext,
      provider: createProvider(aiConfig),
      validateCandidate: async (decision) =>
        workspace.applyAndValidate(decision, conflictContext, aiConfig),
    });

    if (outcome.status === "escalated") {
      return await fail("AI conflict resolution", outcome.reason);
    }

    await workspace.completeCherryPick();
    await workspace.push(head);
    const pullRequestNumber = await createPullRequest({
      base,
      body,
      draft: true,
      github,
      head,
      labels: [...labels, aiConfig.label],
      owner,
      repo,
      title,
    });
    await github.addComment({
      body: getAiBackportCommentBody({
        base,
        model: aiConfig.model,
        provider: aiConfig.provider,
        resolution: outcome.decision,
        review: outcome.review,
        sourceCommit: commitSha,
        sourcePullRequestNumber,
        validationCommands: aiConfig.validationCommands,
      }),
      issueNumber: pullRequestNumber,
      owner,
      repo,
    });
    return {
      base,
      mode: "ai",
      pullRequestNumber,
      status: "created",
    };
  } catch (error: unknown) {
    return fail("backport orchestration", ensureError(error).message);
  }
};

export {
  backportDestination,
  type BackportDestinationInput,
  type BackportGitHub,
  type BackportWorkspace,
  type FindReusableSiblingInput,
};
