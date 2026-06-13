# Backport

Backport is a JavaScript GitHub Action that creates backport pull requests from
merged pull requests and `backport <branch>` labels.

It supports single-commit rebased merges and squash merges. A normal
`git cherry-pick -x` is always attempted first.

When enabled, the action can make one constrained AI attempt to resolve a small
conflict. It supports:

- Anthropic
- OpenAI
- OpenAI-compatible endpoints with strict structured-output support

The provider and model are configuration. Git, GitHub, policy, prompts, and
validation behavior do not depend on a provider SDK.

## Behavior

For every destination branch:

1. Run a normal cherry-pick.
2. If it succeeds, create a regular backport pull request.
3. If it conflicts, collect commit parents, merge base, index stages, file
   history, blame, and prior sibling backports.
4. Reuse an exact sibling resolution when source identity and destination file
   blobs match.
5. Otherwise, make one small-model resolution request.
6. Apply output only to conflicted, allowlisted files.
7. Run deterministic policy checks and configured validation commands.
8. Make one independent read-only model review.
9. If accepted, create a draft pull request with the `AI backport` label and a
   detailed warning comment.
10. Otherwise, abort and post a developer handoff comment on the source pull
    request.

There is no stronger-model fallback and no automatic retry. Anything beyond the
small-model boundary goes directly to a developer.

## Workflow

Use `pull_request_target` only for merged pull requests. Pin the action to a
release tag or commit SHA.

```yaml
name: Backport

on:
  pull_request_target:
    types: [closed, labeled]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  backport:
    if: >
      github.event.pull_request.merged
      && (
        github.event.action == 'closed'
        || (
          github.event.action == 'labeled'
          && startsWith(github.event.label.name, 'backport ')
        )
      )
    runs-on: ubuntu-latest
    steps:
      - uses: sakibsadmanshajib/backport@<commit-sha>
        with:
          github_token: ${{ secrets.BACKPORT_PAT }}
          ai_enabled: "true"
          ai_provider: anthropic
          ai_model: claude-haiku-4-5-20251001
          ai_api_key: ${{ secrets.AI_API_KEY }}
          ai_validation_commands: >-
            ["cd src && yarn build:shared"]
          ai_forbidden_patterns: >-
            ["**/tenancy/**","**/authorization/**"]
```

The token must be able to push branches, create pull requests, apply labels, and
post comments. A personal access token may be needed when workflows must run on
the generated pull request.

Add `backport production` to a merged pull request to target the `production`
branch. Multiple backport labels are supported.

## Provider Configuration

### Anthropic

```yaml
ai_provider: anthropic
ai_model: claude-haiku-4-5-20251001
ai_api_key: ${{ secrets.AI_API_KEY }}
```

### OpenAI

```yaml
ai_provider: openai
ai_model: <small-structured-output-model>
ai_api_key: ${{ secrets.AI_API_KEY }}
```

### OpenAI-Compatible

```yaml
ai_provider: openai-compatible
ai_model: <model-name>
ai_api_key: ${{ secrets.AI_API_KEY }}
ai_base_url: https://models.example.com/v1
```

The compatible endpoint must implement strict JSON Schema response formatting
through OpenAI-style Chat Completions. The action does not fall back to
plain-text JSON extraction.

## Migration Safety

AI never modifies migrations.

Examples:

- A source commit contains a migration that cherry-picks cleanly and a
  tenant-setting enum that conflicts. The migration remains byte-for-byte from
  the normal cherry-pick, while AI may resolve only the enum file.
- A migration file itself conflicts. The action makes no model request and posts
  a developer handoff.
- A model returns a migration path despite the allowlist. Runtime schema and
  policy validation reject the result.

Additional immutable patterns are configurable, but built-in migration,
dependency, lockfile, and test-removal protections cannot be disabled.

## Validation

`ai_validation_commands` is required when AI is enabled. Commands run in order
through non-interactive Bash with `pipefail`.

```yaml
ai_validation_commands: >-
  ["cd src && yarn build:shared","cd src && yarn workspace <workspace> test"]
```

The candidate is rejected when:

- a command exits non-zero
- a command modifies or restages a tracked file
- `git diff --check` fails
- a source path is omitted
- conflict markers remain
- the resolution exceeds configured limits

`INPUT_AI_API_KEY` and `INPUT_GITHUB_TOKEN` are removed from validation command
environments.

## Inputs

| Input                     | Default                       | Description                                   |
| ------------------------- | ----------------------------- | --------------------------------------------- |
| `github_token`            | Required                      | GitHub API and push token                     |
| `label_pattern`           | `^backport (?<base>([^ ]+))$` | Pattern with a required `base` group          |
| `ai_enabled`              | `false`                       | Enable conflict fallback                      |
| `ai_provider`             | `anthropic`                   | `anthropic`, `openai`, or `openai-compatible` |
| `ai_model`                | None                          | Provider model identifier                     |
| `ai_api_key`              | None                          | Provider API key                              |
| `ai_base_url`             | None                          | Required for OpenAI-compatible endpoints      |
| `ai_label`                | `AI backport`                 | Label for AI-created drafts                   |
| `ai_max_conflicted_files` | `3`                           | Maximum eligible conflict files               |
| `ai_max_resolution_lines` | `60`                          | Maximum adapted lines                         |
| `ai_timeout_seconds`      | `120`                         | Timeout for each model call                   |
| `ai_validation_commands`  | `[]`                          | Required non-empty JSON command array         |
| `ai_immutable_patterns`   | Migration patterns            | Additional files AI cannot modify             |
| `ai_forbidden_patterns`   | `[]`                          | Additional repository safety patterns         |

The existing body, title, head, and label templates remain supported through
`body_template`, `title_template`, `head_template`, and `labels_template`.

## Security

- The model receives no shell, filesystem, git, or GitHub tools.
- Provider credentials are never included in prompts or comments.
- Repository and pull request content are marked as untrusted data.
- Only allowlisted conflicted files can be written.
- AI pull requests are always drafts and are never auto-merged.
- Any failed destination branch makes the workflow fail after all requested
  destinations have been processed.
