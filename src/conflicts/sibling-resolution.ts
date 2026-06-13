import type { ResolutionDecision } from "../ai/schema.js";
import type { EnabledAiConfig } from "../config.js";
import type { SiblingBackportCandidate } from "../github.js";
import { isProtectedPath } from "./policy.js";
import type { ConflictContext } from "./types.js";

type SiblingResolutionRepository = {
  showOptional: (revisionAndPath: string) => Promise<string | undefined>;
  stablePatchId: (commitSha: string) => Promise<string>;
};

type ReusedSiblingResolution = Readonly<{
  decision: ResolutionDecision;
  evidence: Readonly<{
    patchId: string;
    pullRequestNumber: number;
  }>;
}>;

type FindReusableSiblingInput = Readonly<{
  candidates: readonly SiblingBackportCandidate[];
  config: EnabledAiConfig;
  context: ConflictContext;
  repository: SiblingResolutionRepository;
  sourcePullRequestNumber: number;
}>;

const evaluateCandidate = async ({
  candidate,
  config,
  context,
  repository,
  sourcePullRequestNumber,
}: Omit<FindReusableSiblingInput, "candidates"> & {
  candidate: SiblingBackportCandidate;
}): Promise<ReusedSiblingResolution | undefined> => {
  if (
    !candidate.merged ||
    candidate.sourceCommit !== context.sourceCommit ||
    candidate.sourcePullRequestNumber !== sourcePullRequestNumber
  ) {
    return;
  }

  const sourcePaths = new Set(context.sourceChangedPaths);

  if (
    candidate.changedPaths.some(
      (path) => !sourcePaths.has(path) || isProtectedPath(path, config),
    )
  ) {
    return;
  }

  const resolvedFiles = await Promise.all(
    context.files.map(async (file) => {
      const [candidateBase, candidateResult] = await Promise.all([
        repository.showOptional(`${candidate.baseSha}:${file.path}`),
        repository.showOptional(`${candidate.resultSha}:${file.path}`),
      ]);

      if (
        file.ours === undefined ||
        candidateBase !== file.ours ||
        candidateResult === undefined
      ) {
        return;
      }

      return {
        content: candidateResult,
        path: file.path,
        reason: `Reuse the exact resolution from merged backport PR #${candidate.number}.`,
      };
    }),
  );

  if (resolvedFiles.includes(undefined)) {
    return;
  }

  const files = resolvedFiles.filter(
    (file): file is NonNullable<typeof file> => file !== undefined,
  );
  const patchId = await repository.stablePatchId(candidate.resultSha);

  return {
    decision: {
      assumptions: [],
      decision: "resolved",
      files,
      risks: [],
      summary: `Reused the exact resolution from merged backport PR #${candidate.number}.`,
    },
    evidence: {
      patchId,
      pullRequestNumber: candidate.number,
    },
  };
};

const findReusableSiblingResolution = async (
  input: FindReusableSiblingInput,
): Promise<ReusedSiblingResolution | undefined> => {
  const results = await Promise.all(
    input.candidates.map(async (candidate) =>
      evaluateCandidate({ ...input, candidate }),
    ),
  );

  return results.find((result) => result !== undefined);
};

export {
  findReusableSiblingResolution,
  type FindReusableSiblingInput,
  type ReusedSiblingResolution,
  type SiblingResolutionRepository,
};
