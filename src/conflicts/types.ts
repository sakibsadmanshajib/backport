type ConflictRange = Readonly<{
  endLine: number;
  startLine: number;
}>;

type ConflictFile = Readonly<{
  base?: string;
  blame: string;
  conflictRanges: readonly ConflictRange[];
  history: string;
  ours?: string;
  path: string;
  theirs?: string;
  workingTree: string;
}>;

type ConflictContext = Readonly<{
  destinationHead: string;
  files: readonly ConflictFile[];
  mergeBase: string;
  sourceCommit: string;
  sourceDiff: string;
  sourceParent: string;
}>;

export type { ConflictContext, ConflictFile, ConflictRange };
