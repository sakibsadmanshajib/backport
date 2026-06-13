# Multi-Transport Provider Adapters Design

**Status: APPROVED (design phase).** Follow-on to
`2026-06-12-ai-assisted-backport-design.md`. Extends the provider layer only.

## Goal

Reach more model hosts without coupling core backport logic to any vendor.
Specifically: run Claude through Anthropic-API-compatible proxies/gateways, run
Claude natively on AWS Bedrock and GCP Vertex AI, and reach Google Gemini and
Cloudflare Workers AI native models, all while keeping the existing strict
structured-output guarantee (no plaintext JSON fallback).

## Guiding Insight

Adapters map to API **shapes**, not to vendors. Two shapes cover the field:

- **OpenAI shape** (`chat.completions` / `responses` + strict `json_schema`):
  already handled by the existing `openai` and `openai-compatible` adapters.
  Google Gemini (OpenAI-compat endpoint), Cloudflare Workers AI, Azure, Groq,
  Together, and OpenRouter are reached here through `base_url`.
- **Anthropic shape** (Messages API + structured outputs): Claude models only,
  wherever hosted (native, Bedrock, Vertex, or an Anthropic-API proxy).

Therefore the only genuinely new code is on the Anthropic side. Google and
Cloudflare native models require **no new adapter**; they are configuration of
the existing `openai-compatible` adapter.

## Decisions

1. **Approach A: transport-parameterized Anthropic family.** One shared
   provider implementation with a client factory keyed by transport
   (`native | bedrock | vertex | compatible`). Request mapping, stop-reason
   handling, schema validation, and credential redaction are identical across
   transports; only client construction and authentication differ. The OpenAI
   side is untouched.
2. **Credentials: standard chain plus optional explicit keys.** Bedrock uses the
   AWS credential chain (OIDC role or runner env) by default and also accepts
   explicit AWS access key id and secret. Vertex uses Google Application Default
   Credentials by default and also accepts an explicit service-account JSON.
   Region (and Vertex project) are always explicit inputs.
3. **Weak targets are documented, never special-cased.** Gemini and Cloudflare
   native are listed as `openai-compatible` plus `base_url`. A target ships only
   if it proves strict structured output through the live smoke harness. Any
   endpoint that cannot return a populated strict `parsed` result is documented
   as unsupported. This preserves the no-plaintext-fallback principle.

## Research Findings (load-bearing)

- `@anthropic-ai/bedrock-sdk` (`AnthropicBedrock`) and `@anthropic-ai/vertex-sdk`
  (`AnthropicVertex`) extend the same base client, so both inherit
  `messages.parse` and the `output_config` / `zodOutputFormat` structured-output
  path. Auth is AWS SigV4 chain plus region for Bedrock, and Google ADC plus
  project and region for Vertex.
- Anthropic structured outputs are GA on the native API. Availability over
  Bedrock and Vertex is not explicitly documented even though the SDKs inherit
  the path, so each must be confirmed by live smoke before being marked
  supported.
- `new Anthropic({ baseURL })` with a bearer token reaches Anthropic-API
  compatible proxies, but only if the proxy implements the Anthropic API
  signature including `output_config`.
- Gemini's OpenAI-compatible endpoint and Cloudflare Workers AI support
  `response_format` json_schema, but strict-mode `parsed` population is
  unconfirmed. Treat as smoke-gated.

## Architecture

### Provider values

`config.provider` gains: `anthropic-bedrock`, `anthropic-vertex`,
`anthropic-compatible`. Existing `anthropic`, `openai`, `openai-compatible`
remain.

### Anthropic family module

Refactor `src/ai/providers/anthropic.ts` into:

- A shared `generate()` that maps `StructuredModelRequest` to
  `messages.parse({ output_config: { format: zodOutputFormat(schema) } })`,
  handles stop reasons (`refusal`, `max_tokens`, `pause_turn`), runs
  `validateParsedOutput`, and routes errors through `normalizeProviderError`.
  This already exists and is reused unchanged.
- A `clientFactory` keyed by transport that constructs `Anthropic`,
  `AnthropicBedrock`, `AnthropicVertex`, or `Anthropic({ baseURL })`. All return
  the same minimal `{ messages: { parse } }` surface the existing code expects,
  so the success and failure handling does not branch per transport.

The factory in `src/ai/provider.ts` adds the three new cases, each constructing
the family provider with the right transport and config.

### Config and inputs

`src/config.ts` parses the new inputs strictly and builds a transport-specific
`EnabledAiConfig`. New `action.yml` inputs (all optional unless required by the
chosen provider):

| Input                         | Used by                                 | Notes                         |
| ----------------------------- | --------------------------------------- | ----------------------------- |
| `ai_aws_region`               | anthropic-bedrock                       | Required for Bedrock          |
| `ai_aws_access_key_id`        | anthropic-bedrock                       | Optional; falls back to chain |
| `ai_aws_secret_access_key`    | anthropic-bedrock                       | Optional; falls back to chain |
| `ai_aws_session_token`        | anthropic-bedrock                       | Optional                      |
| `ai_gcp_project`              | anthropic-vertex                        | Required for Vertex           |
| `ai_gcp_region`               | anthropic-vertex                        | Required for Vertex           |
| `ai_gcp_service_account_json` | anthropic-vertex                        | Optional; falls back to ADC   |
| `ai_base_url`                 | anthropic-compatible, openai-compatible | Required for these            |

`ai_api_key` remains the bearer for `anthropic`, `anthropic-compatible`,
`openai`, and `openai-compatible`. Bedrock and Vertex do not use `ai_api_key`.

### Data flow

Unchanged. Cherry-pick, sibling reuse, conflict context, policy, one resolution
request, deterministic validation, one read-only review, draft PR or handoff.
The provider abstraction means orchestration, prompts, and the Zod schema do not
change.

## Security

- Cloud credentials and bearer keys are never placed in prompts or comments, the
  same as today.
- `normalizeProviderError` already redacts the configured bearer key from error
  messages. Extend redaction so explicit AWS secret and GCP service-account JSON
  values are also stripped from any surfaced error text.
- `src/workspace.ts` strips `INPUT_AI_API_KEY` and `INPUT_GITHUB_TOKEN` from the
  validation command environment. Extend the strip list to the new credential
  inputs (`INPUT_AI_AWS_*`, `INPUT_AI_GCP_SERVICE_ACCOUNT_JSON`) and to ambient
  cloud variables the SDKs read (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`) so
  validation commands never inherit model credentials.
- AI pull requests remain drafts. No auto-merge.

## Verification

- Mocked adapter unit tests for each new transport, mirroring the existing
  provider tests (inject a fake client factory, assert request shape, stop-reason
  handling, schema rejection, and error redaction).
- Extend `scripts/provider-smoke.live.ts` with one case per new transport, each
  skipped unless its credentials are present. A transport is marked supported
  only after it passes the smoke (real strict structured output end to end).
- Gemini and Cloudflare native are smoke cases under `openai-compatible`. If they
  fail strict output, they are documented as unsupported and no code is added.

## Out of Scope

- No plaintext JSON fallback and no tool-use forcing for endpoints that lack
  strict structured output.
- No per-vendor adapters for Google or Cloudflare; they reuse
  `openai-compatible`.
- No change to cherry-pick, sibling reuse, policy, prompts, schema, or the
  draft-PR and handoff reporting.

## Risks

- Structured outputs on Bedrock and Vertex are not doc-confirmed; the smoke gate
  is the mitigation. If a transport fails, it ships disabled with a documented
  reason rather than a degraded path.
- Explicit cloud key inputs enlarge the secret surface; mitigated by redaction
  and validation-environment stripping.
- Added dependencies (`@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`)
  pull AWS and GCP auth libraries, increasing bundle size. Acceptable for an
  opt-in feature.
