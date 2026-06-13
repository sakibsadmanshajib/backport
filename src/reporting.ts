import type { ResolutionDecision, ReviewDecision } from "./ai/schema.js";

type AiBackportCommentInput = Readonly<{
  base: string;
  model: string;
  provider: string;
  resolution: ResolutionDecision;
  review: ReviewDecision;
  sourceCommit: string;
  sourcePullRequestNumber: number;
  validationCommands: readonly string[];
}>;

type DeveloperHandoffCommentInput = Readonly<{
  base: string;
  conflictPaths: readonly string[];
  head: string;
  mergeBase: string;
  reason: string;
  secrets?: readonly string[];
  sourceCommit: string;
  sourceParent: string;
  stage: string;
}>;

const list = (
  values: readonly string[],
  fallback = "None reported.",
): string =>
  values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : fallback;

const sanitize = (value: string, secrets: readonly string[]): string => {
  let sanitized = value;

  for (const secret of secrets) {
    if (secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }

  return sanitized.slice(0, 500);
};

const getAiBackportCommentBody = ({
  base,
  model,
  provider,
  resolution,
  review,
  sourceCommit,
  sourcePullRequestNumber,
  validationCommands,
}: AiBackportCommentInput): string =>
  [
    "## AI-assisted backport",
    "",
    "**This draft pull request was created after AI resolved cherry-pick conflicts. Review it carefully before marking it ready.**",
    "",
    `- Source: #${sourcePullRequestNumber} at \`${sourceCommit}\``,
    `- Destination: \`${base}\``,
    `- Provider: \`${provider}\``,
    `- Model: \`${model}\``,
    "",
    "### Resolution",
    resolution.summary,
    "",
    "Changed files:",
    list(resolution.files.map((file) => `\`${file.path}\`: ${file.reason}`)),
    "",
    "Assumptions:",
    list(resolution.assumptions),
    "",
    "Risks:",
    list(resolution.risks),
    "",
    "### Independent AI review",
    `- Decision: \`${review.decision}\``,
    `- Summary: ${review.summary}`,
    "",
    "Findings:",
    list(review.findings),
    "",
    "### Validation commands",
    list(validationCommands.map((command) => `\`${command}\``)),
  ].join("\n");

const getDeveloperHandoffCommentBody = ({
  base,
  conflictPaths,
  head,
  mergeBase,
  reason,
  secrets = [],
  sourceCommit,
  sourceParent,
  stage,
}: DeveloperHandoffCommentInput): string => {
  const safeReason = sanitize(reason, secrets);
  const safeBase = base.replaceAll(/[^a-zA-Z0-9._-]/gu, "-");
  const worktreePath = `.worktrees/backport-${safeBase}`;

  return [
    `The backport to \`${base}\` requires a developer.`,
    "",
    `- Failed stage: \`${stage}\``,
    `- Reason: ${safeReason}`,
    `- Source commit: \`${sourceCommit}\``,
    `- Source parent: \`${sourceParent}\``,
    `- Merge base: \`${mergeBase}\``,
    `- Destination branch: \`${base}\``,
    "",
    "Conflicted files:",
    list(conflictPaths.map((path) => `\`${path}\``)),
    "",
    "To continue manually:",
    "```bash",
    "git fetch",
    `git worktree add ${worktreePath} ${base}`,
    `cd ${worktreePath}`,
    `git switch --create ${head}`,
    `git cherry-pick -x ${sourceCommit}`,
    "# Resolve conflicts and run the required validation.",
    `git push --set-upstream origin ${head}`,
    "cd ../..",
    `git worktree remove ${worktreePath}`,
    "```",
  ].join("\n");
};

export {
  getAiBackportCommentBody,
  getDeveloperHandoffCommentBody,
  type AiBackportCommentInput,
  type DeveloperHandoffCommentInput,
};
