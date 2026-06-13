import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
