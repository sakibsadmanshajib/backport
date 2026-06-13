import { env } from "node:process";
import { getExecOutput } from "@actions/exec";
import type { ResolutionDecision } from "./ai/schema.js";
import type { EnabledAiConfig } from "./config.js";
import { collectConflictContext } from "./conflicts/context.js";
import {
  type ValidationResult,
  isProtectedPath,
  validateResolutionCandidate,
} from "./conflicts/policy.js";
import {
  type FindReusableSiblingInput,
  type ReusedSiblingResolution,
  findReusableSiblingResolution,
} from "./conflicts/sibling-resolution.js";
import type { ConflictContext } from "./conflicts/types.js";
import type { CherryPickResult, GitRepository } from "./git.js";

type ValidationRunner = (command: string, cwd: string) => Promise<number>;

const STRIPPED_VALIDATION_ENV_NAMES = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "INPUT_AI_API_KEY",
  "INPUT_AI_GCP_SERVICE_ACCOUNT_JSON",
  "INPUT_GITHUB_TOKEN",
]);

const isStrippedValidationEnvName = (name: string): boolean =>
  STRIPPED_VALIDATION_ENV_NAMES.has(name) ||
  name.startsWith("AWS_") ||
  name.startsWith("INPUT_AI_AWS_");

const validationEnvironment = (): { [name: string]: string } =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isStrippedValidationEnvName(entry[0]),
    ),
  );

const defaultValidationRunner: ValidationRunner = async (command, cwd) => {
  const result = await getExecOutput(
    "bash",
    ["--noprofile", "--norc", "-o", "pipefail", "-c", command],
    {
      cwd,
      env: validationEnvironment(),
      ignoreReturnCode: true,
    },
  );
  return result.exitCode;
};

const runValidationCommands = async (
  commands: readonly string[],
  cwd: string,
  runner: ValidationRunner,
): Promise<string | undefined> => {
  const [command, ...remaining] = commands;

  if (!command) {
    return undefined;
  }

  const exitCode = await runner(command, cwd);

  if (exitCode !== 0) {
    return command;
  }

  return runValidationCommands(remaining, cwd, runner);
};

class GitBackportWorkspace {
  readonly #git: GitRepository;
  readonly #validationRunner: ValidationRunner;

  constructor(
    git: GitRepository,
    validationRunner: ValidationRunner = defaultValidationRunner,
  ) {
    this.#git = git;
    this.#validationRunner = validationRunner;
  }

  async prepare(base: string, head: string): Promise<void> {
    await this.#git.switchBranch(base);
    await this.#git.createBranch(head);
  }

  async tryCherryPick(sourceCommit: string): Promise<CherryPickResult> {
    return this.#git.tryCherryPick(sourceCommit);
  }

  async collectContext(sourceCommit: string): Promise<ConflictContext> {
    return collectConflictContext(this.#git, sourceCommit);
  }

  async findReusableSibling(
    input: Omit<FindReusableSiblingInput, "repository">,
  ): Promise<ReusedSiblingResolution | undefined> {
    return findReusableSiblingResolution({
      ...input,
      repository: this.#git,
    });
  }

  async applyAndValidate(
    decision: ResolutionDecision,
    context: ConflictContext,
    config: EnabledAiConfig,
  ): Promise<ValidationResult> {
    const conflictedPaths = new Set(context.files.map((f) => f.path));
    const preWriteReasons: string[] = [];

    for (const file of decision.files) {
      if (!conflictedPaths.has(file.path)) {
        preWriteReasons.push(
          `Resolution modified a non-conflicted file: ${file.path}.`,
        );
      } else if (isProtectedPath(file.path, config)) {
        preWriteReasons.push(
          `Resolution modified a forbidden file: ${file.path}.`,
        );
      }
    }

    if (preWriteReasons.length > 0) {
      return { reasons: preWriteReasons, valid: false };
    }

    for (const file of decision.files) {
      // File writes are sequential to keep errors tied to the exact output path.
      // eslint-disable-next-line no-await-in-loop
      await this.#git.writeFile(file.path, file.content);
    }

    await this.#git.stage(decision.files.map(({ path }) => path));
    const diffCheckPassed = await this.#git.diffCheck();
    const stagedPaths = await this.#git.stagedPaths();
    const omittedSourcePaths = context.sourceChangedPaths.filter(
      (path) => !stagedPaths.includes(path),
    );
    const beforeUnstagedPaths = await this.#git.unstagedPaths();
    const beforeStagedDiff = await this.#git.stagedDiff();
    const failedCommand = await runValidationCommands(
      config.validationCommands,
      this.#git.path,
      this.#validationRunner,
    );

    if (failedCommand) {
      return {
        reasons: [`Validation command failed: ${failedCommand}.`],
        valid: false,
      };
    }

    const afterUnstagedPaths = await this.#git.unstagedPaths();
    const afterStagedDiff = await this.#git.stagedDiff();
    const validationMutatedPaths = afterUnstagedPaths.filter(
      (path) => !beforeUnstagedPaths.includes(path),
    );

    if (
      afterStagedDiff !== beforeStagedDiff &&
      validationMutatedPaths.length === 0
    ) {
      validationMutatedPaths.push(...(await this.#git.stagedPaths()));
    }

    return validateResolutionCandidate({
      config,
      context,
      decision,
      diffCheckPassed,
      immutableChangedPaths: [],
      omittedSourcePaths,
      validationMutatedPaths,
    });
  }

  async completeCherryPick(): Promise<void> {
    await this.#git.continueCherryPick();
  }

  async abort(): Promise<void> {
    await this.#git.abortCherryPick();
  }

  async push(head: string): Promise<void> {
    await this.#git.push(head);
  }
}

export { GitBackportWorkspace, validationEnvironment, type ValidationRunner };
