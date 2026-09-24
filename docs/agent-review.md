# Agent Review Configuration

Some criteria can add optional OpenCode advisory review to manual results. Agent output is reviewer background only; it does not directly pass or fail a criterion.

Supported advisory criteria: `S004` installation documentation, `S005` personal data disclosure consistency, `S006` sensitive/environment-specific information review, and `S007` officially supported technologies review.

Agent review runs through reusable criterion-agent infrastructure:

- The evaluated repository is copied into a bounded, sanitized review workspace.
- OpenCode runs with generated temporary `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` paths.
- Provider keys are read from environment variables, not CLI arguments.
- The generated OpenCode agent is read-only and rejects mutating tools.
- Evaluated-repository `.opencode/`, `opencode.json`, and `.env` files are ignored.

## S005 Personal Data Disclosure Review

S005 checks the required top-level `PERSONAL_DATA_DISCLOSURE.md` for file mechanics, checklist answers, placeholders or contradictions, and bounded read-only source signals. It does not certify privacy or legal compliance; completed forms stay `manual`, deterministic `fail` covers only mechanics or completion defects, and explicit FOLIO libraries are `not_applicable`.

Evidence gathering never mutates the repository or runs repository code, tests, builds, services, databases, or Okapi calls. When enabled, S005 agent review runs only for completed manual cases with candidate evidence or possible mismatches beyond the form. It receives the disclosure form, redacted parsed summary, and bounded redacted excerpts, then returns advisory recommendation, confidence, rationale, and manifest-scoped evidence references. S005 excerpts are redacted review hints, not PII-safe extracts.

If agent review is disabled, unavailable, malformed, or has no material, S005 still reports deterministic evidence; status remains deterministic/manual, not agent-driven.

## S007 Officially Supported Technologies Review

S007 invokes agent review only when deterministic analysis is manual because of an
unresolved declaration, conflict, unlisted framework, or incomplete coverage and a
manifest contains useful repository evidence. Policy-load and policy-semantics-only
manual results do not invoke it.

The review workspace contains a bounded deterministic summary and selected, redacted
declaration summaries rather than raw manifest contents. Absolute paths, traversal
paths, symlinks, and duplicate files are excluded; each generated declaration summary
has its own byte limit. Repository content is untrusted evidence: the agent is
instructed not to follow repository-authored instructions, run commands, execute
builds or tests, install dependencies, modify files, make network calls, or invent
policy. Available advice must cite at least one validated path from the review manifest.

Agent output may clarify an unresolved declaration, conflict, or unlisted framework,
but it cannot change the deterministic status. Disabled, excluded, unavailable,
failed, or malformed review leaves S007 manual and records the unavailable reason.

## S006 Sensitive Information Review

S006 scans bounded high-signal text, configuration, documentation, CI, Docker, and env surfaces for committed sensitive or environment-specific information. It detects secret assignments, provider API keys and tokens, credential URLs, private key blocks, private URLs, tenant or host endpoints, and local absolute paths. Reports use detector-local redaction and must not include raw sensitive values or value fingerprints.

Deterministic `fail` is reserved for high-confidence production, CI, or deployment evidence such as live-looking secrets, credential URLs, or production-like private keys. Documentation, samples, tests, fixtures, synthetic or default-ish values, local Docker defaults, tenant/host/private URL evidence, and materially weakened scan coverage remain `manual` for reviewer judgment.

When enabled, S006 agent review runs only for manual findings or material scan-coverage uncertainty. It receives redacted summaries and bounded redacted excerpts only, never raw detector values or fingerprints. Agent review is advisory only and cannot pass or fail S006. If agent review is disabled, unavailable, malformed, or has no material, deterministic evidence remains and S006 records the unavailable reason when applicable.

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
  --criterion-agent-timeout-ms 420000
```

The default timeout is 120,000 ms. The timeout applies independently to each OpenCode command: debug configuration verification, debug agent verification, and the review run. Criteria execute sequentially, so one criterion review—and the complete evaluation—may take longer than the configured timeout. A longer timeout is only a ceiling; it does not guarantee a successful provider response. The evaluator does not retry agent commands, although OpenCode or the selected provider may have its own internal retry behavior.

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

## Output Acceptance and Troubleshooting

Available advice must cite at least one entry from the review manifest. Generated evidence files in the manifest are valid citations; S005 and S006 do not require a direct repository-file citation. Unknown citations are discarded, and a response with no valid manifest citation is unavailable. This validation affects only optional advice: deterministic status and findings remain unchanged.

Agent-review failures are reported without exposing raw provider output or credentials:

- **Timeout:** choose a faster model or explicitly increase `--criterion-agent-timeout-ms` within the supported range of 1–2147483647 ms.
- **Provider error:** inspect provider credentials, quota, account status, and endpoint configuration. Do not print credentials while troubleshooting.
- **Capture overflow:** the review is unavailable; the evaluator does not infer advice from a captured prefix.
- **Malformed, invalid, or incomplete response:** inspect the evaluator's sanitized diagnosis and, if useful, rerun the OpenCode command manually in a trusted environment.

These categories diagnose the observed command or response; they do not make claims about provider reliability. In every failure category, evaluation continues with the deterministic result and evidence.

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
