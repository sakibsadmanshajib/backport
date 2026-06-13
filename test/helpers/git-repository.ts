import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

class TestGitRepository {
  static async create(): Promise<TestGitRepository> {
    const path = await mkdtemp(join(tmpdir(), "backport-test-"));
    const repository = new TestGitRepository(path);

    await repository.git("init", "--initial-branch=main");
    await repository.git("config", "user.email", "tests@example.com");
    await repository.git("config", "user.name", "Backport Tests");

    return repository;
  }

  private constructor(readonly path: string) {}

  async cleanup(): Promise<void> {
    await rm(this.path, { force: true, recursive: true });
  }

  async git(...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", arguments_, {
      cwd: this.path,
      encoding: "utf8",
    });
    return stdout.trim();
  }

  async write(path: string, content: string): Promise<void> {
    const absolutePath = join(this.path, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  async commit(message: string): Promise<string> {
    await this.git("add", "--all");
    await this.git("commit", "--message", message);
    return this.git("rev-parse", "HEAD");
  }
}

export { TestGitRepository };
