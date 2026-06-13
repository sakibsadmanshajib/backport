# AI-Assisted Backport Implementation Plan

> **Status: HISTORICAL (completed).** This plan has been fully implemented and
> merged into the branch history. The unchecked checkboxes below were never
> ticked during execution and are retained only as a record of the original
> task breakdown. Git history and the passing test suite are the source of
> truth for what shipped, not these boxes. See `HANDOFF.md` for current state.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral, policy-constrained AI conflict resolution to the
backport action, with Anthropic, OpenAI, and OpenAI-compatible adapters, draft
AI pull requests, and explicit human escalation.

**Architecture:** Keep git, GitHub, policy, prompts, and orchestration independent
from model vendors. Provider adapters accept one structured request contract and
return one normalized result. The action first attempts a normal cherry-pick,
then deterministic sibling reuse, then one small-model resolution and one
read-only review, with deterministic validation controlling acceptance.

**Tech Stack:** TypeScript, Node.js 24, GitHub Actions Toolkit, Anthropic
TypeScript SDK, OpenAI TypeScript SDK, Zod, Vitest, native git CLI, NCC.

**Design:** `docs/superpowers/specs/2026-06-12-ai-assisted-backport-design.md`

---

## File Structure

### Existing Files To Modify

- `action.yml`: expose AI inputs and move the runtime to Node 24.
- `package.json`: add tests, provider SDKs, Zod, glob/diff helpers, and modern
  build scripts.
- `yarn.lock`: lock new dependencies.
- `tsconfig.json`: include tests while preserving strict production checks.
- `.github/workflows/test.yml`: use current checkout/setup actions and run tests.
- `src/index.ts`: parse configuration and invoke the orchestrator.
- `src/backport.ts`: retain only top-level multi-destination orchestration.
- `README.md`: document normal, AI-assisted, and escalation behavior.
- `dist/index.js`: rebuild the committed JavaScript action bundle.
- `dist/package.json`: regenerate with NCC.

### New Production Files

- `src/config.ts`: parse and validate normal and AI action inputs.
- `src/domain.ts`: shared backport result and destination types.
- `src/git.ts`: injectable git command gateway and repository operations.
- `src/github.ts`: injectable GitHub gateway for PRs, labels, comments, and
  sibling discovery.
- `src/reporting.ts`: regular PR, AI PR, warning, and handoff text.
- `src/conflicts/types.ts`: normalized conflict and sibling evidence.
- `src/conflicts/context.ts`: build source, parent, merge-base, stage, history,
  blame, and conflict-hunk context.
- `src/conflicts/policy.ts`: preflight eligibility and post-resolution checks.
- `src/conflicts/sibling-resolution.ts`: strict deterministic sibling reuse.
- `src/ai/types.ts`: provider-neutral model contracts and normalized failures.
- `src/ai/schema.ts`: Zod resolution and review schemas.
- `src/ai/prompts.ts`: shared provider-neutral resolver and reviewer prompts.
- `src/ai/provider.ts`: provider factory.
- `src/ai/providers/anthropic.ts`: Anthropic structured-output adapter.
- `src/ai/providers/openai.ts`: OpenAI Responses structured-output adapter.
- `src/ai/providers/openai-compatible.ts`: strict Chat Completions adapter with
  configurable base URL.
- `src/ai/resolver.ts`: exactly one resolution call and one review call.

### New Test Files

- `test/config.test.ts`
- `test/ai/schema.test.ts`
- `test/ai/prompts.test.ts`
- `test/ai/providers/anthropic.test.ts`
- `test/ai/providers/openai.test.ts`
- `test/ai/providers/openai-compatible.test.ts`
- `test/ai/resolver.test.ts`
- `test/conflicts/context.test.ts`
- `test/conflicts/policy.test.ts`
- `test/conflicts/sibling-resolution.test.ts`
- `test/reporting.test.ts`
- `test/backport.integration.test.ts`
- `test/helpers/git-repository.ts`
- `test/helpers/fakes.ts`
- `test/fixtures/enum-conflict/*`
- `test/fixtures/tenant-setting-conflict/*`
- `test/fixtures/migration-conflict/*`
- `test/fixtures/test-omission/*`

## Chunk 1: Runtime, Configuration, and Provider Boundary

### Task 1: Establish Node 24 and the Test Harness

**Files:**

- Modify: `action.yml`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.github/workflows/test.yml`
- Modify: `yarn.lock`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: Write a failing smoke test**

Create `test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs on Node 24 or newer", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(
      24,
    );
  });
});
```

- [ ] **Step 2: Add the test command and verify the initial failure**

Add `"test": "vitest run"` to `package.json`, then run:

```bash
yarn test
```

Expected: FAIL because Vitest is not installed.

- [ ] **Step 3: Install the minimum dependencies**

Run:

```bash
yarn add @anthropic-ai/sdk openai zod minimatch diff
yarn add --dev vitest
```

Do not add an AI framework or gateway dependency.

- [ ] **Step 4: Upgrade the action runtime and CI**

Set:

```yaml
runs:
  using: node24
  main: dist/index.js
```

Update `.github/workflows/test.yml` to use `actions/checkout@v4`,
`actions/setup-node@v4` with Node 24 and Yarn cache, then run:

```yaml
- run: yarn install --frozen-lockfile
- run: yarn test
- run: yarn run build
- run: yarn run prettier --check
- run: yarn run xo
- run: git diff --exit-code -- dist
```

- [ ] **Step 5: Run the harness**

Run:

```bash
yarn test
yarn run build
yarn run prettier --check
yarn run xo
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add action.yml package.json yarn.lock tsconfig.json .github/workflows/test.yml test/smoke.test.ts
git commit -m "build: add Node 24 test harness"
```

### Task 2: Parse and Validate AI Configuration

**Files:**

- Create: `src/config.ts`
- Create: `test/config.test.ts`
- Modify: `src/index.ts`
- Modify: `action.yml`

- [ ] **Step 1: Write failing configuration tests**

Cover:

```ts
it("keeps AI disabled by default");
it.each(["anthropic", "openai", "openai-compatible"])("accepts provider %s");
it("requires model, key, and validation commands when AI is enabled");
it("requires base URL only for openai-compatible");
it("rejects invalid JSON arrays");
it("rejects zero or negative limits");
it("redacts the API key from serialized config");
```

Use an injectable input reader:

```ts
export interface InputReader {
  get(name: string, options?: { required?: boolean }): string;
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
yarn test test/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Implement typed configuration**

Define:

```ts
export type AiProviderName = "anthropic" | "openai" | "openai-compatible";

export interface AiConfig {
  enabled: boolean;
  provider: AiProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string;
  label: string;
  maxConflictedFiles: number;
  maxResolutionLines: number;
  timeoutMs: number;
  validationCommands: readonly string[];
  immutablePatterns: readonly string[];
  forbiddenPatterns: readonly string[];
}
```

Parse booleans strictly as `"true"` or `"false"`. Parse array inputs with Zod.
Default immutable patterns:

```ts
["**/migrations/**", "**/migration/**"];
```

Default hard-forbidden paths in policy, not removable:

```ts
[
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
];
```

Parse `ai_forbidden_patterns` as additional repository-specific patterns. These
extend, but cannot replace, the built-in list.

- [ ] **Step 4: Add action inputs**

Add the approved inputs to `action.yml`, keeping `ai_enabled` defaulted to
`"false"`. Mark provider credentials as conditionally required in their
descriptions because action metadata cannot express conditional requirements.

- [ ] **Step 5: Replace direct `getInput` usage**

Have `src/index.ts` construct the configuration once and pass it into
`backport`. Never log the raw config object.

- [ ] **Step 6: Run targeted and existing checks**

```bash
yarn test test/config.test.ts
yarn run build
yarn run xo
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/index.ts action.yml test/config.test.ts
git commit -m "feat: add AI backport configuration"
```

### Task 3: Define Strict Structured Model Contracts

**Files:**

- Create: `src/ai/types.ts`
- Create: `src/ai/schema.ts`
- Create: `test/ai/schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Test valid `resolved`, valid `escalate`, valid review approval, and rejection of:

- unknown fields
- missing fields
- duplicate file paths
- files on `escalate`
- empty reasons
- malformed roles

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
yarn test test/ai/schema.test.ts
```

- [ ] **Step 3: Implement the contracts**

Use strict Zod objects:

```ts
export const resolutionDecisionSchema = z
  .object({
    decision: z.enum(["resolved", "escalate"]),
    summary: z.string().min(1),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          content: z.string(),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
  })
  .strict()
  .superRefine(/* decision and duplicate-path invariants */);
```

Define a similarly strict `reviewDecisionSchema` with:

```ts
{
  decision: "approve" | "reject";
  summary: string;
  findings: string[];
}
```

Define `StructuredModelProvider.generate<T>()` around a Zod schema, normalized
messages, timeout, and output-token limit. Normalize provider failure categories
to:

```ts
"refusal" | "incomplete" | "timeout" | "invalid-output" | "provider-error";
```

- [ ] **Step 4: Run tests**

```bash
yarn test test/ai/schema.test.ts
yarn run xo
```

- [ ] **Step 5: Commit**

```bash
git add src/ai/types.ts src/ai/schema.ts test/ai/schema.test.ts
git commit -m "feat: define structured AI contracts"
```

### Task 4: Implement All Three Provider Adapters

**Files:**

- Create: `src/ai/provider.ts`
- Create: `src/ai/providers/anthropic.ts`
- Create: `src/ai/providers/openai.ts`
- Create: `src/ai/providers/openai-compatible.ts`
- Create: `test/ai/providers/anthropic.test.ts`
- Create: `test/ai/providers/openai.test.ts`
- Create: `test/ai/providers/openai-compatible.test.ts`
- Create: `test/helpers/fakes.ts`

- [ ] **Step 1: Write failing adapter contract tests**

For each adapter test:

- system and user messages map correctly
- configured model and timeout are used
- structured output is parsed through the supplied Zod schema
- refusal is normalized
- incomplete/token-limit output is normalized
- SDK/API errors are sanitized
- usage is normalized without requiring it
- API keys never appear in thrown messages

The compatible adapter must also test the configured base URL and reject a
response that lacks strict structured-output support.

- [ ] **Step 2: Run tests and confirm failure**

```bash
yarn test test/ai/providers
```

- [ ] **Step 3: Implement the Anthropic adapter**

Use:

```ts
client.messages.parse({
  model,
  max_tokens: maxOutputTokens,
  system,
  messages,
  output_config: {
    format: zodOutputFormat(schema),
  },
});
```

Inject a narrow client interface for tests. Treat missing `parsed_output`,
refusal stop reasons, and incomplete output as normalized failures.

- [ ] **Step 4: Implement the native OpenAI adapter**

Use the Responses API:

```ts
client.responses.parse({
  model,
  instructions: system,
  input: messages,
  max_output_tokens: maxOutputTokens,
  text: {
    format: zodTextFormat(schema, schemaName),
  },
});
```

Handle `response.status !== "completed"`, refusal content, absent
`output_parsed`, and SDK parse errors without retrying.

- [ ] **Step 5: Implement the OpenAI-compatible adapter**

Use an OpenAI client configured with `baseURL` and strict Chat Completions:

```ts
client.chat.completions.parse({
  model,
  messages,
  response_format: zodResponseFormat(schema, schemaName),
});
```

Do not fall back to unconstrained text or manually extracted JSON. A capability
or schema error becomes `provider-error` or `invalid-output`.

- [ ] **Step 6: Implement the provider factory**

The factory switches only on `AiProviderName`. Backport code must never import a
concrete adapter.

- [ ] **Step 7: Run adapter tests and type checks**

```bash
yarn test test/ai/providers
yarn run build
yarn run xo
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ai test/ai/providers test/helpers/fakes.ts
git commit -m "feat: add provider-neutral model adapters"
```

## Chunk 2: Conflict Evidence and Safety Policy

### Task 5: Build an Injectable Git Gateway

**Files:**

- Create: `src/git.ts`
- Create: `src/conflicts/types.ts`
- Create: `test/helpers/git-repository.ts`
- Create: `test/conflicts/context.test.ts`
- Create: `src/conflicts/context.ts`

- [ ] **Step 1: Create temporary-repository helpers**

The helper must initialize a repository, configure a local test identity, create
commits and branches, and expose commit IDs without touching global git config.

- [ ] **Step 2: Write failing conflict-context tests**

Create actual repositories for:

- one-line enum insertion conflict
- import/path conflict
- cleanly carried migration plus non-migration conflict

Assert collection of:

- source SHA and source parent
- destination head and merge base
- conflicted paths
- stage 1, 2, and 3 contents
- source diff
- conflict-marker hunks
- recent file history
- bounded blame around conflict ranges

- [ ] **Step 3: Implement the command gateway**

Expose narrow methods backed by `@actions/exec.getExecOutput`, including:

```ts
run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
show(revisionAndPath: string): Promise<string>;
tryCherryPick(commitSha: string): Promise<CherryPickResult>;
abortCherryPick(): Promise<void>;
continueCherryPick(): Promise<void>;
```

Commands must use repository-local `cwd`. Do not change global git config.

- [ ] **Step 4: Implement conflict collection**

Use:

```bash
git rev-parse <source>^
git rev-parse HEAD
git merge-base HEAD <source>^
git diff --name-only --diff-filter=U
git show :1:<path>
git show :2:<path>
git show :3:<path>
git show --format= --find-renames <source>
git log -n 5 --format=... -- <path>
git blame -L <start>,<end> HEAD -- <path>
```

Bound each file and history payload. If context exceeds configured limits,
return an ineligible reason instead of truncating semantic content silently.

- [ ] **Step 5: Run context tests**

```bash
yarn test test/conflicts/context.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/git.ts src/conflicts test/helpers/git-repository.ts test/conflicts/context.test.ts
git commit -m "feat: collect deterministic conflict evidence"
```

### Task 6: Enforce Eligibility and Resolution Policy

**Files:**

- Create: `src/conflicts/policy.ts`
- Create: `test/conflicts/policy.test.ts`
- Create fixture files under: `test/fixtures/`

- [ ] **Step 1: Write failing preflight policy tests**

Cover:

- one and two-line enum additions are eligible
- tenant-setting registration conflict is eligible
- migration conflict is ineligible
- dependency or lockfile conflict is ineligible
- tenancy, authorization, and security-boundary paths are ineligible
- too many conflicted files are ineligible
- generated paths are ineligible unless explicitly allowlisted

Use path patterns plus conflict-content signals. Content signals are
conservative and may reject a safe case, but must never override immutable path
rules.

- [ ] **Step 2: Write failing post-resolution tests**

Cover:

- path outside allowlist
- duplicate output path
- migration content changed even though migration did not conflict
- conflict markers remain
- `git diff --check` failure
- resolution line limit exceeded
- test file from source change omitted or deleted
- source change reduced to destination `ours`
- unexpected file mutation by a validation command

- [ ] **Step 3: Implement the policy**

Calculate adaptation size from both sides:

```ts
adaptationLines = Math.min(
  changedLines(ours, resolved),
  changedLines(theirs, resolved),
);
```

Also compare source intent:

- derive the source patch from `base -> theirs`
- derive the applied patch from `ours -> resolved`
- require every source hunk to have a corresponding touched region
- reject a conflicted result identical to `ours`
- require source test-file changes to remain present

This metric gates size; it does not prove correctness. Provider review and
repository validation remain mandatory.

- [ ] **Step 4: Run policy tests**

```bash
yarn test test/conflicts/policy.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/conflicts/policy.ts test/conflicts/policy.test.ts test/fixtures
git commit -m "feat: enforce AI backport safety policy"
```

### Task 7: Add Strict Deterministic Sibling Reuse

**Files:**

- Create: `src/github.ts`
- Create: `src/conflicts/sibling-resolution.ts`
- Create: `test/conflicts/sibling-resolution.test.ts`

- [ ] **Step 1: Write failing sibling-selection tests**

Cover:

- accepts a merged PR that references the exact source SHA and source PR
- rejects open, closed-unmerged, or mismatched-source PRs
- rejects a sibling when its base blob differs from current `ours`
- rejects a sibling that touched forbidden or unrelated files
- accepts identical base blobs and extracts only conflicted resolved files
- records stable patch ID and parent relationships as evidence

- [ ] **Step 2: Implement GitHub sibling discovery**

Read the source PR timeline and retain cross-referenced pull requests whose body
and metadata identify the source SHA and PR number. Fetch each candidate PR,
files, base SHA, head/merge SHA, state, and destination branch.

Use an injectable `GitHubGateway` so tests never call GitHub.

- [ ] **Step 3: Implement strict reuse**

For each candidate:

1. Confirm exact source identity.
2. Confirm merged status.
3. Fetch candidate base and result commits.
4. For every current conflicted path, require candidate-base blob identity with
   the current stage-2 `ours` blob.
5. Require the candidate to modify no forbidden or unrelated paths.
6. Calculate and record stable patch ID.
7. Extract candidate result content only for current conflicted paths.
8. Pass the candidate through the same post-resolution policy and validation as
   AI output.

Never use fuzzy similarity as an automatic acceptance rule.

- [ ] **Step 4: Run tests**

```bash
yarn test test/conflicts/sibling-resolution.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/conflicts/sibling-resolution.ts test/conflicts/sibling-resolution.test.ts
git commit -m "feat: reuse exact sibling backport resolutions"
```

## Chunk 3: Prompts, Resolver, Reporting, and Orchestration

### Task 8: Build Shared Prompts and the One-Attempt Resolver

**Files:**

- Create: `src/ai/prompts.ts`
- Create: `src/ai/resolver.ts`
- Create: `test/ai/prompts.test.ts`
- Create: `test/ai/resolver.test.ts`

- [ ] **Step 1: Write failing prompt tests**

Assert that prompts:

- identify repository and PR content as untrusted data
- list editable and immutable paths explicitly
- include base, ours, theirs, source diff, history, and sibling evidence
- require smallest compatible adaptation
- require escalation for ambiguity
- forbid migrations, test removal, and invented behavior
- contain no API key or token

- [ ] **Step 2: Write failing resolver tests**

Cover:

- one resolution call followed by one review call
- resolver escalation skips reviewer
- invalid resolution output escalates without retry
- failed deterministic validation skips reviewer
- reviewer rejection escalates without retry
- provider timeout or refusal escalates without retry
- approved result is returned only after final policy validation

- [ ] **Step 3: Implement prompt builders**

Keep provider role mapping out of prompts. Delimit untrusted content with
explicit tagged sections and never interpolate it into policy instructions.

- [ ] **Step 4: Implement resolver orchestration**

The resolver receives dependencies:

```ts
{
  provider: StructuredModelProvider;
  policy: ConflictPolicy;
  validationRunner: ValidationRunner;
}
```

Sequence:

```text
preflight -> generate resolution -> schema/policy -> write candidate
-> built-in checks -> configured validation -> generate review
-> final built-in checks -> accepted result
```

No loop and no retry mechanism may exist in this module.

- [ ] **Step 5: Run tests**

```bash
yarn test test/ai/prompts.test.ts test/ai/resolver.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/ai/prompts.ts src/ai/resolver.ts test/ai
git commit -m "feat: resolve and review conflicts once"
```

### Task 9: Generate Draft PR and Developer Handoff Reporting

**Files:**

- Create: `src/reporting.ts`
- Create: `test/reporting.test.ts`
- Modify: `src/github.ts`

- [ ] **Step 1: Write failing reporting tests**

Assert AI success text includes:

- AI warning
- provider and model
- source PR and commit
- destination branch
- changed files
- validation commands and outcomes
- assumptions, risks, and reviewer findings
- explicit human review requirement

Assert handoff text includes:

- exact failed stage and reason
- conflict paths
- source, parent, merge base, and destination
- manual worktree/cherry-pick commands
- no API key, complete file content, or raw provider response

- [ ] **Step 2: Implement reporting**

Return structured report inputs and render Markdown at the boundary. Sanitize
provider messages and cap error length.

- [ ] **Step 3: Add GitHub operations**

Support:

- create regular PR
- create draft PR with `draft: true`
- add configurable AI label
- add AI warning comment to the new draft PR
- add developer handoff comment to the source PR

- [ ] **Step 4: Run tests**

```bash
yarn test test/reporting.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/reporting.ts src/github.ts test/reporting.test.ts
git commit -m "feat: report AI backports and handoffs"
```

### Task 10: Refactor the Backport Orchestrator

**Files:**

- Modify: `src/backport.ts`
- Modify: `src/index.ts`
- Create: `src/domain.ts`
- Create: `test/backport.integration.test.ts`

- [ ] **Step 1: Write failing end-to-end orchestration tests**

Use temporary git repositories and fake GitHub/provider gateways:

1. Clean cherry-pick creates a normal non-draft PR and makes no model call.
2. Exact sibling reuse creates a normal backport PR and makes no model call.
3. Eligible enum conflict creates an AI-labeled draft PR after resolution and
   review.
4. Eligible tenant-setting conflict behaves the same.
5. Migration conflict posts a handoff and makes no model call.
6. Reviewer rejection posts a handoff and leaves no pushed branch.
7. Validation failure posts a handoff and leaves no pushed branch.
8. One destination succeeds while another fails; both are reported and the
   overall action fails.
9. AI disabled preserves legacy normal behavior but reports failure accurately.

- [ ] **Step 2: Split orchestration from boundaries**

Define:

```ts
export type DestinationResult =
  | {
      status: "created";
      base: string;
      pullRequestNumber: number;
      mode: "normal" | "sibling" | "ai";
    }
  | { status: "failed"; base: string; reason: string };
```

`backport()` returns all destination results. `src/index.ts` sets the existing
created-PR output and calls `setFailed` after processing when any result failed.

- [ ] **Step 3: Implement destination flow**

For each base branch:

```text
switch base -> create branch -> normal cherry-pick
  success: push and regular PR
  conflict:
    collect context
    policy preflight
    exact sibling reuse
    otherwise one AI resolver attempt
    accepted: continue cherry-pick, push, draft AI PR
    failed: abort, delete local branch, post handoff
```

Configure git identity locally inside the clone:

```bash
git config user.email github-actions[bot]@users.noreply.github.com
git config user.name github-actions[bot]
```

Do not modify global git configuration.

- [ ] **Step 4: Run integration tests**

```bash
yarn test test/backport.integration.test.ts
```

- [ ] **Step 5: Run the complete suite**

```bash
yarn test
yarn run build
yarn run prettier --check
yarn run xo
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add src test/backport.integration.test.ts
git commit -m "feat: orchestrate AI-assisted backports"
```

## Chunk 4: Historical Fixtures, Documentation, and Release Bundle

### Task 11: Add Historical Regression Fixtures

**Files:**

- Create fixture data under: `test/fixtures/enum-conflict/`
- Create fixture data under: `test/fixtures/tenant-setting-conflict/`
- Create fixture data under: `test/fixtures/migration-conflict/`
- Create fixture data under: `test/fixtures/test-omission/`
- Modify: `test/backport.integration.test.ts`

- [ ] **Step 1: Reduce historical cases to minimal fixtures**

Create synthetic files that preserve only the conflict structure learned from:

- a one-line enum insertion
- tenant setting key registration at a moved location
- an unchanged migration plus a setting conflict
- a backport that would omit a source test file

Do not copy unrelated proprietary code.

- [ ] **Step 2: Add failing regression tests**

Assert the first two can be accepted, migration content remains byte-identical,
and test omission is rejected.

- [ ] **Step 3: Make only fixture-driven fixes**

Adjust policy/context code only where a fixture exposes a specific incorrect
decision. Do not broaden the AI eligibility surface.

- [ ] **Step 4: Run fixture tests**

```bash
yarn test test/backport.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add test/fixtures test/backport.integration.test.ts src
git commit -m "test: cover historical backport conflicts"
```

### Task 12: Document Usage and Build the Action Bundle

**Files:**

- Modify: `README.md`
- Modify: `dist/index.js`
- Modify: `dist/package.json`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Update README**

Document:

- normal behavior remains the default
- the three providers and configuration examples
- FundmoreAI-oriented Haiku example
- strict OpenAI-compatible requirements
- immutable migration behavior
- draft `AI backport` PR behavior
- human escalation behavior
- required GitHub token permissions
- required repository validation commands
- recommendation to pin a release SHA

- [ ] **Step 2: Rebuild**

```bash
yarn run build
```

- [ ] **Step 3: Verify the complete repository**

```bash
yarn install --frozen-lockfile
yarn test
yarn run build
yarn run prettier --check
yarn run xo
git diff --check
git status --short
```

Expected:

- all commands pass
- only intentional source, test, documentation, workflow, lockfile, and bundle
  changes remain
- no secret-shaped values appear in the diff

- [ ] **Step 4: Review the bundled action**

Confirm:

- `action.yml` uses Node 24
- `dist/index.js` contains all runtime dependencies
- no runtime dependency is omitted
- no test fixture or secret is bundled
- `dist` is reproducible from `yarn run build`

- [ ] **Step 5: Commit**

```bash
git add README.md action.yml package.json yarn.lock .github/workflows src test dist
git commit -m "docs: document AI-assisted backports"
```

## Final Review

- [ ] Run the complete verification commands from Task 12.
- [ ] Review every changed file for API-key or token leakage.
- [ ] Confirm there is no stronger-model fallback or retry loop.
- [ ] Confirm migrations cannot be supplied in model output or changed by AI.
- [ ] Confirm AI success always creates a draft PR with the AI label and comment.
- [ ] Confirm any failed destination makes the workflow fail after all
      destinations are processed.
- [ ] Confirm clean backports never call a model.
- [ ] Confirm all three provider adapters pass the same contract tests.
- [ ] Confirm `dist/index.js` is committed and reproducible.
