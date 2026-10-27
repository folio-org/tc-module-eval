# Agent Review Configuration

Some criteria can add optional OpenCode advisory review to manual results. Agent output is reviewer background only; it does not directly pass or fail a criterion.

Supported advisory criteria: `S004` installation documentation, `S005` personal data disclosure consistency, `S006` sensitive/environment-specific information review, `S007` officially supported technologies review, `S010` third-party system resilience review, `S011` SonarQube suppression review, and `F003` internationalization review.

Agent review runs through reusable criterion-agent infrastructure:

- Repository browsing is the shared default for every criterion that calls `runCriterionAgentReview()`, including all seven currently supported criteria. The runner prepares an isolated snapshot of eligible committed repository source only after review enablement and configuration checks pass. Evaluated modules are public open-source repositories, so neither repository content nor agent output is redacted; only the evaluator's own credentials are masked (see [Output masking](#output-masking)). Enabling review exposes eligible source to the configured model provider, not just scanner-selected excerpts.
- Criterion-supplied files are starting context and do not limit the browsable source inventory. A criterion may explicitly set `evidenceMode: 'supplied-files'` when it must restrict review to those files; repository browsing remains the default when the option is omitted.
- If starting context names a path also present in the committed snapshot, the committed content is authoritative while the path remains listed as starting material.
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

If an otherwise cited assessment uses a bare canonical ID from the trusted S007
policy that is absent from the deterministic inventory, the evaluator adds the
`discovered:` prefix and records a warning. It does not guess aliases, repair
arbitrary unknown names, or change the assessment's policy conclusion.

Agent output may clarify an unresolved declaration, conflict, or unlisted framework,
but it cannot change the deterministic status. Disabled, excluded, unavailable,
failed, or malformed review leaves S007 manual and records the unavailable reason.

## Repository browsing shared by criterion reviews

Enabled reviews run only for deterministic manual results. An empty analyzer inventory
does not prevent investigation; an empty or inaccessible committed snapshot makes
review unavailable. OpenCode browses the eligible committed source tree with read,
glob, grep, and list. There is no ranked 32-file
selection: files outside conventional source directories are available too.
Files are copied intact, with repository-relative paths preserved under `docs/`
in an isolated workspace. The agent chooses what to search and read, follows
cross-file references, and seeks evidence that contradicts or extends the
deterministic summary. Repository contents are not all injected into the prompt.
The fake adapter follows the same snapshot, workspace-safety, citation, and
criterion-semantic validation path; it replaces inference only.

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
of tree metadata, 1 MiB per file, and 128 MiB of source. Oversized source files are
omitted and their paths listed in the snapshot manifest; their contents remain
unverified. Git errors and exceeded tree, count, or aggregate ceilings still make
agent review unavailable. The reader probes at most 8 KiB for NUL bytes and stops
oversized Git blob streams early. The coverage summary records the committed
revision and binary, oversized, and unsafe-entry omissions. S006 and S007 generated
summaries remain complete JSON rather than being byte-truncated; the 1 MiB workspace
file limit still applies. The existing `--criterion-agent-timeout-ms`
bounds the OpenCode run; there is no separate token or tool-call budget. A hard
timeout makes review unavailable. The agent is instructed to report unfinished
material traces as `needs_reviewer_judgment` when it can finish a response.

The snapshot revision applies to browsable source. S004–S007 deterministic summaries
can reflect the working tree, so use a clean checkout to avoid mixing revisions.

S004 follows documentation links and checks instructions against build and runtime
configuration. Headings are evaluated with a small following instruction block so
commands immediately below an installation or deployment heading remain connected
to that section. Table-of-contents and troubleshooting-only mentions are discarded,
and tool or runtime requirements are not treated as commands unless they contain a
recognized executable action. Shell comments inside fenced code blocks are not
treated as Markdown headings, and environment instructions require variable or
assignment syntax rather than an uppercase product name. Source configuration can
expose contradictions but cannot substitute for missing developer-facing
documentation. Deterministic pass, fail, and not-applicable results remain outside
agent review for every criterion.

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

Each dependency assessment includes cited `failureBounds` for process startup,
tenant initialization, and runtime. Records distinguish required, optional, and
conditional dependencies and mark bounds established, unverified, or not applicable.
An established bound needs an explanation connecting the mechanism to the complete
operation, including retries; an exception or assumed library default is insufficient.
Supported facts may accompany unverified bounds, but cannot justify a likely-sufficient
recommendation. Unresolved bounds require reviewer judgment and a cited follow-up,
unless a substantive concern already supports likely-insufficient. Required services
need not work offline: clear bounded failure is
acceptable. Optional deployment tuning does not invalidate an established bound.

Deterministic dependency IDs are candidates: every candidate must be accounted for,
but a cited internal component may use `analyzer_limitation` with
`coverageDisposition: immaterial` without a phase matrix. Its relevant configuration
still belongs in the actual service assessment. Investigation starts with startup
I/O, then tenant/provisioning helpers, runtime callers, and effective client bounds.
The agent summary labels exception propagation with unknown duration neutrally;
this projection does not change deterministic analysis.

## S011 SonarQube Suppression Review

S011 review runs for a deterministic `manual` result when the repository or its CI suppresses a Sonar rule or narrows the analysis scope. The evaluator groups suppressions by rule and file, with stable IDs such as `suppression:java:S2077:src/main/java/org/folio/search/service/reindex/jdbc/SubjectRepository.java`, `nosonar:<path>` and `all:<path>`, and scope settings by file (`scope:pom.xml`). Each group comes with its lines, rule name, the FOLIO guidance it departs from, and adjacent comments, in `.criterion-agent/S011/review-groups.json`.

The agent reads the suppressed code and returns exactly one assessment per group, with the group ID as `technologyId`: `aligned_fact` when the suppression looks justified, `substantive_concern` when it does not, `evidence_gap` when the code does not settle it. Each must cite the group's own file; a group whose file is not in the review snapshot must stay `evidence_gap`. `likely_sufficient` needs every group `aligned_fact`, `likely_insufficient` a `substantive_concern`, and `needs_reviewer_judgment` a cited reviewer action. A review that misses a group, adds an unknown one, or breaks these rules is rejected and S011 stays `manual` without advice. Issues accepted or hotspots reviewed in SonarCloud, and SonarCloud project settings, are listed for the human only; they are not repository files.

## F00x Frontend Criteria Review

F criteria share one contract (`src/utils/frontend-agent-review.ts`); F003 is the first to use it, and F001, F002, F004, F006 and F007 will follow. Enabling agent review without `--criterion-agent-criteria` runs it for F003 whenever F003 is manual (Q6).

- **Obligations.** Each checklist item that is not reviewer-only gives one obligation per subject (a message id, a text, a path and line), or one for the whole item. IDs are short and per run: `F003-C1#1`, `F003-C1#2`, … At most 25 are given to the agent, subject obligations first in item order, then whole-item ones; the rest are shown as "Not given to the agent (limit of 25)".
- **Starting material** under `.criterion-agent/<ID>/`: `checklist.json` (items, their first 20 starting points and the obligations given), `evidence-summary.json` (the deterministic findings, lists cut until it fits in 48 KB) and `response-shape.json` (a complete example).
- **Browse scope.** A request may narrow the committed snapshot with `browseInclude`. F criteria browse production source (`src/`, `lib/`, root-level files, without tests, stories, examples, fixtures and mocks), CSS under `src/` and `lib/`, and `package.json`; F003 adds its own `translations/<namespace>/en.json`, or every candidate `en.json` when the namespace is unclear. Tests, guides, other locales and CHANGELOG are left out. The scope is stated in the prompt and in the report ("Agent review scope" under what the tool found).
- **Timeout.** F criteria use 420,000 ms per OpenCode command unless `--criterion-agent-timeout-ms` is given.
- **Validation**, all or nothing, no retry. The response is rejected when an obligation has no assessment or more than one, or an assessment names an ID that is neither an obligation nor an allowed `discovered:<kind>:<n>` (F003: `text`, `id`); an assessment has no `coverageDisposition`; the review, an assessment or an action cites no repository path; an `investigated` obligation does not cite its own file, or an obligation about a file outside the snapshot is not `unresolved`; an `aligned_fact` is `unresolved` or an `evidence_gap` is `investigated`; a discovered assessment is anything but `substantive_concern` or `evidence_gap`; `likely_sufficient` comes with a concern, gap, policy question, unresolved disposition or withheld obligation; `likely_insufficient` has no `substantive_concern`; or `needs_reviewer_judgment` has no reviewer action. `likely_sufficient` therefore means every obligation given was checked and holds.
- **Report.** Each checklist item shows the agent's result for its obligations ("Supported by evidence", "Potential problem", "Needs verification", …); discovered findings, the recommendation, summary and reviewer actions follow in the review's own section. A criterion with nothing to review can give its own reason (`notRunReason`) instead of "no candidate evidence was available".

F003 asks the agent whether each missing id has English fallback text, whether each hard-coded candidate is shown to users, whether computed id families resolve to keys, and whether each invalid text would fail in react-intl; and to report other hard-coded text or missing ids as `discovered:text:<n>` or `discovered:id:<n>`.

## S006 Sensitive Information Review

S006 scans bounded high-signal text, configuration, documentation, CI, Docker, and env surfaces for committed sensitive or environment-specific information. It detects secret assignments, provider API keys and tokens, credential URLs, private key blocks, private URLs, tenant or host endpoints, and local absolute paths. Reports hide matched values: an assignment shows only its name, such as `DB_PASSWORD=[REDACTED]`, and other findings show their kind, such as `[REDACTED_PROVIDER_API_KEY]`. This is part of S006, not output masking. Agent prose is shown as written, so a value the agent quotes despite its instructions appears in the report.

Deterministic `fail` is reserved for high-confidence production, CI, or deployment evidence such as live-looking secrets, credential URLs, or production-like private keys. Documentation, samples, tests, fixtures, synthetic or default-ish values, local Docker defaults, tenant/host/private URL evidence, and materially weakened scan coverage remain `manual` for reviewer judgment.

When enabled, S006 agent review investigates manual results using the finding summary and surrounding committed source, including files not flagged by the scanner. Fingerprints are omitted from the summary. It distinguishes production usage from examples, fixtures, and local defaults without testing credentials or contacting endpoints, and must not reproduce secret values in its response. Excluded files, including `.env` files, remain outside browsing scope even if the deterministic scanner inspected them; the agent cannot certify those files or a secret-free repository. Agent review cannot pass or fail S006. Unavailable review preserves deterministic evidence and records its reason.

The review must give each retained finding and material coverage gap a cited
`coverageDisposition`: investigated, immaterial to the scoped decision, or unresolved.
It also describes the actual investigation scope. Extra discoveries use
`discovered:<normalized-id>` assessments. Direct investigation of an unavailable
path is rejected. Findings whose original source is unavailable must remain
unresolved: related documentation cannot establish excluded committed contents.
The input explicitly marks source availability; exclusion does not mean a file is
absent from the repository. Incomplete scanner coverage can be resolved through additional
investigation or justified as immaterial, but file availability alone is not proof
of inspection. Unresolved obligations prevent a likely-sufficient recommendation;
coverage gaps alone do not justify likely-insufficient advice.

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

The default timeout is 120,000 ms, or 420,000 ms for F criteria. The timeout applies independently to each OpenCode command: debug configuration verification, debug agent verification, and the review run. Criteria execute sequentially, so one criterion review—and the complete evaluation—may take longer than the configured timeout. A longer timeout is only a ceiling; it does not guarantee a successful provider response. The evaluator does not retry agent commands, although OpenCode or the selected provider may have its own internal retry behavior.

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

`agent-debug.json` records each command's start/end time, duration, status, exit code/signal, output byte counts, and truncation flags, including failed and timed-out commands. For the review command it also retains up to 2,000 content-free events from the captured output, which is the end of the output when it was cut: event type, OpenCode-reported timestamp, allowlisted tool name/status, and tool duration when supplied. Unknown names are replaced with `other`. Prompts, environment variables, credentials, paths, tool inputs/outputs, assistant prose, and reasoning text are not included in the trace. The trace file is owner-readable/writable only.

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

Malformed or uncited assessment/action records reject the response; they are not
silently dropped while preserving its overall conclusion. Nested failure-bound
records are validated and require repository citations too. These checks enforce
structural consistency, not the truth of model-authored explanations.

The narrow exception is an unresolved S006 coverage-gap assessment whose ID was
supplied by the evaluator: it may cite the scanner's generated coverage diagnostics.
Those diagnostics establish a scan limitation, not repository contents. Resolved
gaps, source findings, overall advice, and reviewer actions still require source
citations. Invalid-record diagnostics identify record indexes and fixed failure
categories without echoing rejected values.

Agent-review failures are reported without exposing raw provider output or credentials:

- **Timeout:** choose a faster model or explicitly increase `--criterion-agent-timeout-ms` within the supported range of 1–2147483647 ms.
- **Provider error:** inspect provider credentials, quota, account status, and endpoint configuration. Do not print credentials while troubleshooting.
- **Capture overflow:** the review command's output is mostly tool events, and the answer comes last. The evaluator keeps at most the last 16 MiB of it, so memory stays bounded. If more was written, the earlier output is dropped, together with the rest of the assistant message that was in progress at the cut, because its lost start may have held the start of a masked credential. The review is then used only if the kept output contains the final answer's whole assistant message, and a warning reports the output size and the limit. Otherwise the review is unavailable with `capture truncated`. The `opencode debug` commands keep the first 64 KiB, and the review is unavailable if their output is cut.
- **Malformed, invalid, or incomplete response:** inspect the evaluator's sanitized diagnosis and, if useful, rerun the OpenCode command manually in a trusted environment.

These categories diagnose the observed command or response; they do not make claims about provider reliability. In every failure category, evaluation continues with the deterministic result and evidence.

New evaluation results include optional provenance with the resolved target commit,
evaluator package/version, configured agent model, and committed source paths cited
by explicit structured criterion evidence or agent-review references. Incidental path
text in narrative evidence and diagnostics does not add a source citation. HTML
reports use that inventory for commit-pinned GitHub links and offer a report-safe
JSON download with the standard `EvaluationResult` shape. Both payloads, like the JSON
report, have the evaluator's own credentials masked and are otherwise unchanged. Any
credentials in the repository URL are removed before it is embedded in the download. OpenCode runtime metadata is omitted from the
embedded download. Historical results without provenance remain renderable. Failed
and timed-out reviews are shown as unavailable; configuration and no-evidence skips
remain distinct.

Malformed-response reports distinguish invalid transport records, unparseable or too deeply nested records, and invalid final assistant JSON. Capture diagnostics retain at most 16 content-free entries with record numbers, allowlisted rejection categories, and assistant JSON parseability before and after sanitization. They do not retain raw rejected text, arbitrary field names, or tool previews. Native tool/reasoning payloads are omitted from captured output while their lifecycle boundaries remain; incomplete file previews cannot invalidate later advice. Advisory JSON is parsed, and text parts of one message are joined, before credentials in its decoded values are masked, so a credential split across parts is still masked.

## Output masking

The evaluator masks its own credentials, not repository content. Wherever the exact current value of one of these variables appears in command output, agent output, error messages, the console error, or the JSON and HTML reports, it is replaced with `[REDACTED_<VARIABLE>]`, such as `[REDACTED_OPENROUTER_API_KEY]`:

- `OPENROUTER_API_KEY` and `OPENAI_API_KEY` (agent review providers);
- `SONAR_TOKEN` and `GITHUB_TOKEN` (remote lookups);
- every variable named by `--criterion-agent-provider-env` or `--criterion-agent-proxy-env`.

Every string of at least 8 characters in a trusted auth store's JSON (`--criterion-agent-auth-store`), such as API keys and OAuth tokens, becomes `[REDACTED_AUTH_STORE]`; a token OpenCode refreshes during the run is not known in advance and is not masked. Unset variables and values shorter than 8 characters are not masked. Only the exact value is matched, not an encoded form such as a JSON-escaped or percent-encoded one. Text is masked before it is cut to a size limit, and when output was already cut while it was captured, a credential's start left at the cut is dropped. Nothing else is redacted: repository text, command output, and agent advice that quote tokens, passwords, private URLs, or keys appear as written.

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
