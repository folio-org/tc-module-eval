# Agent Review Configuration

Some criteria can add optional OpenCode advisory review to manual results. Agent output is reviewer background only; it does not directly pass or fail a criterion.

Supported advisory criteria:

- `S004`: installation documentation review.
- `S005`: personal data disclosure consistency review.

Agent review runs through reusable criterion-agent infrastructure:

- The evaluated repository is copied into a bounded, sanitized review workspace.
- OpenCode runs with generated temporary `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` paths.
- Provider keys are read from environment variables, not CLI arguments.
- The generated OpenCode agent is read-only and rejects mutating tools.
- Evaluated-repository `.opencode/`, `opencode.json`, and `.env` files are ignored.

## S005 Personal Data Disclosure Review

S005 evaluates the top-level `PERSONAL_DATA_DISCLOSURE.md` required by the acceptance criterion. The deterministic evaluator checks artifact mechanics, parses disclosure checklist answers, reports obvious placeholders or contradictions, and gathers bounded source-inspection signals for likely personal-data handling.

S005 does not certify legal, GDPR, CCPA, institutional privacy, or general privacy compliance. Completed disclosure forms remain `manual` so Technical Council reviewers own the interpretation of disclosure accuracy. Deterministic `fail` results are reserved for mechanics or completion problems such as a missing exact file, unreadable or unparseable form, misnamed-only artifact, or blank copied template. Explicit FOLIO libraries are `not_applicable`.

S005 evidence gathering is read-only source inspection. It does not mutate the evaluated repository and does not run repository code, tests, builds, services, databases, or Okapi calls.

When agent review is enabled for `S005`, it runs only for completed manual cases that have candidate deterministic evidence or possible mismatches beyond the form itself. The agent receives the disclosure form, a redacted parsed summary, and bounded redacted evidence excerpts. Its advisory JSON includes:

- `recommendation`: `likely_sufficient`, `likely_insufficient`, or `needs_reviewer_judgment`.
- `confidence`: `low`, `medium`, or `high`.
- `summary`, `rationale`, and manifest-scoped `evidenceReferences`.

S005 excerpts are bounded and redacted before report or agent use, but they are source-review hints rather than a PII-safe export format. Redaction targets known sensitive patterns and personal-field values; reviewers should not treat excerpts as sanitized data extracts.

If agent review is disabled, unconfigured, excluded for `S005`, unavailable, malformed, failed, or has no candidate material, the evaluator still reports deterministic S005 evidence and records a not-applied or unavailable reason. The S005 status remains driven by deterministic mechanics and reviewer-owned manual interpretation, not agent advice.

## OpenRouter

```bash
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=openrouter/free

folio-eval evaluate <repo-url> \
  --criteria <criterion-id> \
  --criterion-agent-opencode \
  --criterion-agent-criteria <criterion-id>
```

`OPENROUTER_MODEL=openrouter/free` is normalized to the OpenCode selector `openrouter/openrouter/free`.

## OpenAI

```bash
export OPENAI_API_KEY=...
export OPENAI_MODEL=gpt-4.1-mini

folio-eval evaluate <repo-url> \
  --criteria <criterion-id> \
  --criterion-agent-opencode \
  --criterion-agent-criteria <criterion-id>
```

`OPENAI_MODEL=gpt-4.1-mini` is normalized to the OpenCode selector `openai/gpt-4.1-mini`.

## CLI Options

Use `--criterion-agent-opencode` to enable OpenCode review. Use `--criterion-agent-criteria` to choose which criteria may invoke it.

```bash
folio-eval evaluate <repo-url> \
  --criterion-agent-opencode \
  --criterion-agent-criteria <criterion-id>[,<criterion-id>] \
  --criterion-agent-timeout-ms 90000
```

Advanced options:

- `--criterion-agent-model <label>` overrides the model selector inferred from provider environment variables.
- `--criterion-agent-read-only-agent <name>` selects the OpenCode read-only agent name.
- `--criterion-agent-auth-store <path>` uses a trusted OpenCode auth store outside the evaluated repository.
- `--criterion-agent-provider-env <names>` allowlists additional provider credential environment variable names.
- `--criterion-agent-proxy-env <names>` allowlists proxy environment variable names.
- `--criterion-agent-endpoint <url>` configures a provider endpoint.
- `--criterion-agent-endpoint-allowlist <urls>` permits non-HTTPS explicitly trusted endpoint URLs on the same parsed origin.
- `--criterion-agent-debug-retain-workspace` retains the temporary review workspace for local debugging.

When `--criterion-agent-debug-retain-workspace` is used, the evaluator keeps the sanitized manifest and generated OpenCode config but removes copied/generated OpenCode auth data after the run.

Explicit CLI model and auth-store values take precedence over environment-based generation.

Only include environment variable names that the OpenCode subprocess actually needs. Values named in `--criterion-agent-provider-env` or `--criterion-agent-proxy-env` are forwarded into the agent process.

## GitHub Actions

GitHub Actions can pass provider credentials as job or step environment variables from secrets:

```yaml
- name: Evaluate with agent review
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    OPENROUTER_MODEL: openrouter/free
  run: |
    folio-eval evaluate . \
      --criterion-agent-opencode \
      --criterion-agent-criteria <criterion-id>
```

Hosted agent review should be enabled only for trusted repositories and trusted workflow contexts. Pull requests from forks usually do not receive repository secrets. Use protected environments, least-privilege workflow permissions, and repository allowlists before enabling networked agent review in reusable workflows.

If provider secrets are unavailable or OpenCode cannot be verified as read-only, the evaluator records agent review as unavailable and keeps the criterion in manual review when appropriate.
