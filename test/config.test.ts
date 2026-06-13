// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  type InputReader,
  getSafeAiConfigSummary,
  readAiConfig,
} from "../src/config.js";

const inputReader = (
  inputs: Readonly<{ [name: string]: string }>,
): InputReader => ({
  get: (name) => inputs[name] ?? "",
});

const enabledInputs = {
  ai_api_key: "secret-key",
  ai_enabled: "true",
  ai_model: "cheap-model",
  ai_provider: "anthropic",
  ai_validation_commands: '["yarn test"]',
} as const;

describe("readAiConfig", () => {
  it("keeps AI disabled by default", () => {
    expect(readAiConfig(inputReader({}))).toEqual({ enabled: false });
  });

  it.each([
    ["anthropic", {}],
    ["openai", {}],
    ["openai-compatible", { ai_base_url: "https://models.example.test/v1" }],
    ["anthropic-compatible", { ai_base_url: "https://proxy.example.test" }],
    ["anthropic-bedrock", { ai_aws_region: "us-east-1" }],
    [
      "anthropic-vertex",
      { ai_gcp_project: "demo-project", ai_gcp_region: "us-central1" },
    ],
  ] as const)("accepts the %s provider", (provider, extra) => {
    const config = readAiConfig(
      inputReader({ ...enabledInputs, ai_provider: provider, ...extra }),
    );

    expect(config).toMatchObject({ enabled: true, provider });
  });

  it("does not require ai_api_key for bedrock", () => {
    const config = readAiConfig(
      inputReader({
        ...enabledInputs,
        ai_api_key: "",
        ai_aws_region: "us-east-1",
        ai_provider: "anthropic-bedrock",
      }),
    );

    expect(config).toMatchObject({ apiKey: "", enabled: true });
  });

  it("captures explicit bedrock and vertex credentials", () => {
    const bedrock = readAiConfig(
      inputReader({
        ...enabledInputs,
        ai_api_key: "",
        ai_aws_access_key_id: "AKIAEXAMPLE",
        ai_aws_region: "us-east-1",
        ai_aws_secret_access_key: "aws-secret",
        ai_provider: "anthropic-bedrock",
      }),
    );
    const vertex = readAiConfig(
      inputReader({
        ...enabledInputs,
        ai_api_key: "",
        ai_gcp_project: "demo-project",
        ai_gcp_region: "us-central1",
        ai_gcp_service_account_json: '{"type":"service_account"}',
        ai_provider: "anthropic-vertex",
      }),
    );

    expect(bedrock).toMatchObject({
      awsAccessKeyId: "AKIAEXAMPLE",
      awsRegion: "us-east-1",
      awsSecretAccessKey: "aws-secret",
    });
    expect(vertex).toMatchObject({
      gcpProject: "demo-project",
      gcpRegion: "us-central1",
      gcpServiceAccountJson: '{"type":"service_account"}',
    });
  });

  it("requires ai_aws_region for bedrock", () => {
    expect(() =>
      readAiConfig(
        inputReader({
          ...enabledInputs,
          ai_api_key: "",
          ai_provider: "anthropic-bedrock",
        }),
      ),
    ).toThrow("ai_aws_region");
  });

  it.each(["ai_gcp_project", "ai_gcp_region"] as const)(
    "requires %s for vertex",
    (missing) => {
      const inputs = {
        ...enabledInputs,
        ai_api_key: "",
        ai_gcp_project: "demo-project",
        ai_gcp_region: "us-central1",
        ai_provider: "anthropic-vertex",
        [missing]: "",
      };

      expect(() => readAiConfig(inputReader(inputs))).toThrow(missing);
    },
  );

  it("requires ai_base_url for an anthropic-compatible provider", () => {
    expect(() =>
      readAiConfig(
        inputReader({ ...enabledInputs, ai_provider: "anthropic-compatible" }),
      ),
    ).toThrow("ai_base_url");
  });

  it.each(["ai_model", "ai_api_key", "ai_validation_commands"] as const)(
    "requires %s when AI is enabled",
    (name) => {
      expect(() =>
        readAiConfig(inputReader({ ...enabledInputs, [name]: "" })),
      ).toThrow(name);
    },
  );

  it("requires a base URL for an OpenAI-compatible provider", () => {
    expect(() =>
      readAiConfig(
        inputReader({
          ...enabledInputs,
          ai_provider: "openai-compatible",
        }),
      ),
    ).toThrow("ai_base_url");
  });

  it("rejects an unsupported provider", () => {
    expect(() =>
      readAiConfig(
        inputReader({ ...enabledInputs, ai_provider: "unsupported" }),
      ),
    ).toThrow("ai_provider");
  });

  it("rejects malformed JSON arrays", () => {
    expect(() =>
      readAiConfig(
        inputReader({ ...enabledInputs, ai_validation_commands: "not-json" }),
      ),
    ).toThrow("ai_validation_commands");
  });

  it.each([
    ["ai_max_conflicted_files", "0"],
    ["ai_max_resolution_lines", "-1"],
    ["ai_timeout_seconds", "0"],
  ] as const)("rejects an invalid %s limit", (name, value) => {
    expect(() =>
      readAiConfig(inputReader({ ...enabledInputs, [name]: value })),
    ).toThrow(name);
  });

  it("uses conservative defaults", () => {
    expect(readAiConfig(inputReader(enabledInputs))).toMatchObject({
      enabled: true,
      forbiddenPatterns: [],
      immutablePatterns: ["**/migrations/**", "**/migration/**"],
      label: "AI backport",
      maxConflictedFiles: 3,
      maxResolutionLines: 60,
      timeoutMs: 120_000,
    });
  });

  it("parses repository-specific path patterns", () => {
    expect(
      readAiConfig(
        inputReader({
          ...enabledInputs,
          ai_forbidden_patterns: '["**/authorization/**"]',
          ai_immutable_patterns: '["data/migrations/**"]',
        }),
      ),
    ).toMatchObject({
      forbiddenPatterns: ["**/authorization/**"],
      immutablePatterns: ["data/migrations/**"],
    });
  });

  it("omits the API key from safe summaries", () => {
    const config = readAiConfig(inputReader(enabledInputs));

    expect(getSafeAiConfigSummary(config)).toEqual({
      enabled: true,
      model: "cheap-model",
      provider: "anthropic",
    });
    expect(JSON.stringify(getSafeAiConfigSummary(config))).not.toContain(
      "secret-key",
    );
  });
});
