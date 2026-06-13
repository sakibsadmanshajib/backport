import { appendFile } from "node:fs/promises";
// eslint-disable-next-line import/no-extraneous-dependencies
import { afterEach, describe, expect, it } from "vitest";
import type { ResolutionDecision } from "../src/ai/schema.js";
import type { EnabledAiConfig } from "../src/config.js";
import { collectConflictContext } from "../src/conflicts/context.js";
import { GitRepository } from "../src/git.js";
import { GitBackportWorkspace } from "../src/workspace.js";
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
});
