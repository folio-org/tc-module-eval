# Agent Review Configuration

Some criteria can add optional OpenCode advisory review to manual results. Agent output is reviewer background only; it does not directly pass or fail a criterion.

Supported advisory criteria: `S004` installation documentation, `S005` personal data disclosure consistency, `S006` sensitive/environment-specific information review, `S007` officially supported technologies review, and `S010` third-party system resilience review.

Agent review runs through reusable criterion-agent infrastructure:

- All five supported criteria browse an isolated snapshot of eligible committed repository source. Evaluated modules are public open-source repositories, so repository content is not redacted; agent output and error text are still redacted before they reach reports. Enabling review exposes eligible source to the configured model provider, not just scanner-selected excerpts.
- OpenCode runs with generated temporary `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` paths.
- Provider keys are read from environment variables, not CLI arguments.
- The generated OpenCode agent is read-only and rejects mutating tools.
- Evaluated-repository `.opencode/`, `opencode.json`, and `.env` files are ignored.

## S005 Personal Data Disclosure Review

S005 checks the required top-level `PERSONAL_DATA_DISCLOSURE.md` for file mechanics, checklist answers, placeholders or contradictions, and bounded read-only source signals. It does not certify privacy or legal compliance; completed forms stay `manual`, deterministic `fail` covers only mechanics or completion defects, and explicit FOLIO libraries are `not_applicable`.

Evidence gathering never mutates the repository or runs repository code, tests, builds, services, databases, or Okapi calls. When enabled, S005 agent review runs for manual cases even when the scanner found no evidence beyond the form. It compares the disclosure with schemas, APIs, storage, logging, and data flows in committed source. The parsed summary guides investigation but does not select the available files.

If agent review is disabled, unavailable, malformed, or has no material, S005 still reports deterministic evidence; status remains deterministic/manual, not agent-driven.

## S007 Officially Supported Technologies Review

S007 invokes agent review for manual results, including incomplete evidence and policy
uncertainty. It follows committed manifests, parent configuration, version properties,
lockfiles, containers, and CI. Raw source replaces the old selected declaration
summaries. The full trusted policy is supplied separately so the agent can investigate
technologies missed by the analyzer using `discovered:<normalized-id>` assessments.
Missing policy or external parent contents remain unresolved; repository browsing
does not authorize the agent to invent policy or retrieve external dependencies.

Agent output may clarify an unresolved declaration, conflict, or unlisted framework,
but it cannot change the deterministic status. Disabled, excluded, unavailable,
failed, or malformed review leaves S007 manual and records the unavailable reason.

## Repository browsing shared by all five criteria

Enabled reviews run only for deterministic manual results. An empty analyzer inventory
does not prevent investigation; an empty or inaccessible committed snapshot makes
review unavailable. OpenCode browses the eligible committed source tree with read,
glob, grep, and list. There is no ranked 32-file
selection: files outside conventional source directories are available too.
Files are copied intact, with repository-relative paths preserved under `docs/`
in an isolated workspace. The agent chooses what to search and read, follows
cross-file references, and seeks evidence that contradicts or extends the
deterministic summary. Repository contents are not all injected into the prompt.

Generated output, vendored dependencies, binaries, non-regular entries (including
symlinks and submodules), `.env` files, and uncommitted changes are excluded.
Repository-authored `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `opencode.json`/`opencode.jsonc`,
`.opencode/`, `.claude/`, `.agents/`, and `.criterion-agent/` are excluded as well.
OpenCode can automatically load `CONTEXT.md` while reading nearby source; these
instruction filenames are excluded at every depth. `.ignore`, `.rgignore`, and
`.gitignore` are also excluded so repository rules cannot silently hide copied
source from searches. Recheck automatic instruction and search configuration
filenames when upgrading OpenCode.
Commands, builds, tests, mutations, external-directory access, and web tools remain
disabled. This enables source investigation, not runtime verification.

Workspace preparation has safety ceilings of 50,000 tree entries/files, 16 MiB
of tree metadata, 1 MiB per file, and 128 MiB of source. Git errors or exceeded
ceilings make agent review unavailable instead of silently selecting a subset or
truncating source. Before reporting a byte-limit failure, the reader probes at most
8 KiB for NUL bytes and stops the Git blob stream early. Recognized binary content
is recorded as an omission; oversized content not identified as binary within that
prefix still fails closed. The coverage summary records the committed revision and
non-text/unsafe-entry omissions. The existing `--criterion-agent-timeout-ms`
bounds the OpenCode run; there is no separate token or tool-call budget. A hard
timeout makes review unavailable. The agent is instructed to report unfinished
material traces as `needs_reviewer_judgment` when it can finish a response.

The snapshot revision applies to browsable source. S004–S007 deterministic summaries
can reflect the working tree, so use a clean checkout to avoid mixing revisions.

S004 follows documentation links and checks instructions against build and runtime
configuration. Source configuration can expose contradictions but cannot substitute
for missing developer-facing documentation. Deterministic pass, fail, and
not-applicable results remain outside agent review for every criterion.

## S010 Third-Party System Resilience Review

The review inventories runtime dependencies and traces configuration, operations,
failure bounds, fallback behavior, startup coupling, and readiness effects. It may
identify evidence missed by narrow deterministic recognizers, but it cannot change
the deterministic status. Every assessment and reviewer action must cite committed
repository source; generated summaries alone are not valid support. Citation paths
are validated against the workspace; the agent is also instructed to include line
numbers in assessment text and describe its actual investigation scope, but those
claims are not independently verified. Disabled,
excluded, unavailable, malformed, or uncited review leaves S010 manual.

## S006 Sensitive Information Review

S006 scans bounded high-signal text, configuration, documentation, CI, Docker, and env surfaces for committed sensitive or environment-specific information. It detects secret assignments, provider API keys and tokens, credential URLs, private key blocks, private URLs, tenant or host endpoints, and local absolute paths. Reports show the matched value as a bounded excerpt so reviewers can judge it directly; value fingerprints are not reported.

Deterministic `fail` is reserved for high-confidence production, CI, or deployment evidence such as live-looking secrets, credential URLs, or production-like private keys. Documentation, samples, tests, fixtures, synthetic or default-ish values, local Docker defaults, tenant/host/private URL evidence, and materially weakened scan coverage remain `manual` for reviewer judgment.

When enabled, S006 agent review investigates manual results using the finding summary and surrounding committed source, including files not flagged by the scanner. Fingerprints are omitted from the summary. It distinguishes production usage from examples, fixtures, and local defaults without testing credentials or contacting endpoints, and must not reproduce secret values in its response. Excluded files, including `.env` files, remain outside browsing scope even if the deterministic scanner inspected them; the agent cannot certify those files or a secret-free repository. Agent review cannot pass or fail S006. Unavailable review preserves deterministic evidence and records its reason.

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
- `--criterion-agent-debug-retain-workspace` retains the temporary review workspace and a content-free `agent-debug.json` run trace for local debugging.

When this flag is used, the evaluator keeps the manifest and review inputs but still deletes the entire separate OpenCode runtime directory, including configuration, auth data, and session storage. The JSON report's `agentReview.metadata.retainedWorkspacePath` identifies the workspace. Treat retained inputs as private repository content; do not publish the whole workspace.

`agent-debug.json` records each command's start/end time, duration, status, exit code/signal, output byte counts, and truncation flags, including failed and timed-out commands. For the review command it also retains up to 2,000 content-free events: event type, OpenCode-reported timestamp, allowlisted tool name/status, and tool duration when supplied. Unknown names are replaced with `other`. Prompts, environment variables, credentials, paths, tool inputs/outputs, assistant prose, and reasoning text are not included in the trace. The trace file is owner-readable/writable only.

The trace is updated before and after each command, not continuously. Event timestamps are reported by OpenCode, not measured provider latency. Missing events, capture truncation, and `omittedEvents` limit what can be concluded; a quiet interval cannot distinguish model computation from provider waiting. A forcibly killed evaluator may leave only the last command's `running` entry. Debug mode does not increase timeouts, change permissions, or retry commands.

For example, to investigate S010 with a seven-minute ceiling:

```bash
node dist/cli.js evaluate https://github.com/folio-org/mod-search \
  --criteria S010 --criterion-agent-opencode --criterion-agent-criteria S010 \
  --criterion-agent-model openrouter/deepseek/deepseek-v4-flash \
  --criterion-agent-timeout-ms 420000 --criterion-agent-debug-retain-workspace
```

Remove the retained workspace when troubleshooting is finished. Without the flag, no trace file is written and the temporary review workspace is deleted as before.

Explicit CLI model and auth-store values take precedence over environment-based generation.

Only include environment variable names that the OpenCode subprocess actually needs. Values named in `--criterion-agent-provider-env` or `--criterion-agent-proxy-env` are forwarded into the agent process.

## Output Acceptance and Troubleshooting

Available advice must cite actual repository files in `repository-files.json`. The top-level review and every returned assessment and action must each include a repository citation; generated summaries, policy context, and snapshot manifests alone are insufficient. Unknown citations are discarded, and a response without required citations is unavailable. Citation validation establishes path availability, not the correctness of a claim or proof that the agent read the file. Deterministic status and findings remain unchanged.

Agent-review failures are reported without exposing raw provider output or credentials:

- **Timeout:** choose a faster model or explicitly increase `--criterion-agent-timeout-ms` within the supported range of 1–2147483647 ms.
- **Provider error:** inspect provider credentials, quota, account status, and endpoint configuration. Do not print credentials while troubleshooting.
- **Capture overflow:** the review is unavailable; the evaluator does not infer advice from a captured prefix.
- **Malformed, invalid, or incomplete response:** inspect the evaluator's sanitized diagnosis and, if useful, rerun the OpenCode command manually in a trusted environment.

These categories diagnose the observed command or response; they do not make claims about provider reliability. In every failure category, evaluation continues with the deterministic result and evidence.

Malformed-response reports distinguish invalid transport records, sanitization rejection, and invalid final assistant JSON. Capture diagnostics retain at most 16 content-free entries with record numbers, allowlisted rejection categories, and assistant JSON parseability before and after sanitization. They do not retain raw rejected text, arbitrary field names, or tool previews. Native tool/reasoning payloads are omitted from captured output while their lifecycle boundaries remain; incomplete file previews cannot invalidate later advice. Advisory JSON is parsed before its decoded values are redacted.

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
