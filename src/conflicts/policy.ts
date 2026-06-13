import { diffLines } from "diff";
import { minimatch } from "minimatch";
import type { ResolutionDecision } from "../ai/schema.js";
import type { EnabledAiConfig } from "../config.js";
import type { ConflictContext, ConflictFile } from "./types.js";

const builtInForbiddenPatterns = [
  "**/package.json",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/go.mod",
  "**/go.sum",
  "**/generated/**",
  "**/*.generated.*",
  "dist/**",
  "vendor/**",
] as const;

type EligibilityResult =
  | Readonly<{ eligible: true }>
  | Readonly<{ eligible: false; reasons: readonly string[] }>;

type ValidationResult =
  | Readonly<{ valid: true }>
  | Readonly<{ reasons: readonly string[]; valid: false }>;

type ResolutionValidationInput = Readonly<{
  config: EnabledAiConfig;
  context: ConflictContext;
  decision: ResolutionDecision;
  diffCheckPassed: boolean;
  immutableChangedPaths: readonly string[];
  omittedSourcePaths: readonly string[];
  validationMutatedPaths: readonly string[];
}>;

const matchesAny = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) =>
    minimatch(path.replaceAll("\\", "/"), pattern, { dot: true }),
  );

const isProtectedPath = (path: string, config: EnabledAiConfig): boolean =>
  matchesAny(path, [
    ...config.immutablePatterns,
    ...builtInForbiddenPatterns,
    ...config.forbiddenPatterns,
  ]);

const fileEligibilityReasons = (
  file: ConflictFile,
  config: EnabledAiConfig,
): readonly string[] => {
  const reasons: string[] = [];

  if (matchesAny(file.path, config.immutablePatterns)) {
    reasons.push(`Immutable file is conflicted: ${file.path}.`);
  }

  if (
    matchesAny(file.path, [
      ...builtInForbiddenPatterns,
      ...config.forbiddenPatterns,
    ])
  ) {
    reasons.push(`Forbidden file is conflicted: ${file.path}.`);
  }

  if (
    file.base === undefined ||
    file.ours === undefined ||
    file.theirs === undefined
  ) {
    reasons.push(
      `Add, delete, or rename conflict requires developer review: ${file.path}.`,
    );
  }

  const combinedContent = `${file.base ?? ""}\n${file.ours ?? ""}\n${
    file.theirs ?? ""
  }`;

  if (
    /\baddTenancyOperationalHooks\b|\bscope\.global\b|\btenantId\s*[:=]/u.test(
      combinedContent,
    )
  ) {
    reasons.push(
      `Tenant isolation code requires developer review: ${file.path}.`,
    );
  }

  return reasons;
};

const evaluateConflictEligibility = (
  context: ConflictContext,
  config: EnabledAiConfig,
): EligibilityResult => {
  const reasons: string[] = [];

  if (context.files.length === 0) {
    reasons.push("No conflicted files were found.");
  }

  if (context.files.length > config.maxConflictedFiles) {
    reasons.push(
      `Conflict has ${context.files.length} files; limit is ${config.maxConflictedFiles}.`,
    );
  }

  for (const file of context.files) {
    reasons.push(...fileEligibilityReasons(file, config));
  }

  return reasons.length === 0
    ? { eligible: true }
    : { eligible: false, reasons };
};

const changedLineCount = (from: string, to: string): number => {
  let total = 0;

  for (const change of diffLines(from, to)) {
    if (change.added || change.removed) {
      total += change.count ?? 0;
    }
  }

  return total;
};

const validateResolutionCandidate = ({
  config,
  context,
  decision,
  diffCheckPassed,
  immutableChangedPaths,
  omittedSourcePaths,
  validationMutatedPaths,
}: ResolutionValidationInput): ValidationResult => {
  const reasons: string[] = [];

  if (decision.decision !== "resolved") {
    reasons.push("The model escalated instead of resolving the conflict.");
  }

  const conflictedFiles = new Map(
    context.files.map((file) => [file.path, file]),
  );
  const outputPaths = new Set(decision.files.map((file) => file.path));

  for (const path of conflictedFiles.keys()) {
    if (!outputPaths.has(path)) {
      reasons.push(`Resolution omitted conflicted file: ${path}.`);
    }
  }

  for (const output of decision.files) {
    const conflict = conflictedFiles.get(output.path);

    if (!conflict) {
      reasons.push(
        `Resolution modified a non-conflicted file: ${output.path}.`,
      );
      continue;
    }

    if (isProtectedPath(output.path, config)) {
      reasons.push(`Resolution modified a forbidden file: ${output.path}.`);
    }

    if (/^(<<<<<<<|=======|>>>>>>>)/mu.test(output.content)) {
      reasons.push(`Conflict markers remain in ${output.path}.`);
    }

    if (conflict.ours !== undefined && output.content === conflict.ours) {
      reasons.push(`Resolution discarded the source change in ${output.path}.`);
    }

    if (conflict.ours !== undefined && conflict.theirs !== undefined) {
      const adaptationLines = Math.min(
        changedLineCount(conflict.ours, output.content),
        changedLineCount(conflict.theirs, output.content),
      );

      if (adaptationLines > config.maxResolutionLines) {
        reasons.push(
          `Resolution adapted ${adaptationLines} lines in ${output.path}; limit is ${config.maxResolutionLines}.`,
        );
      }
    }
  }

  if (!diffCheckPassed) {
    reasons.push("git diff --check failed.");
  }

  if (immutableChangedPaths.length > 0) {
    reasons.push(
      `Immutable files changed: ${immutableChangedPaths.join(", ")}.`,
    );
  }

  if (omittedSourcePaths.length > 0) {
    reasons.push(
      `Source changes were omitted: ${omittedSourcePaths.join(", ")}.`,
    );
  }

  if (validationMutatedPaths.length > 0) {
    reasons.push(
      `Validation commands modified files: ${validationMutatedPaths.join(
        ", ",
      )}.`,
    );
  }

  return reasons.length === 0 ? { valid: true } : { reasons, valid: false };
};

export {
  builtInForbiddenPatterns,
  evaluateConflictEligibility,
  isProtectedPath,
  validateResolutionCandidate,
  type EligibilityResult,
  type ResolutionValidationInput,
  type ValidationResult,
};
