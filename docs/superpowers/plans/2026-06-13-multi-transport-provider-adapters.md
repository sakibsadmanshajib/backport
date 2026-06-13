# Multi-Transport Provider Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach Claude on AWS Bedrock, GCP Vertex AI, and Anthropic-API-compatible proxies, plus Google Gemini and Cloudflare native models, without coupling backport logic to any vendor and without weakening the strict structured-output guarantee.

**Architecture:** One transport-parameterized Anthropic family provider. A single shared `generate()` maps the request to `messages.parse` with `zodOutputFormat`, handles stop reasons, validates output, and redacts secrets. A per-transport client factory constructs `Anthropic`, `AnthropicBedrock`, `AnthropicVertex`, or `Anthropic({ baseURL })`; the success and failure path never branches per transport. Google Gemini and Cloudflare native reuse the existing `openai-compatible` adapter through `ai_base_url` (no new code), gated by the live smoke. The OpenAI adapters are untouched.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` specifiers resolving to `.ts`), Node 24, Yarn 1.22, Zod v4, `@anthropic-ai/sdk` (+ `bedrock-sdk`, `vertex-sdk`), `google-auth-library`, Vitest, xo, prettier, `@vercel/ncc`.

**Reference spec:** `docs/superpowers/specs/2026-06-13-multi-transport-provider-adapters-design.md`

---

## File Structure

| File                                  | Responsibility                                                                                            | Action  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| `package.json`                        | Declare the three new SDK dependencies                                                                    | Modify  |
| `src/ai/providers/common.ts`          | Redact one-or-many secrets from surfaced error text                                                       | Modify  |
| `src/ai/providers/anthropic.ts`       | Transport-parameterized Anthropic family: shared `generate()`, response normalizer, four client factories | Rewrite |
| `src/ai/provider.ts`                  | Map the three new `config.provider` values to the family provider                                         | Modify  |
| `src/config.ts`                       | Parse and validate the new provider values and cloud-credential inputs                                    | Modify  |
| `action.yml`                          | Declare the new cloud-credential inputs and document the provider list                                    | Modify  |
| `src/workspace.ts`                    | Strip the new credential inputs and ambient cloud variables from the validation environment               | Modify  |
| `test/ai/providers/common.test.ts`    | Cover multi-secret redaction and empty-secret safety                                                      | Create  |
| `test/ai/providers/anthropic.test.ts` | Cover the family provider and per-transport client construction                                           | Rewrite |
| `test/ai/provider.test.ts`            | Cover the three new factory cases                                                                         | Modify  |
| `test/config.test.ts`                 | Cover new providers and their required inputs                                                             | Modify  |
| `test/workspace.test.ts`              | Cover the extended validation-environment stripping                                                       | Modify  |
| `scripts/provider-smoke.live.ts`      | Add one live smoke case per new transport                                                                 | Modify  |
| `README.md`                           | Document the new providers, inputs, and the smoke-gate policy                                             | Modify  |

**Naming locked across tasks:** the class is `AnthropicFamilyProvider`; the per-request options type is `AnthropicRequestOptions = { maxRetries: number; timeout: number }`; the factory type is `AnthropicClientFactory = (options: AnthropicRequestOptions) => AnthropicClient`; the factory builders are `nativeClientFactory`, `compatibleClientFactory`, `bedrockClientFactory`, `vertexClientFactory`; the shared normalizer is `normalizeResponse`; redaction accepts `secrets: string | readonly string[]`. New `config.provider` values are exactly `anthropic-bedrock`, `anthropic-vertex`, `anthropic-compatible`.

---

## Task 1: Add the cloud transport dependencies

**Files:**

- Modify: `package.json` (dependencies block)
- Modify: `yarn.lock` (generated)

- [ ] **Step 1: Install the three packages**

Run:

```bash
yarn add @anthropic-ai/bedrock-sdk @anthropic-ai/vertex-sdk google-auth-library
```

Expected: `package.json` `dependencies` gains `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, and `google-auth-library`; `yarn.lock` updates; exit 0.

- [ ] **Step 2: Confirm the suite still passes with the new deps present**

Run: `yarn test`
Expected: PASS (no behavior changed yet; this proves the install did not break resolution).

- [ ] **Step 3: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore: add bedrock, vertex, and google-auth deps"
```

---

## Task 2: Redact one or many secrets in provider errors

`normalizeProviderError`/`sanitizeProviderError` currently redact a single API key. Bedrock and Vertex carry different secrets (AWS secret key, service-account JSON), and a transport may carry none. Generalize to a list and make empty strings safe — `"abc".replaceAll("", "X")` would corrupt every character, so empty secrets must be skipped.

**Files:**

- Modify: `src/ai/providers/common.ts:21-38`
- Test: `test/ai/providers/common.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/ai/providers/common.test.ts`:

```ts
// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  normalizeProviderError,
  sanitizeProviderError,
} from "../../../src/ai/providers/common.js";

describe("sanitizeProviderError", () => {
  it("redacts a single secret", () => {
    const error = new Error("call failed for key sk-live-123");

    expect(sanitizeProviderError(error, "sk-live-123")).toBe(
      "call failed for key [REDACTED]",
    );
  });

  it("redacts every secret in a list", () => {
    const error = new Error('aws AKIA-secret and json {"private":1} leaked');

    expect(sanitizeProviderError(error, ["AKIA-secret", '{"private":1}'])).toBe(
      "aws [REDACTED] and json [REDACTED] leaked",
    );
  });

  it("ignores empty secrets instead of corrupting the message", () => {
    const error = new Error("plain message");

    expect(sanitizeProviderError(error, ["", "missing"])).toBe("plain message");
  });

  it("truncates to 500 characters", () => {
    const error = new Error("x".repeat(900));

    expect(sanitizeProviderError(error, "unused").length).toBe(500);
  });
});

describe("normalizeProviderError", () => {
  it("classifies timeouts and redacts a list of secrets", () => {
    const error = new Error("request with secret-aws timed out");
    error.name = "APIConnectionTimeoutError";

    const result = normalizeProviderError(error, ["secret-aws"]);

    expect(result).toMatchObject({ category: "timeout", ok: false });
    expect(result.ok ? "" : result.message).not.toContain("secret-aws");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run test/ai/providers/common.test.ts`
Expected: FAIL — `sanitizeProviderError` currently takes `apiKey: string`, so the list and empty-secret cases fail (type signature plus `replaceAll("")` corruption).

- [ ] **Step 3: Implement multi-secret redaction**

In `src/ai/providers/common.ts`, replace the `sanitizeProviderError` and `normalizeProviderError` definitions (lines 21-38) with:

```ts
const sanitizeProviderError = (
  error: unknown,
  secrets: string | readonly string[],
): string => {
  const secretList = typeof secrets === "string" ? [secrets] : secrets;
  let message = ensureError(error).message;

  for (const secret of secretList) {
    if (secret.length > 0) {
      message = message.replaceAll(secret, "[REDACTED]");
    }
  }

  return message.slice(0, 500);
};

const normalizeProviderError = (
  error: unknown,
  secrets: string | readonly string[],
): ModelFailure => {
  const normalized = ensureError(error);
  const category =
    normalized.name.toLowerCase().includes("timeout") ||
    normalized.message.toLowerCase().includes("timed out")
      ? "timeout"
      : "provider-error";

  return failure(category, sanitizeProviderError(normalized, secrets));
};
```

- [ ] **Step 4: Run the new test and the existing provider tests**

Run: `yarn vitest run test/ai/providers/common.test.ts test/ai/providers`
Expected: PASS. The existing adapters pass a single `string` to `normalizeProviderError`, still accepted by the wider `string | readonly string[]` parameter.

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/common.ts test/ai/providers/common.test.ts
git commit -m "feat: redact multiple secrets from provider errors"
```

---

## Task 3: Refactor the Anthropic adapter into a transport family

Replace the single-transport `AnthropicProvider` with `AnthropicFamilyProvider` plus four client factories. The shared `generate()` is the existing logic verbatim; only client construction and the carried secrets differ per transport. All three SDK client classes (`Anthropic`, `AnthropicBedrock`, `AnthropicVertex`) expose the same `messages.parse`, so one `normalizeResponse` and one `generate()` serve every transport.

**Files:**

- Rewrite: `src/ai/providers/anthropic.ts`
- Rewrite: `test/ai/providers/anthropic.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `test/ai/providers/anthropic.test.ts` with:

```ts
// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import {
  type AnthropicClient,
  type AnthropicRequestOptions,
  AnthropicFamilyProvider,
} from "../../../src/ai/providers/anthropic.js";
import { structuredRequest } from "../../helpers/fakes.js";

const successResponse = {
  parsed_output: { answer: "resolved" },
  stop_details: null,
  stop_reason: "end_turn",
  usage: {
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    input_tokens: 10,
    output_tokens: 5,
  },
} as const;

const familyProvider = (
  client: AnthropicClient,
  capture?: (options: AnthropicRequestOptions) => void,
  secrets: readonly string[] = ["anthropic-secret"],
): AnthropicFamilyProvider =>
  new AnthropicFamilyProvider({
    clientFactory: (options) => {
      capture?.(options);
      return client;
    },
    model: "claude-haiku-test",
    secrets,
  });

describe("AnthropicFamilyProvider", () => {
  it("maps a structured request and normalizes usage", async () => {
    let requestOptions: AnthropicRequestOptions | undefined;
    let parseParameters: unknown;
    let parseOptions: unknown;
    const client: AnthropicClient = {
      messages: {
        async parse(parameters, options) {
          parseParameters = parameters;
          parseOptions = options;
          return successResponse;
        },
      },
    };

    await expect(
      familyProvider(client, (options) => {
        requestOptions = options;
      }).generate(structuredRequest()),
    ).resolves.toEqual({
      data: { answer: "resolved" },
      ok: true,
      usage: { inputTokens: 15, outputTokens: 5 },
    });
    expect(requestOptions).toEqual({ maxRetries: 0, timeout: 15_000 });
    expect(parseParameters).toMatchObject({
      max_tokens: 512,
      messages: [{ content: "Resolve the conflict.", role: "user" }],
      model: "claude-haiku-test",
      system: "Return a safe structured answer.",
    });
    expect(parseOptions).toEqual({ timeout: 15_000 });
  });

  it.each([
    ["refusal", "refusal"],
    ["max_tokens", "incomplete"],
    ["pause_turn", "incomplete"],
  ] as const)("normalizes %s as %s", async (stopReason, category) => {
    const provider = familyProvider({
      messages: {
        parse: async () => ({
          ...successResponse,
          parsed_output: null,
          stop_reason: stopReason,
        }),
      },
    });

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category, ok: false },
    );
  });

  it("independently rejects invalid parsed output", async () => {
    const provider = familyProvider({
      messages: {
        parse: async () => ({
          ...successResponse,
          parsed_output: { wrong: true },
        }),
      },
    });

    await expect(provider.generate(structuredRequest())).resolves.toMatchObject(
      { category: "invalid-output", ok: false },
    );
  });

  it("normalizes timeouts and redacts every carried secret", async () => {
    const timeout = new Error(
      "Request with anthropic-secret and aws-secret timed out.",
    );
    timeout.name = "APIConnectionTimeoutError";
    const provider = familyProvider(
      {
        messages: {
          async parse() {
            throw timeout;
          },
        },
      },
      undefined,
      ["anthropic-secret", "aws-secret"],
    );

    const result = await provider.generate(structuredRequest());

    expect(result).toMatchObject({ category: "timeout", ok: false });
    const message = result.ok ? "" : result.message;
    expect(message).not.toContain("anthropic-secret");
    expect(message).not.toContain("aws-secret");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run test/ai/providers/anthropic.test.ts`
Expected: FAIL — `AnthropicFamilyProvider` and `AnthropicRequestOptions` are not yet exported.

- [ ] **Step 3: Rewrite the adapter**

Replace the entire contents of `src/ai/providers/anthropic.ts` with:

```ts
import { Anthropic } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod.mjs";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";
import type { z } from "zod";
import type {
  ModelResult,
  StructuredModelProvider,
  StructuredModelRequest,
} from "../types.js";
import {
  failure,
  normalizeProviderError,
  validateParsedOutput,
} from "./common.js";

type AnthropicParseParameters = Readonly<{
  max_tokens: number;
  messages: Array<{
    content: string;
    role: "assistant" | "user";
  }>;
  model: string;
  output_config: {
    format: ReturnType<typeof zodOutputFormat>;
  };
  system: string;
}>;

type AnthropicResponse = Readonly<{
  parsed_output?: unknown;
  stop_details?: unknown;
  stop_reason?: string;
  usage: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens: number;
  };
}>;

type AnthropicClient = {
  messages: {
    parse: (
      parameters: AnthropicParseParameters,
      options?: { timeout?: number },
    ) => Promise<AnthropicResponse>;
  };
};

type AnthropicRequestOptions = Readonly<{
  maxRetries: number;
  timeout: number;
}>;

type AnthropicClientFactory = (
  options: AnthropicRequestOptions,
) => AnthropicClient;

type BedrockAuth = Readonly<{
  accessKeyId?: string;
  region: string;
  secretAccessKey?: string;
  sessionToken?: string;
}>;

type VertexAuth = Readonly<{
  project: string;
  region: string;
  serviceAccountJson?: string;
}>;

const normalizeResponse = (response: {
  parsed_output?: unknown;
  stop_details?: unknown;
  stop_reason?: string | null;
  usage: {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    input_tokens?: number | null;
    output_tokens: number;
  };
}): AnthropicResponse => ({
  parsed_output: response.parsed_output ?? undefined,
  stop_details: response.stop_details ?? undefined,
  stop_reason: response.stop_reason ?? undefined,
  usage: {
    cache_creation_input_tokens:
      response.usage.cache_creation_input_tokens ?? undefined,
    cache_read_input_tokens:
      response.usage.cache_read_input_tokens ?? undefined,
    input_tokens: response.usage.input_tokens ?? undefined,
    output_tokens: response.usage.output_tokens,
  },
});

const wrapClient = (
  parse: (
    parameters: AnthropicParseParameters,
    options?: { timeout?: number },
  ) => Promise<Parameters<typeof normalizeResponse>[0]>,
): AnthropicClient => ({
  messages: {
    async parse(parameters, options) {
      return normalizeResponse(await parse(parameters, options));
    },
  },
});

const nativeClientFactory =
  (apiKey: string): AnthropicClientFactory =>
  (options) => {
    const client = new Anthropic({ apiKey, ...options });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

const compatibleClientFactory =
  (apiKey: string, baseURL: string): AnthropicClientFactory =>
  (options) => {
    const client = new Anthropic({ apiKey, baseURL, ...options });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

const bedrockClientFactory =
  (auth: BedrockAuth): AnthropicClientFactory =>
  (options) => {
    const hasExplicitKeys =
      auth.accessKeyId !== undefined && auth.secretAccessKey !== undefined;
    const client = new AnthropicBedrock({
      awsRegion: auth.region,
      ...(hasExplicitKeys
        ? {
            providerChainResolver: () =>
              Promise.resolve(() =>
                Promise.resolve({
                  accessKeyId: auth.accessKeyId!,
                  secretAccessKey: auth.secretAccessKey!,
                  ...(auth.sessionToken
                    ? { sessionToken: auth.sessionToken }
                    : {}),
                }),
              ),
          }
        : {}),
      ...options,
    });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

const vertexClientFactory =
  (auth: VertexAuth): AnthropicClientFactory =>
  (options) => {
    const client = new AnthropicVertex({
      projectId: auth.project,
      region: auth.region,
      ...(auth.serviceAccountJson
        ? {
            googleAuth: new GoogleAuth({
              credentials: JSON.parse(auth.serviceAccountJson) as Record<
                string,
                unknown
              >,
              scopes: "https://www.googleapis.com/auth/cloud-platform",
            }),
          }
        : {}),
      ...options,
    });
    return wrapClient(async (parameters, requestOptions) =>
      client.messages.parse(parameters, requestOptions),
    );
  };

class AnthropicFamilyProvider implements StructuredModelProvider {
  readonly #clientFactory: AnthropicClientFactory;
  readonly #model: string;
  readonly #secrets: readonly string[];

  constructor(params: {
    clientFactory: AnthropicClientFactory;
    model: string;
    secrets: readonly string[];
  }) {
    this.#clientFactory = params.clientFactory;
    this.#model = params.model;
    this.#secrets = params.secrets;
  }

  async generate<TSchema extends z.ZodTypeAny>(
    request: StructuredModelRequest<TSchema>,
  ): Promise<ModelResult<z.infer<TSchema>>> {
    const client = this.#clientFactory({
      maxRetries: 0,
      timeout: request.timeoutMs,
    });

    try {
      const response = await client.messages.parse(
        {
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map(({ content, role }) => ({
            content,
            role,
          })),
          model: this.#model,
          output_config: {
            format: zodOutputFormat(request.schema),
          },
          system: request.system,
        },
        { timeout: request.timeoutMs },
      );
      const usage = {
        inputTokens:
          (response.usage.input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
      };

      if (response.stop_reason === "refusal") {
        return failure("refusal", "Anthropic refused the request.", usage);
      }

      if (
        response.stop_reason === "max_tokens" ||
        response.stop_reason === "pause_turn"
      ) {
        return failure(
          "incomplete",
          `Anthropic stopped with ${response.stop_reason}.`,
          usage,
        );
      }

      if (response.parsed_output === undefined) {
        return failure(
          "invalid-output",
          "Anthropic returned no structured output.",
          usage,
        );
      }

      return validateParsedOutput(
        request.schema,
        response.parsed_output,
        usage,
      );
    } catch (error: unknown) {
      return normalizeProviderError(error, this.#secrets);
    }
  }
}

export {
  AnthropicFamilyProvider,
  bedrockClientFactory,
  compatibleClientFactory,
  nativeClientFactory,
  vertexClientFactory,
  type AnthropicClient,
  type AnthropicClientFactory,
  type AnthropicRequestOptions,
  type BedrockAuth,
  type VertexAuth,
};
```

- [ ] **Step 4: Run the adapter tests**

Run: `yarn vitest run test/ai/providers/anthropic.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the adapter against the real SDK types**

Run: `yarn run prebuild`
Expected: exit 0. If the SDK client `messages.parse` return type does not satisfy `normalizeResponse`'s parameter, widen the `normalizeResponse` parameter field types (they are already `string | null` / `number | null` tolerant) rather than casting the client.

- [ ] **Step 6: Commit**

```bash
git add src/ai/providers/anthropic.ts test/ai/providers/anthropic.test.ts
git commit -m "feat: parameterize anthropic adapter by transport"
```

---

## Task 4: Parse and validate the new providers and cloud inputs

Add the three provider values and the cloud-credential fields to config. Bedrock and Vertex do not require `ai_api_key`; for them `apiKey` is set to the empty string (Task 2 makes empty secrets harmless). Base-URL providers and key-based providers keep their existing requirements.

**Files:**

- Modify: `src/config.ts:3` (enum), `:16-29` (type), `:115-173` (parsing)
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, replace the `it.each(["anthropic", "openai", "openai-compatible"] ...)` block (the "accepts the %s provider" test) with this and add the new tests after it:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run test/config.test.ts`
Expected: FAIL — the enum rejects the new providers and the new fields/requirements do not exist.

- [ ] **Step 3: Extend the enum and the config type**

In `src/config.ts`, replace line 3:

```ts
const aiProviderSchema = z.enum([
  "anthropic",
  "anthropic-bedrock",
  "anthropic-compatible",
  "anthropic-vertex",
  "openai",
  "openai-compatible",
]);
```

Replace the `EnabledAiConfig` type (lines 16-29) with (fields kept alphabetical):

```ts
type EnabledAiConfig = {
  apiKey: string;
  awsAccessKeyId?: string;
  awsRegion?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  baseUrl?: string;
  enabled: true;
  forbiddenPatterns: readonly string[];
  gcpProject?: string;
  gcpRegion?: string;
  gcpServiceAccountJson?: string;
  immutablePatterns: readonly string[];
  label: string;
  maxConflictedFiles: number;
  maxResolutionLines: number;
  model: string;
  provider: AiProviderName;
  timeoutMs: number;
  validationCommands: readonly string[];
};
```

- [ ] **Step 4: Extend the parsing and validation**

In `src/config.ts`, immediately after the `aiProviderSchema`/`stringArraySchema` declarations, add the provider classification sets:

```ts
const keyBasedProviders = new Set([
  "anthropic",
  "anthropic-compatible",
  "openai",
  "openai-compatible",
]);

const baseUrlProviders = new Set(["anthropic-compatible", "openai-compatible"]);
```

Replace the body of `readAiConfig` from the `const provider = providerResult.data;` line through the closing `};` of its `return` (lines 129-172) with:

```ts
const provider = providerResult.data;
const optional = (name: string): string | undefined => {
  const value = reader.get(name).trim();
  return value.length > 0 ? value : undefined;
};

const baseUrl = reader.get("ai_base_url").trim();

if (baseUrlProviders.has(provider) && baseUrl.length === 0) {
  throw new Error(
    `Input "ai_base_url" is required for the ${provider} provider.`,
  );
}

if (
  provider === "anthropic-bedrock" &&
  optional("ai_aws_region") === undefined
) {
  throw new Error(
    'Input "ai_aws_region" is required for the anthropic-bedrock provider.',
  );
}

if (provider === "anthropic-vertex") {
  if (optional("ai_gcp_project") === undefined) {
    throw new Error(
      'Input "ai_gcp_project" is required for the anthropic-vertex provider.',
    );
  }

  if (optional("ai_gcp_region") === undefined) {
    throw new Error(
      'Input "ai_gcp_region" is required for the anthropic-vertex provider.',
    );
  }
}

const awsAccessKeyId = optional("ai_aws_access_key_id");
const awsRegion = optional("ai_aws_region");
const awsSecretAccessKey = optional("ai_aws_secret_access_key");
const awsSessionToken = optional("ai_aws_session_token");
const gcpProject = optional("ai_gcp_project");
const gcpRegion = optional("ai_gcp_region");
const gcpServiceAccountJson = optional("ai_gcp_service_account_json");

return {
  apiKey: keyBasedProviders.has(provider)
    ? getRequiredInput(reader, "ai_api_key")
    : "",
  ...(awsAccessKeyId ? { awsAccessKeyId } : {}),
  ...(awsRegion ? { awsRegion } : {}),
  ...(awsSecretAccessKey ? { awsSecretAccessKey } : {}),
  ...(awsSessionToken ? { awsSessionToken } : {}),
  ...(baseUrl.length > 0 ? { baseUrl } : {}),
  enabled: true,
  forbiddenPatterns: parseStringArray({
    fallback: [],
    name: "ai_forbidden_patterns",
    reader,
  }),
  ...(gcpProject ? { gcpProject } : {}),
  ...(gcpRegion ? { gcpRegion } : {}),
  ...(gcpServiceAccountJson ? { gcpServiceAccountJson } : {}),
  immutablePatterns: parseStringArray({
    fallback: ["**/migrations/**", "**/migration/**"],
    name: "ai_immutable_patterns",
    reader,
  }),
  label: reader.get("ai_label").trim() || "AI backport",
  maxConflictedFiles: parsePositiveInteger(
    reader,
    "ai_max_conflicted_files",
    3,
  ),
  maxResolutionLines: parsePositiveInteger(
    reader,
    "ai_max_resolution_lines",
    60,
  ),
  model: getRequiredInput(reader, "ai_model"),
  provider,
  timeoutMs: parsePositiveInteger(reader, "ai_timeout_seconds", 120) * 1000,
  validationCommands: parseStringArray({
    fallback: [],
    name: "ai_validation_commands",
    reader,
    requireValues: true,
  }),
};
```

Also update the unsupported-provider error message (lines 123-127) so it lists all six values:

```ts
if (!providerResult.success) {
  throw new Error(
    'Input "ai_provider" must be one of "anthropic", "anthropic-bedrock", "anthropic-compatible", "anthropic-vertex", "openai", or "openai-compatible".',
  );
}
```

- [ ] **Step 5: Run the config tests**

Run: `yarn vitest run test/config.test.ts`
Expected: PASS. (The existing "rejects an unsupported provider" test still passes — it asserts the error contains `ai_provider`.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: parse bedrock, vertex, and anthropic-compatible config"
```

---

## Task 5: Wire the new providers in the factory

**Files:**

- Modify: `src/ai/provider.ts`
- Modify: `test/ai/provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `test/ai/provider.test.ts` with:

```ts
// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from "vitest";
import { createModelProvider } from "../../src/ai/provider.js";
import { AnthropicFamilyProvider } from "../../src/ai/providers/anthropic.js";
import { OpenAiCompatibleProvider } from "../../src/ai/providers/openai-compatible.js";
import { OpenAiProvider } from "../../src/ai/providers/openai.js";
import type { EnabledAiConfig } from "../../src/config.js";

const config = (provider: EnabledAiConfig["provider"]): EnabledAiConfig => ({
  apiKey: "secret",
  enabled: true,
  forbiddenPatterns: [],
  immutablePatterns: ["**/migrations/**"],
  label: "AI backport",
  maxConflictedFiles: 3,
  maxResolutionLines: 60,
  model: "small-model",
  provider,
  timeoutMs: 120_000,
  validationCommands: ["yarn test"],
  ...(provider === "openai-compatible" || provider === "anthropic-compatible"
    ? { baseUrl: "https://models.example.test/v1" }
    : {}),
  ...(provider === "anthropic-bedrock" ? { awsRegion: "us-east-1" } : {}),
  ...(provider === "anthropic-vertex"
    ? { gcpProject: "demo-project", gcpRegion: "us-central1" }
    : {}),
});

describe("createModelProvider", () => {
  it("creates an Anthropic adapter", () => {
    expect(createModelProvider(config("anthropic"))).toBeInstanceOf(
      AnthropicFamilyProvider,
    );
  });

  it("creates an OpenAI adapter", () => {
    expect(createModelProvider(config("openai"))).toBeInstanceOf(
      OpenAiProvider,
    );
  });

  it("creates an OpenAI-compatible adapter", () => {
    expect(createModelProvider(config("openai-compatible"))).toBeInstanceOf(
      OpenAiCompatibleProvider,
    );
  });

  it.each([
    "anthropic-bedrock",
    "anthropic-compatible",
    "anthropic-vertex",
  ] as const)("creates the %s family adapter", (provider) => {
    expect(createModelProvider(config(provider))).toBeInstanceOf(
      AnthropicFamilyProvider,
    );
  });

  it("rejects an anthropic-compatible provider without a base URL", () => {
    expect(() =>
      createModelProvider({
        ...config("anthropic-compatible"),
        baseUrl: undefined,
      }),
    ).toThrow("base URL");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run test/ai/provider.test.ts`
Expected: FAIL — the factory does not yet handle the new provider values, and `AnthropicProvider` no longer exists (the import now uses `AnthropicFamilyProvider`).

- [ ] **Step 3: Rewrite the factory**

Replace the entire contents of `src/ai/provider.ts` with:

```ts
import type { EnabledAiConfig } from "../config.js";
import {
  AnthropicFamilyProvider,
  bedrockClientFactory,
  compatibleClientFactory,
  nativeClientFactory,
  vertexClientFactory,
} from "./providers/anthropic.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import { OpenAiProvider } from "./providers/openai.js";
import type { StructuredModelProvider } from "./types.js";

const createModelProvider = (
  config: EnabledAiConfig,
): StructuredModelProvider => {
  switch (config.provider) {
    case "anthropic": {
      return new AnthropicFamilyProvider({
        clientFactory: nativeClientFactory(config.apiKey),
        model: config.model,
        secrets: [config.apiKey],
      });
    }

    case "anthropic-compatible": {
      if (!config.baseUrl) {
        throw new Error(
          "An Anthropic-compatible provider requires a configured base URL.",
        );
      }

      return new AnthropicFamilyProvider({
        clientFactory: compatibleClientFactory(config.apiKey, config.baseUrl),
        model: config.model,
        secrets: [config.apiKey],
      });
    }

    case "anthropic-bedrock": {
      if (!config.awsRegion) {
        throw new Error(
          "The anthropic-bedrock provider requires an AWS region.",
        );
      }

      return new AnthropicFamilyProvider({
        clientFactory: bedrockClientFactory({
          accessKeyId: config.awsAccessKeyId,
          region: config.awsRegion,
          secretAccessKey: config.awsSecretAccessKey,
          sessionToken: config.awsSessionToken,
        }),
        model: config.model,
        secrets: [config.awsSecretAccessKey, config.awsSessionToken].filter(
          (secret): secret is string => Boolean(secret),
        ),
      });
    }

    case "anthropic-vertex": {
      if (!config.gcpProject || !config.gcpRegion) {
        throw new Error(
          "The anthropic-vertex provider requires a GCP project and region.",
        );
      }

      return new AnthropicFamilyProvider({
        clientFactory: vertexClientFactory({
          project: config.gcpProject,
          region: config.gcpRegion,
          serviceAccountJson: config.gcpServiceAccountJson,
        }),
        model: config.model,
        secrets: config.gcpServiceAccountJson
          ? [config.gcpServiceAccountJson]
          : [],
      });
    }

    case "openai": {
      return new OpenAiProvider(config);
    }

    case "openai-compatible": {
      if (!config.baseUrl) {
        throw new Error(
          "An OpenAI-compatible provider requires a configured base URL.",
        );
      }

      return new OpenAiCompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
    }
  }
};

export { createModelProvider };
```

- [ ] **Step 4: Run the factory tests**

Run: `yarn vitest run test/ai/provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider.ts test/ai/provider.test.ts
git commit -m "feat: build family adapters for new transports"
```

---

## Task 6: Declare the new action inputs

**Files:**

- Modify: `action.yml` (inputs block, lines 6-46)

- [ ] **Step 1: Add the cloud-credential inputs**

In `action.yml`, immediately after the `ai_base_url` input (line 11), insert these four AWS inputs:

```yaml
ai_aws_access_key_id:
  description: >
    Explicit AWS access key id for anthropic-bedrock. Optional; falls back to the AWS credential chain.
ai_aws_region:
  description: >
    AWS region for anthropic-bedrock. Required when ai_provider is anthropic-bedrock.
ai_aws_secret_access_key:
  description: >
    Explicit AWS secret access key for anthropic-bedrock. Optional; falls back to the AWS credential chain.
ai_aws_session_token:
  description: >
    Explicit AWS session token for anthropic-bedrock. Optional.
```

Then insert these three GCP inputs immediately after the `ai_forbidden_patterns` input (after its `default: "[]"` line):

```yaml
ai_gcp_project:
  description: >
    GCP project id for anthropic-vertex. Required when ai_provider is anthropic-vertex.
ai_gcp_region:
  description: >
    GCP region for anthropic-vertex. Required when ai_provider is anthropic-vertex.
ai_gcp_service_account_json:
  description: >
    Explicit GCP service-account JSON for anthropic-vertex. Optional; falls back to Application Default Credentials.
```

- [ ] **Step 2: Update the `ai_base_url` and `ai_provider` descriptions**

Replace the `ai_base_url` description (lines 9-11) with:

```yaml
ai_base_url:
  description: >
    Base URL for an OpenAI-compatible or Anthropic-compatible endpoint. Required when ai_provider is openai-compatible or anthropic-compatible.
```

Replace the `ai_provider` description (lines 36-39) with:

```yaml
ai_provider:
  description: >
    AI provider. Supported values are anthropic, anthropic-bedrock, anthropic-vertex, anthropic-compatible, openai, and openai-compatible.
  default: anthropic
```

- [ ] **Step 3: Confirm the build still produces the bundle**

Run:

```bash
yarn run build && test -f dist/index.js && echo "build ok"
```

Expected: `build ok`. The NCC build does not bundle `action.yml`, but a successful build confirms the new config + provider code compiles end to end.

- [ ] **Step 4: Commit**

```bash
git add action.yml
git commit -m "feat: declare cloud transport action inputs"
```

---

## Task 7: Strip cloud credentials from the validation environment

`validationEnvironment()` removes `INPUT_AI_API_KEY` and `INPUT_GITHUB_TOKEN`. Extend it to the new credential inputs and the ambient cloud variables the SDKs read, so validation commands never inherit model credentials. Export the function so it can be unit-tested directly.

**Files:**

- Modify: `src/workspace.ts:20-27`
- Modify: `src/workspace.ts:165` (export list)
- Modify: `test/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/workspace.test.ts`, add this import after the existing `GitBackportWorkspace` import (line 8):

```ts
import { validationEnvironment } from "../src/workspace.js";
```

Then add a new top-level `describe` block after the existing one (after line 130):

```ts
describe("validationEnvironment", () => {
  const withEnv = <T,>(overrides: Record<string, string>, run: () => T): T => {
    const saved = { ...process.env };
    Object.assign(process.env, overrides);
    try {
      return run();
    } finally {
      for (const key of Object.keys(overrides)) {
        delete process.env[key];
      }

      Object.assign(process.env, saved);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run test/workspace.test.ts`
Expected: FAIL — `validationEnvironment` is not exported, and once exported the AWS/GCP variables are not yet stripped.

- [ ] **Step 3: Extend the strip logic**

In `src/workspace.ts`, replace `validationEnvironment` (lines 20-27) with:

```ts
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
```

Update the export at line 165:

```ts
export { GitBackportWorkspace, validationEnvironment, type ValidationRunner };
```

- [ ] **Step 4: Run the workspace tests**

Run: `yarn vitest run test/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts test/workspace.test.ts
git commit -m "feat: strip cloud credentials from validation env"
```

---

## Task 8: Add live smoke cases for each new transport

Extend the on-demand live smoke (excluded from the default suite) with one skipped-unless-credentialed case per new transport. A transport is only marked supported in the docs after it passes here.

**Files:**

- Modify: `scripts/provider-smoke.live.ts`

- [ ] **Step 1: Add the new smoke cases**

In `scripts/provider-smoke.live.ts`, inside the `describe("live provider smoke", ...)` block, after the existing `openai-compatible` case and before the closing `});` (line 156), add:

```ts
const anthropicCompatKey = env.SMOKE_ANTHROPIC_COMPAT_API_KEY;
const anthropicCompatBase = env.SMOKE_ANTHROPIC_COMPAT_BASE_URL;
const anthropicCompatModel = env.SMOKE_ANTHROPIC_COMPAT_MODEL;
it.runIf(
  Boolean(anthropicCompatKey && anthropicCompatBase && anthropicCompatModel),
)(
  "anthropic-compatible returns strict structured output",
  async () => {
    const config: EnabledAiConfig = {
      ...baseConfig,
      apiKey: anthropicCompatKey!,
      baseUrl: anthropicCompatBase!,
      model: anthropicCompatModel!,
      provider: "anthropic-compatible",
    };
    await smoke("anthropic-compatible", createModelProvider(config), config);
  },
  timeoutMs,
);

const bedrockRegion = env.SMOKE_AWS_REGION;
const bedrockModel = env.SMOKE_BEDROCK_MODEL;
it.runIf(Boolean(bedrockRegion && bedrockModel))(
  "anthropic-bedrock returns strict structured output",
  async () => {
    const config: EnabledAiConfig = {
      ...baseConfig,
      apiKey: "",
      awsRegion: bedrockRegion!,
      model: bedrockModel!,
      provider: "anthropic-bedrock",
    };
    await smoke("anthropic-bedrock", createModelProvider(config), config);
  },
  timeoutMs,
);

const vertexProject = env.SMOKE_GCP_PROJECT;
const vertexRegion = env.SMOKE_GCP_REGION;
const vertexModel = env.SMOKE_VERTEX_MODEL;
it.runIf(Boolean(vertexProject && vertexRegion && vertexModel))(
  "anthropic-vertex returns strict structured output",
  async () => {
    const config: EnabledAiConfig = {
      ...baseConfig,
      apiKey: "",
      gcpProject: vertexProject!,
      gcpRegion: vertexRegion!,
      model: vertexModel!,
      provider: "anthropic-vertex",
    };
    await smoke("anthropic-vertex", createModelProvider(config), config);
  },
  timeoutMs,
);
```

- [ ] **Step 2: Confirm the default suite still ignores the live file and that it compiles**

Run:

```bash
yarn test
yarn run prebuild
```

Expected: `yarn test` PASS without running the live file (its name ends in `.live.ts`); `prebuild` exit 0 (the new cases typecheck against the extended `EnabledAiConfig`).

- [ ] **Step 3: Commit**

```bash
git add scripts/provider-smoke.live.ts
git commit -m "test: add live smoke for new transports"
```

---

## Task 9: Document the new transports and run final verification

**Files:**

- Modify: `README.md` (Provider Configuration, Validation note, Inputs table)

- [ ] **Step 1: Add the new provider sections**

In `README.md`, after the `### OpenAI-Compatible` block and its trailing paragraph (after line 120), insert:

````markdown
### Anthropic-Compatible

```yaml
ai_provider: anthropic-compatible
ai_model: <claude-model>
ai_api_key: ${{ secrets.AI_API_KEY }}
ai_base_url: https://anthropic-proxy.example.com
```

The proxy must implement the Anthropic Messages API including `output_config`
structured outputs. The action does not fall back to plain-text JSON.

### Claude on Bedrock

```yaml
ai_provider: anthropic-bedrock
ai_model: anthropic.claude-3-5-sonnet-20241022-v2:0
ai_aws_region: us-east-1
# Optional explicit credentials; otherwise the AWS credential chain is used.
ai_aws_access_key_id: ${{ secrets.AI_AWS_ACCESS_KEY_ID }}
ai_aws_secret_access_key: ${{ secrets.AI_AWS_SECRET_ACCESS_KEY }}
```

### Claude on Vertex AI

```yaml
ai_provider: anthropic-vertex
ai_model: claude-3-5-sonnet-v2@20241022
ai_gcp_project: my-project-id
ai_gcp_region: us-central1
# Optional explicit service account; otherwise Application Default Credentials are used.
ai_gcp_service_account_json: ${{ secrets.AI_GCP_SERVICE_ACCOUNT_JSON }}
```

Bedrock and Vertex do not use `ai_api_key`.

### Google Gemini and Cloudflare Workers AI

Google Gemini and Cloudflare native models reach the action through the
existing `openai-compatible` provider plus `ai_base_url`; no provider-specific
code exists for them. A target is supported only after it passes the live smoke
in `scripts/provider-smoke.live.ts` with real strict structured output. Any
endpoint that cannot return a populated strict `parsed` result is unsupported,
because the action never falls back to plain-text JSON.
````

- [ ] **Step 2: Update the Validation environment note**

Replace the paragraph at lines 158-159 with:

```markdown
`INPUT_AI_API_KEY`, `INPUT_GITHUB_TOKEN`, the cloud credential inputs
(`INPUT_AI_AWS_*`, `INPUT_AI_GCP_SERVICE_ACCOUNT_JSON`), and ambient cloud
variables (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`) are removed from
validation command environments.
```

- [ ] **Step 3: Update the Inputs table**

Replace the `ai_provider`, `ai_api_key`, and `ai_base_url` rows (lines 168, 170, 171) and add the cloud rows directly after `ai_base_url`:

```markdown
| `ai_provider` | `anthropic` | `anthropic`, `anthropic-bedrock`, `anthropic-vertex`, `anthropic-compatible`, `openai`, `openai-compatible` |
| `ai_model` | None | Provider model identifier |
| `ai_api_key` | None | Provider API key (not used by bedrock or vertex) |
| `ai_base_url` | None | Required for openai-compatible and anthropic-compatible |
| `ai_aws_region` | None | Required for anthropic-bedrock |
| `ai_aws_access_key_id` | None | Optional explicit Bedrock credential |
| `ai_aws_secret_access_key`| None | Optional explicit Bedrock credential |
| `ai_aws_session_token` | None | Optional explicit Bedrock credential |
| `ai_gcp_project` | None | Required for anthropic-vertex |
| `ai_gcp_region` | None | Required for anthropic-vertex |
| `ai_gcp_service_account_json` | None | Optional explicit Vertex credential |
```

- [ ] **Step 4: Run the full verification suite**

Run:

```bash
yarn test && yarn run build && test -f dist/index.js && yarn run prettier --check && yarn run xo
```

Expected: all green — tests pass, bundle builds, prettier reports no changes, xo reports no errors. Fix any prettier formatting with `yarn run prettier --write` and re-run; fix any xo findings before proceeding.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document multi-transport providers"
```

---

## Self-Review (completed during planning)

**Spec coverage:**

- Three new provider values → Task 4 (config enum), Task 5 (factory).
- Transport-parameterized family with shared `generate()` + client factory → Task 3.
- Credentials: standard chain plus explicit keys → Task 3 (`bedrockClientFactory` chain vs `providerChainResolver`; `vertexClientFactory` ADC vs `GoogleAuth`), Task 4 (parsing).
- New action inputs → Task 6.
- Redaction of AWS secret + GCP SA JSON → Task 2 (multi-secret) + Task 5 (secrets list per transport).
- Validation-env stripping of new inputs + ambient cloud vars → Task 7.
- New deps → Task 1.
- Mocked adapter tests per transport → Task 3 (construction/mapping/redaction via injected factory) + Task 5 (factory wiring).
- Live smoke per transport → Task 8.
- Gemini/Cloudflare via openai-compatible, smoke-gated, documented → Task 9.
- No plaintext fallback / no per-vendor adapters → nothing added that violates this; documented in Task 9.

**Placeholder scan:** none — every code step shows complete content.

**Type consistency:** `AnthropicFamilyProvider`, `AnthropicRequestOptions` (`{ maxRetries, timeout }`), `AnthropicClientFactory`, the four factory builders, `BedrockAuth` (`accessKeyId?`, `region`, `secretAccessKey?`, `sessionToken?`), `VertexAuth` (`project`, `region`, `serviceAccountJson?`), and the new `EnabledAiConfig` fields (`awsAccessKeyId`, `awsRegion`, `awsSecretAccessKey`, `awsSessionToken`, `gcpProject`, `gcpRegion`, `gcpServiceAccountJson`) are used identically across Tasks 3, 4, 5, and 8. `normalizeProviderError(error, secrets)` signature matches all call sites after Task 2.
