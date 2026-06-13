// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import type { ResolutionDecision } from "../../src/ai/schema.js";
import type { EnabledAiConfig } from "../../src/config.js";
import {
  evaluateConflictEligibility,
  validateResolutionCandidate,
} from "../../src/conflicts/policy.js";
import type { ConflictContext } from "../../src/conflicts/types.js";

const config: EnabledAiConfig = {
  apiKey: "secret",
  enabled: true,
  forbiddenPatterns: ["**/authorization/**"],
  immutablePatterns: ["**/migrations/**"],
  label: "AI backport",
  maxConflictedFiles: 3,
  maxResolutionLines: 4,
  model: "small-model",
  provider: "anthropic",
  timeoutMs: 120_000,
  validationCommands: ["yarn test"],
};

const context = (
  path = "status.ts",
  overrides: Partial<ConflictContext["files"][number]> = {},
): ConflictContext => ({
  destinationHead: "destination",
  files: [
    {
      base: "export enum Status {\n  Pending,\n}\n",
      blame: "",
      conflictRanges: [{ endLine: 7, startLine: 2 }],
      history: "",
      ours: "export enum Status {\n  Pending,\n  Archived,\n}\n",
      path,
      theirs: "export enum Status {\n  Pending,\n  Active,\n}\n",
      workingTree: [
        "export enum Status {",
        "  Pending,",
        "<<<<<<< HEAD",
        "  Archived,",
        "=======",
        "  Active,",
        ">>>>>>> source",
        "}",
        "",
      ].join("\n"),
      ...overrides,
    },
  ],
  mergeBase: "base",
  sourceCommit: "source",
  sourceDiff: "+  Active,",
  sourceParent: "parent",
});

const decision = (
  path = "status.ts",
  content = "export enum Status {\n  Pending,\n  Archived,\n  Active,\n}\n",
): ResolutionDecision => ({
  assumptions: [],
  decision: "resolved",
  files: [{ content, path, reason: "Combine the enum members." }],
  risks: [],
  summary: "Resolved the enum conflict.",
});

describe("evaluateConflictEligibility", () => {
  it("allows a small enum conflict", () => {
    expect(evaluateConflictEligibility(context(), config)).toEqual({
      eligible: true,
    });
  });

  it("allows a tenant-setting registration conflict", () => {
    expect(
      evaluateConflictEligibility(
        context("shared/fundmore-models/src/models/tenantSettings.enum.ts", {
          base: "export enum TenantSettingsEnum {\n  Existing,\n}\n",
          ours: "export enum TenantSettingsEnum {\n  Existing,\n  Older,\n}\n",
          theirs:
            "export enum TenantSettingsEnum {\n  Existing,\n  NewSetting,\n}\n",
        }),
        config,
      ),
    ).toEqual({ eligible: true });
  });

  it.each([
    "data/migrations/20260101-add-setting.ts",
    "yarn.lock",
    "packages/app/package.json",
    "src/authorization/guard.ts",
    "src/generated/client.ts",
  ])("rejects the forbidden path %s", (path) => {
    expect(evaluateConflictEligibility(context(path), config)).toMatchObject({
      eligible: false,
    });
  });

  it("rejects tenancy hook changes", () => {
    expect(
      evaluateConflictEligibility(
        context("models/application.ts", {
          theirs: "addTenancyOperationalHooks(Application);\n",
        }),
        config,
      ),
    ).toMatchObject({ eligible: false });
  });

  it("rejects too many conflicted files", () => {
    const single = context();
    const files = Array.from({ length: 4 }, (_, index) => ({
      ...single.files[0],
      path: `status-${index}.ts`,
    }));

    expect(
      evaluateConflictEligibility({ ...single, files }, config),
    ).toMatchObject({ eligible: false });
  });
});

describe("validateResolutionCandidate", () => {
  it("accepts a small combined resolution", () => {
    expect(
      validateResolutionCandidate({
        config,
        context: context(),
        decision: decision(),
        diffCheckPassed: true,
        immutableChangedPaths: [],
        omittedSourcePaths: [],
        validationMutatedPaths: [],
      }),
    ).toEqual({ valid: true });
  });

  it("rejects output outside the conflicted path allowlist", () => {
    expect(
      validateResolutionCandidate({
        config,
        context: context(),
        decision: decision("other.ts"),
        diffCheckPassed: true,
        immutableChangedPaths: [],
        omittedSourcePaths: [],
        validationMutatedPaths: [],
      }),
    ).toMatchObject({ valid: false });
  });

  it("rejects unresolved conflict markers", () => {
    expect(
      validateResolutionCandidate({
        config,
        context: context(),
        decision: decision(
          "status.ts",
          "<<<<<<< HEAD\nArchived\n=======\nActive\n>>>>>>> source\n",
        ),
        diffCheckPassed: true,
        immutableChangedPaths: [],
        omittedSourcePaths: [],
        validationMutatedPaths: [],
      }),
    ).toMatchObject({ valid: false });
  });

  it("rejects a resolution identical to ours", () => {
    const conflict = context();

    expect(
      validateResolutionCandidate({
        config,
        context: conflict,
        decision: decision("status.ts", conflict.files[0]?.ours),
        diffCheckPassed: true,
        immutableChangedPaths: [],
        omittedSourcePaths: [],
        validationMutatedPaths: [],
      }),
    ).toMatchObject({ valid: false });
  });

  it("rejects a resolution above the line limit", () => {
    expect(
      validateResolutionCandidate({
        config: { ...config, maxResolutionLines: 1 },
        context: context(),
        decision: decision(
          "status.ts",
          "export enum Status {\n  Pending,\n  Archived,\n  Active,\n  InventedOne,\n  InventedTwo,\n}\n",
        ),
        diffCheckPassed: true,
        immutableChangedPaths: [],
        omittedSourcePaths: [],
        validationMutatedPaths: [],
      }),
    ).toMatchObject({ valid: false });
  });

  it.each([
    { immutableChangedPaths: ["data/migrations/changed.ts"] },
    { omittedSourcePaths: ["status.test.ts"] },
    { validationMutatedPaths: ["status.ts"] },
  ])("rejects repository integrity failures", (overrides) => {
    expect(
      validateResolutionCandidate({
        config,
        context: context(),
        decision: decision(),
        diffCheckPassed: true,
        immutableChangedPaths: [],
        omittedSourcePaths: [],
        validationMutatedPaths: [],
        ...overrides,
      }),
    ).toMatchObject({ valid: false });
  });

  it("rejects git diff check failures", () => {
    expect(
      validateResolutionCandidate({
        config,
        context: context(),
        decision: decision(),
        diffCheckPassed: false,
        immutableChangedPaths: [],
        omittedSourcePaths: [],
        validationMutatedPaths: [],
      }),
    ).toMatchObject({ valid: false });
  });
});
