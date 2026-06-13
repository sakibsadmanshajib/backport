import type { GitRepository } from "../git.js";
import type { ConflictContext, ConflictFile, ConflictRange } from "./types.js";

const parseConflictRanges = (content: string): readonly ConflictRange[] => {
  const lines = content.split("\n");
  const ranges: ConflictRange[] = [];
  let startLine: number | undefined;

  for (const [index, line] of lines.entries()) {
    if (line.startsWith("<<<<<<< ")) {
      startLine = index + 1;
      continue;
    }

    if (line.startsWith(">>>>>>> ") && startLine !== undefined) {
      ranges.push({ endLine: index + 1, startLine });
      startLine = undefined;
    }
  }

  return ranges;
};

const collectBlame = async (
  git: GitRepository,
  path: string,
  ranges: readonly ConflictRange[],
): Promise<string> => {
  const blameSections = await Promise.all(
    ranges.map(async (range) => {
      const startLine = Math.max(1, range.startLine - 3);
      const endLine = range.endLine + 3;
      const result = await git.run(
        [
          "blame",
          "--line-porcelain",
          "-L",
          `${startLine},${endLine}`,
          "HEAD",
          "--",
          path,
        ],
        { allowFailure: true },
      );

      return result.exitCode === 0 ? result.stdout.trim() : "";
    }),
  );

  return blameSections.filter((section) => section.length > 0).join("\n\n");
};

const collectConflictFile = async (
  git: GitRepository,
  path: string,
): Promise<ConflictFile> => {
  const workingTree = await git.readWorkingTreeFile(path);
  const conflictRanges = parseConflictRanges(workingTree);
  const [base, ours, theirs, history, blame] = await Promise.all([
    git.showOptional(`:1:${path}`),
    git.showOptional(`:2:${path}`),
    git.showOptional(`:3:${path}`),
    git.output(["log", "-n", "5", "--format=%H%x09%s", "--", path]),
    collectBlame(git, path, conflictRanges),
  ]);

  return {
    ...(base === undefined ? {} : { base }),
    blame,
    conflictRanges,
    history,
    ...(ours === undefined ? {} : { ours }),
    path,
    ...(theirs === undefined ? {} : { theirs }),
    workingTree,
  };
};

const collectConflictContext = async (
  git: GitRepository,
  sourceCommit: string,
): Promise<ConflictContext> => {
  const sourceParent = await git.output(["rev-parse", `${sourceCommit}^`]);
  const destinationHead = await git.output(["rev-parse", "HEAD"]);
  const mergeBase = await git.output([
    "merge-base",
    destinationHead,
    sourceParent,
  ]);
  const sourceDiffResult = await git.run([
    "show",
    "--format=",
    "--find-renames",
    sourceCommit,
  ]);
  const sourceDiff = sourceDiffResult.stdout;
  const paths = await git.listUnmergedPaths();
  const files = await Promise.all(
    paths.map(async (path) => collectConflictFile(git, path)),
  );

  return {
    destinationHead,
    files,
    mergeBase,
    sourceCommit,
    sourceDiff,
    sourceParent,
  };
};

export { collectConflictContext, parseConflictRanges };
