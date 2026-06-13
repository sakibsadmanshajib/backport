type SiblingBackportCandidate = Readonly<{
  baseSha: string;
  changedPaths: readonly string[];
  merged: boolean;
  number: number;
  resultSha: string;
  sourceCommit: string;
  sourcePullRequestNumber: number;
}>;

export type { SiblingBackportCandidate };
