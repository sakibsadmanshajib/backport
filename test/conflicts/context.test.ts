// eslint-disable-next-line import/no-extraneous-dependencies
import { afterEach, describe, expect, it } from "vitest";
import { collectConflictContext } from "../../src/conflicts/context.js";
import { GitRepository } from "../../src/git.js";
import { TestGitRepository } from "../helpers/git-repository.js";

const repositories: TestGitRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(async (repo) => repo.cleanup()));
});

const createEnumConflict = async () => {
  const repository = await TestGitRepository.create();
  repositories.push(repository);
  await repository.write("status.ts", "export enum Status {\n  Pending,\n}\n");
  const commonCommit = await repository.commit("add status enum");

  await repository.git("switch", "--create", "dev");
  await repository.write(
    "status.ts",
    "export enum Status {\n  Pending,\n  Active,\n}\n",
  );
  const sourceCommit = await repository.commit("add active status");

  await repository.git("switch", "--create", "release", commonCommit);
  await repository.write(
    "status.ts",
    "export enum Status {\n  Pending,\n  Archived,\n}\n",
  );
  const destinationHead = await repository.commit("add archived status");

  const git = new GitRepository(repository.path);
  const cherryPick = await git.tryCherryPick(sourceCommit);

  expect(cherryPick.status).toBe("conflicted");

  return { commonCommit, destinationHead, git, sourceCommit };
};

describe("collectConflictContext", () => {
  it("collects commit relationships and unmerged index stages", async () => {
    const { commonCommit, destinationHead, git, sourceCommit } =
      await createEnumConflict();

    const context = await collectConflictContext(git, sourceCommit);

    expect(context).toMatchObject({
      destinationHead,
      mergeBase: commonCommit,
      sourceCommit,
      sourceParent: commonCommit,
    });
    expect(context.sourceDiff).toContain("+  Active,");
    expect(context.sourceChangedPaths).toEqual(["status.ts"]);
    expect(context.files).toHaveLength(1);
    expect(context.files[0]).toMatchObject({
      base: "export enum Status {\n  Pending,\n}\n",
      ours: "export enum Status {\n  Pending,\n  Archived,\n}\n",
      path: "status.ts",
      theirs: "export enum Status {\n  Pending,\n  Active,\n}\n",
    });
  });

  it("collects conflict markers, history, and bounded blame", async () => {
    const { git, sourceCommit } = await createEnumConflict();

    const context = await collectConflictContext(git, sourceCommit);
    const [file] = context.files;

    expect(file?.workingTree).toContain("<<<<<<< HEAD");
    expect(file?.workingTree).toContain("=======");
    expect(file?.workingTree).toContain(">>>>>>>");
    expect(file?.conflictRanges).toHaveLength(1);
    expect(file?.conflictRanges[0]?.startLine).toBeGreaterThan(0);
    expect(file?.conflictRanges[0]?.endLine).toBeGreaterThan(
      file?.conflictRanges[0]?.startLine ?? 0,
    );
    expect(file?.history).toContain("add archived status");
    expect(file?.blame).toContain("status.ts");
  });

  it("computes Git stable patch IDs", async () => {
    const { git, sourceCommit } = await createEnumConflict();

    await expect(git.stablePatchId(sourceCommit)).resolves.toMatch(
      /^[0-9a-f]{40}$/u,
    );
  });
});
