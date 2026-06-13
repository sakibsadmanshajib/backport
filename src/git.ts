import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { warning } from "@actions/core";
import { getExecOutput } from "@actions/exec";

type GitCommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type GitRunner = (arguments_: readonly string[]) => Promise<GitCommandResult>;

type CherryPickResult =
  | Readonly<{ status: "clean" }>
  | Readonly<{ paths: readonly string[]; status: "conflicted" }>;

const calculateStablePatchId = async (
  cwd: string,
  patch: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["patch-id", "--stable"], { cwd });
    let stderr = "";
    let stdout = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`git patch-id --stable failed: ${stderr.trim()}`));
        return;
      }

      const [patchId] = stdout.trim().split(/\s+/u);

      if (!patchId) {
        reject(new Error("git patch-id --stable returned no patch ID."));
        return;
      }

      resolve(patchId);
    });
    child.stdin.end(patch);
  });

class GitRepository {
  readonly #path: string;
  readonly #runner: GitRunner;

  constructor(path: string, runner?: GitRunner) {
    this.#path = path;
    this.#runner =
      runner ??
      (async (arguments_) => {
        const result = await getExecOutput("git", [...arguments_], {
          cwd: path,
          ignoreReturnCode: true,
          silent: true,
        });
        return {
          exitCode: result.exitCode,
          stderr: result.stderr,
          stdout: result.stdout,
        };
      });
  }

  get path(): string {
    return this.#path;
  }

  async run(
    arguments_: readonly string[],
    options: Readonly<{ allowFailure?: boolean }> = {},
  ): Promise<GitCommandResult> {
    const result = await this.#runner(arguments_);

    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw new Error(
        `git ${arguments_.join(" ")} failed: ${result.stderr.trim()}`,
      );
    }

    return result;
  }

  async output(arguments_: readonly string[]): Promise<string> {
    const result = await this.run(arguments_);
    return result.stdout.trim();
  }

  async tryCherryPick(commitSha: string): Promise<CherryPickResult> {
    const result = await this.run(["cherry-pick", "-x", commitSha], {
      allowFailure: true,
    });

    if (result.exitCode === 0) {
      return { status: "clean" };
    }

    const paths = await this.listUnmergedPaths();

    if (paths.length === 0) {
      throw new Error(`Cherry-pick failed without conflicts: ${result.stderr}`);
    }

    return { paths, status: "conflicted" };
  }

  async listUnmergedPaths(): Promise<readonly string[]> {
    const result = await this.run([
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    return result.stdout.split("\0").filter((path) => path.length > 0);
  }

  async showOptional(revisionAndPath: string): Promise<string | undefined> {
    const result = await this.run(["show", revisionAndPath], {
      allowFailure: true,
    });
    return result.exitCode === 0 ? result.stdout : undefined;
  }

  async readWorkingTreeFile(path: string): Promise<string> {
    return readFile(`${this.#path}/${path}`, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const absolutePath = resolve(this.#path, path);
    const repositoryPrefix = `${resolve(this.#path)}${sep}`;

    if (!absolutePath.startsWith(repositoryPrefix)) {
      throw new Error(`Refusing to write outside the repository: ${path}.`);
    }

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  async stage(paths: readonly string[]): Promise<void> {
    await this.run(["add", "--", ...paths]);
  }

  async switchBranch(branch: string): Promise<void> {
    await this.run(["switch", "--", branch]);
  }

  async createBranch(branch: string): Promise<void> {
    await this.run(["switch", "--create", "--", branch]);
  }

  async configureIdentity(name: string, email: string): Promise<void> {
    await this.run(["config", "user.name", name]);
    await this.run(["config", "user.email", email]);
  }

  async push(branch: string): Promise<void> {
    await this.run(["push", "--set-upstream", "origin", "--", branch]);
  }

  async diffCheck(): Promise<boolean> {
    const [unstaged, staged] = await Promise.all([
      this.run(["diff", "--check"], { allowFailure: true }),
      this.run(["diff", "--cached", "--check"], { allowFailure: true }),
    ]);
    return unstaged.exitCode === 0 && staged.exitCode === 0;
  }

  async stagedPaths(): Promise<readonly string[]> {
    const result = await this.run([
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "HEAD",
    ]);
    return result.stdout.split("\0").filter((path) => path.length > 0);
  }

  async unstagedPaths(): Promise<readonly string[]> {
    const result = await this.run(["diff", "--name-only", "-z"]);
    return result.stdout.split("\0").filter((path) => path.length > 0);
  }

  async stagedDiff(): Promise<string> {
    const result = await this.run(["diff", "--cached", "--binary", "HEAD"]);
    return result.stdout;
  }

  async continueCherryPick(): Promise<void> {
    await this.run(["cherry-pick", "--continue"]);
  }

  async abortCherryPick(): Promise<void> {
    const result = await this.run(["cherry-pick", "--abort"], {
      allowFailure: true,
    });

    if (result.exitCode === 0) {
      return;
    }

    // Abort failed (e.g. "index not up to date" after validation mutated a
    // tracked file). Log the original failure and force a clean state so the
    // next destination branch's switch/createBranch does not fail.
    const originalError = result.stderr.trim();
    warning(
      `git cherry-pick --abort failed (${originalError}); forcing clean state via --quit + reset --hard HEAD`,
    );
    await this.run(["cherry-pick", "--quit"], { allowFailure: true });
    await this.run(["reset", "--hard", "HEAD"]);
  }

  async stablePatchId(commitSha: string): Promise<string> {
    const patch = await this.run([
      "show",
      "--pretty=format:",
      "--no-ext-diff",
      "--binary",
      commitSha,
    ]);
    return calculateStablePatchId(this.#path, patch.stdout);
  }
}

export {
  GitRepository,
  type CherryPickResult,
  type GitCommandResult,
  type GitRunner,
};
