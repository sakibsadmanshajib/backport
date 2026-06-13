import { appendFile } from "node:fs/promises";
import { env } from "node:process";
// eslint-disable-next-line import/no-extraneous-dependencies
import { afterEach, describe, expect, it } from "vitest";
import type { ResolutionDecision } from "../src/ai/schema.js";
import type { EnabledAiConfig } from "../src/config.js";
import { collectConflictContext } from "../src/conflicts/context.js";
import { GitRepository } from "../src/git.js";
import {
  GitBackportWorkspace,
  validationEnvironment,
} from "../src/workspace.js";
import { TestGitRepository } from "./helpers/git-repository.js";

const repositories: TestGitRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(async (repo) => repo.cleanup()));
});

const setup = async () => {
  const repository = await TestGitRepository.create();
  repositories.push(repository);
  await repository.write("status.ts", "Pending\n");
  const base = await repository.commit("base");
  await repository.git("switch", "--create", "dev");
  await repository.write("status.ts", "Pending\nActive\n");
  const source = await repository.commit("source");
  await repository.git("switch", "--create", "release", base);
  await repository.write("status.ts", "Pending\nArchived\n");
  await repository.commit("release");
  const git = new GitRepository(repository.path);
  await git.tryCherryPick(source);
  const context = await collectConflictContext(git, source);
  const decision: ResolutionDecision = {
    assumptions: [],
    decision: "resolved",
    files: [
      {
        content: "Pending\nArchived\nActive\n",
        path: "status.ts",
        reason: "Combine both values.",
      },
    ],
    risks: [],
    summary: "Resolved.",
  };
  const config: EnabledAiConfig = {
    apiKey: "secret",
    enabled: true,
    forbiddenPatterns: [],
    immutablePatterns: ["**/migrations/**"],
    label: "AI backport",
    maxConflictedFiles: 3,
    maxResolutionLines: 60,
    model: "small-model",
    provider: "anthropic",
    timeoutMs: 120_000,
    validationCommands: ["validate"],
  };

  return { config, context, decision, git, repository };
};

describe("GitBackportWorkspace", () => {
  it("applies, stages, and validates a resolution", async () => {
    const { config, context, decision, git } = await setup();
    const workspace = new GitBackportWorkspace(git, async () => 0);

    await expect(
      workspace.applyAndValidate(decision, context, config),
    ).resolves.toEqual({ valid: true });
  });

  it("rejects validation commands that mutate tracked files", async () => {
    const { config, context, decision, git, repository } = await setup();
    const workspace = new GitBackportWorkspace(git, async () => {
      await appendFile(`${repository.path}/status.ts`, "Unexpected\n", "utf8");
      return 0;
    });

    await expect(
      workspace.applyAndValidate(decision, context, config),
    ).resolves.toMatchObject({ valid: false });
  });

  it("rejects non-zero validation commands", async () => {
    const { config, context, decision, git } = await setup();
    const workspace = new GitBackportWorkspace(git, async () => 1);

    await expect(
      workspace.applyAndValidate(decision, context, config),
    ).resolves.toMatchObject({
      reasons: ["Validation command failed: validate."],
      valid: false,
    });
  });

  it("rejects whitespace errors in staged AI output", async () => {
    const { config, context, decision, git } = await setup();
    const workspace = new GitBackportWorkspace(git, async () => 0);

    await expect(
      workspace.applyAndValidate(
        {
          ...decision,
          files: [
            {
              ...decision.files[0]!,
              content: "Pending  \nArchived\nActive\n",
            },
          ],
        },
        context,
        config,
      ),
    ).resolves.toMatchObject({
      reasons: ["git diff --check failed."],
      valid: false,
    });
  });

  it("rejects a decision file whose path is not in context.files", async () => {
    const { config, context, decision, git, repository } = await setup();
    const workspace = new GitBackportWorkspace(git, async () => 0);
    const rogue = `${repository.path}/injected.ts`;

    const result = await workspace.applyAndValidate(
      {
        ...decision,
        files: [{ content: "x", path: "injected.ts", reason: "x" }],
      },
      context,
      config,
    );

    expect(result).toMatchObject({ valid: false });
    // File must NOT have been written to disk before rejection
    await expect(
      import("node:fs/promises").then(async (fs) => fs.access(rogue)),
    ).rejects.toThrow();
  });

  it("rejects a decision file targeting a protected path before write", async () => {
    const { config, context, decision, git, repository } = await setup();
    const workspace = new GitBackportWorkspace(git, async () => 0);
    const migrationPath = "data/migrations/20260101-add.ts";
    const absolutePath = `${repository.path}/${migrationPath}`;

    const result = await workspace.applyAndValidate(
      {
        ...decision,
        files: [{ content: "x", path: migrationPath, reason: "x" }],
      },
      context,
      config,
    );

    expect(result).toMatchObject({ valid: false });
    await expect(
      import("node:fs/promises").then(async (fs) => fs.access(absolutePath)),
    ).rejects.toThrow();
  });

  it("runs configured compound commands in a non-interactive shell", async () => {
    const { config, context, decision, git } = await setup();
    const workspace = new GitBackportWorkspace(git);

    await expect(
      workspace.applyAndValidate(decision, context, {
        ...config,
        validationCommands: ["cd . && test -f status.ts"],
      }),
    ).resolves.toEqual({ valid: true });
  });
});

describe("GitRepository.abortCherryPick", () => {
  it("falls back to quit and hard reset when abort fails", async () => {
    const repository = await TestGitRepository.create();
    repositories.push(repository);

    const calls: string[][] = [];
    const runner = async (args: readonly string[]) => {
      calls.push([...args]);
      // Simulate abort failure, succeed for everything else
      if (args[0] === "cherry-pick" && args[1] === "--abort") {
        return { exitCode: 128, stderr: "index not up to date", stdout: "" };
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    };

    const git = new GitRepository(repository.path, runner);
    await git.abortCherryPick();

    const commandStrings = calls.map((c) => c.join(" "));
    expect(commandStrings).toContain("cherry-pick --abort");
    expect(commandStrings).toContain("cherry-pick --quit");
    expect(commandStrings).toContain("reset --hard HEAD");
  });

  it("does not fall back when abort succeeds", async () => {
    const repository = await TestGitRepository.create();
    repositories.push(repository);

    const calls: string[][] = [];
    const runner = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    const git = new GitRepository(repository.path, runner);
    await git.abortCherryPick();

    const commandStrings = calls.map((c) => c.join(" "));
    expect(commandStrings).toContain("cherry-pick --abort");
    expect(commandStrings).not.toContain("cherry-pick --quit");
    expect(commandStrings).not.toContain("reset --hard HEAD");
  });
});

describe("validationEnvironment", () => {
  const withEnv = <T>(
    overrides: { [key: string]: string },
    run: () => T,
  ): T => {
    const saved: { [key: string]: string | undefined } = { ...env };
    Object.assign(env, overrides);
    try {
      return run();
    } finally {
      for (const key of Object.keys(overrides)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete env[key];
      }

      Object.assign(env, saved);
    }
  };

  it("strips model credentials and ambient cloud variables", () => {
    const result = withEnv(
      {
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
        INPUT_AI_API_KEY: "bearer",
        INPUT_AI_AWS_SECRET_ACCESS_KEY: "input-aws-secret",
        INPUT_AI_GCP_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
        INPUT_GITHUB_TOKEN: "gh",
        PATH_THROUGH_MARKER: "kept",
      },
      validationEnvironment,
    );

    expect(result.PATH_THROUGH_MARKER).toBe("kept");
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(result.INPUT_AI_API_KEY).toBeUndefined();
    expect(result.INPUT_AI_AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.INPUT_AI_GCP_SERVICE_ACCOUNT_JSON).toBeUndefined();
    expect(result.INPUT_GITHUB_TOKEN).toBeUndefined();
  });
});
