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

  it("applies an allowlisted resolution and completes the cherry-pick", async () => {
    const { git } = await createEnumConflict();
    const resolved =
      "export enum Status {\n  Pending,\n  Archived,\n  Active,\n}\n";

    await git.writeFile("status.ts", resolved);
    await git.stage(["status.ts"]);

    await expect(git.diffCheck()).resolves.toBe(true);
    await expect(git.stagedPaths()).resolves.toEqual(["status.ts"]);
    await git.continueCherryPick();
    await expect(git.output(["show", "HEAD:status.ts"])).resolves.toBe(
      resolved.trim(),
    );
  });

  it("omits base when index stage 1 is absent (add/add conflict)", async () => {
    // Add/add conflict: both branches introduce the same new file independently.
    // Stage 1 (base) is absent because the file did not exist at the merge-base.
    const repository = await TestGitRepository.create();
    repositories.push(repository);

    await repository.write("readme.txt", "init\n");
    await repository.commit("init");

    await repository.git("switch", "--create", "feature");
    await repository.write("new.ts", "export const a = 1;\n");
    const sourceCommit = await repository.commit("add new.ts on feature");

    await repository.git("switch", "--create", "release", "main");
    await repository.write("new.ts", "export const a = 2;\n");
    await repository.commit("add new.ts on release with different content");

    const git = new GitRepository(repository.path);
    const cherryPick = await git.tryCherryPick(sourceCommit);

    expect(cherryPick.status).toBe("conflicted");

    const context = await collectConflictContext(git, sourceCommit);

    expect(context.files).toHaveLength(1);
    const [file] = context.files;

    // Base must not exist: stage 1 is absent for an add/add conflict.
    expect(file).not.toHaveProperty("base");
    expect(file?.workingTree).toContain("<<<<<<<");
    expect(file?.path).toBe("new.ts");
  });

  it("produces empty blame when git blame returns a non-zero exit code", async () => {
    // Use the enum conflict repo but inject a runner that fails blame commands,
    // exercising the `exitCode !== 0 ? "" : result.stdout.trim()` branch.
    const { git: realGit, sourceCommit } = await createEnumConflict();

    // Wrap the real runner: return exitCode 1 for blame, delegate everything else.
    const realRunner = async (args: readonly string[]) => {
      // Access via the public run() surface is not possible for the raw runner,
      // so we build a thin pass-through using getExecOutput directly.
      const { getExecOutput } = await import("@actions/exec");
      const result = await getExecOutput("git", [...args], {
        cwd: realGit.path,
        ignoreReturnCode: true,
        silent: true,
      });
      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    };

    const failingBlameRunner = async (args: readonly string[]) => {
      if (args[0] === "blame") {
        return { exitCode: 1, stderr: "simulated blame failure", stdout: "" };
      }

      return realRunner(args);
    };

    const git = new GitRepository(realGit.path, failingBlameRunner);
    const context = await collectConflictContext(git, sourceCommit);

    expect(context.files).toHaveLength(1);
    // Blame must collapse to "" when every blame section fails.
    expect(context.files[0]?.blame).toBe("");
  });
});
