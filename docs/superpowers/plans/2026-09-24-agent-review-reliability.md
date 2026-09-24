# Agent Review Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. If those skills are unavailable, follow the selected native execution method and this plan directly; do not invent tool capabilities.

**Goal:** Preserve useful S005 agent rationale and make optional agent reviews accept only complete, valid evidence-backed output while reporting transport failures safely.

**Architecture:** Keep the existing CommandRunner → OpenCode adapter → shared advisory normalizer → criterion/report flow. Add opt-in structure-preserving capture at the runner boundary, explicit capture diagnostics, and final-response-aware decoding in the adapter. Budget S005 deterministic and advisory report sections independently within the existing total.

**Tech Stack:** TypeScript, Node.js child_process, Jest/ts-jest, existing HTML renderer, OpenCode CLI (repository devcontainer pins 1.17.11).

**Spec:** User-requested scope and Oracle findings in https://ampcode.com/threads/T-01a0d527-88a0-752d-9784-d50bb0760030; original reproduction and outstanding findings in https://ampcode.com/threads/T-01a0d089-834c-704c-bac5-5ac8f1dd60f0. The constraints and acceptance cases below are the execution brief; no separate spec file is needed for these repairs to existing flows.

## Global Constraints

- Advisory success or failure must not change deterministic criterion status or erase deterministic findings.
- S005 details remain at most 12,000 UTF-8 bytes, including separators and truncation markers; deterministic evidence stays before agent review.
- Preserve the full redacted S005 report when it fits; apply section/field budgets only on overflow, protecting contradiction/mismatch text as well as advice.
- Keep the existing 1 MiB OpenCode run capture limit and 120,000 ms default command timeout. Report overflow honestly rather than raising limits.
- No automatic retries, punctuation-based JSON repair, provider migration, SDK/server integration, new dependencies, or unrelated refactoring.
- Never return, log, persist, or cache unsanitized subprocess output. Raw bytes may exist only inside bounded capture/decoding. Do not weaken secret patterns to preserve JSON.
- Preserve known recommendation aliases, numeric confidence in [0,1], object-shaped references, direct JSON, and existing supported event wrappers unless they contain explicit failure/incomplete signals.
- Proposed acceptance tightening: available advisory output requires at least one surviving manifest citation. A generated evidence file in the manifest qualifies; do not require a direct repository path for S005/S006.
- Do not execute target repository builds without explicit authorization. Local synthetic test subprocesses are permitted; they are not target-controlled build scripts.
- Do not overwrite or import the other thread's uncommitted S007 work implicitly. No push, PR, merge, or deployment is included.

## Review Focus

1. Nested JSON containing escaped quotes, backslashes, and already-redacted assignments must remain decodable without exposing secrets (Task 2).
2. A valid earlier response followed by incomplete final output must not be accepted as current advice (Task 3).
3. Oversized stdout and a literal truncation-marker string must be distinguishable using capture metadata (Tasks 2–3).
4. Multibyte text and very long review fields must respect byte budgets without losing all rationale or metadata (Task 1).
5. New validation failures must preserve deterministic status and redacted findings, including when every citation is unknown (Tasks 4 and 6).

## Ownership and delivery baseline

At planning time this checkout was clean before adding this document. The original review thread reports its earlier S007 fixes are local/uncommitted, not on origin/master. Those fixes are not reimplemented here. At execution start, inspect `git status --short`; if S007 work has since been transferred, preserve it and run its tests as part of combined validation. Otherwise report it as a separate outstanding delivery dependency rather than claiming all earlier fixes have shipped.

Implementation should be single-threaded through Tasks 2–4 because their contracts overlap. Task 1 is independent. Use a local commit per passing task, staging only owned paths/hunks; commits do not authorize a push.

## File map

| Owner | Responsibility |
| --- | --- |
| `src/utils/s005-personal-data-disclosure-report.ts` | S005 report byte allocation |
| `src/types/index.ts` | Backward-compatible command capture options/result metadata |
| `src/utils/command-runner.ts` | Bounded capture, format-aware sanitization selection, cache identity |
| `src/utils/redaction.ts` | Existing text redaction; preserve default behavior |
| `src/utils/opencode-output.ts` (new) | Small cohesive OpenCode JSON framing/redaction and event decoding unit; no subprocess execution or policy decisions |
| `src/utils/opencode-agent-adapter.ts` | Invocation, permission checks, outcome precedence, normalized review result |
| `src/utils/criterion-agent-review.ts` | Shared advisory field/citation validation |
| `src/utils/agent-review-config.ts` | CLI timeout bounds |
| `src/utils/s005-agent-review.ts`, `src/utils/s006-agent-review.ts` | Explicit single-object output instruction/examples |
| `docs/agent-review.md` | Timeout semantics, troubleshooting, acceptance contract |

Move existing parser helpers into the new output module without changing behavior first, run existing tests, and commit that extraction separately before altering parsing. This boundary avoids importing the adapter (and its workspace/config dependencies) into the generic runner.

## Task 1: Preserve S005 review within the existing report budget

**Files:** modify `src/utils/s005-personal-data-disclosure-report.ts`; test `src/__tests__/s005-shared-evaluator.test.ts`, `src/__tests__/s005-personal-data-disclosure.test.ts`, and `src/__tests__/report-renderer.test.ts`.

**Interfaces:** keep `formatS005Evidence(analysis, moduleKind, agentReview?): { evidence: string; details: string }` unchanged. Reuse `redactS005PersonalDataText` for byte-safe field/section bounds.

- [ ] Add a failing formatter regression using the existing analysis fixture with large deterministic warnings/evidence and a successful review. Include contradiction evidence, `SUMMARY_END`, `RATIONALE_END`, and `MODEL_END` in moderate-sized fields; use multibyte text to force byte rather than character accounting. Add a second case with oversized summary and rationale, asserting a useful rationale prefix and metadata survive even when field ends must be truncated.
- [ ] Put more than 8,000 bytes of supporting detail before contradictions, not only in trailing warnings. Assert the fixture's concrete contradiction message and reference remain present. Add a short-total report with a rationale longer than 1,800 bytes and assert its complete redacted text is unchanged.

```ts
expect(Buffer.byteLength(details, 'utf8')).toBeLessThanOrEqual(12_000);
expect(details).toContain('Advisory recommendation: likely_insufficient');
expect(details).toContain('RATIONALE_END');
expect(details).toContain('MODEL_END');
expect(details).toContain('Contradictions:');
expect(details).toContain('Agent review:');
// Also assert the fixture's exact contradiction message and evidence reference.
expect(details.indexOf('Contradictions:')).toBeLessThan(details.indexOf('Agent review:'));
expect(details).not.toContain('synthetic-person@example.org');
expect(details).not.toContain('\uFFFD');
```

- [ ] Run `yarn test --runInBand src/__tests__/s005-shared-evaluator.test.ts src/__tests__/s005-personal-data-disclosure.test.ts`; confirm the new long-evidence case fails because review text is lost.
- [ ] First construct the full report in its existing order and redact it without lossy truncation (pass an explicit budget large enough for the source plus redaction expansion; do not rely on the helper's default cap). Return that text unchanged when its UTF-8 length is at most 12,000. Only on overflow, construct supporting details, contradictions/mismatches, trailing warnings, and advisory sections separately.
- [ ] On overflow reserve up to 4,000 bytes for advice, 2,000 for contradictions/mismatches, and 500 for trailing warnings, using actual bounded lengths rather than always withholding their maximums. Give supporting details the remainder after separators. Keep the original section order: supporting details → contradictions/mismatches → warnings → advice. Within the protected findings section bound long messages/references so one oversized entry cannot erase all other findings; preserve existing item limits and explicit omission markers. Structured criterion findings remain complete within their existing independent limits.

```ts
// Overflow branch only; each section includes its own heading.
const agentText = redactS005PersonalDataText(agentLines.join('\n'), 4_000);
const findingsText = redactS005PersonalDataText(findingsLines.join('\n'), 2_000);
const warningsText = redactS005PersonalDataText(warningLines.join('\n'), 500);
const tail = [findingsText, warningsText, agentText].filter(Boolean).join('\n');
const separator = tail ? '\n' : '';
const supportBudget = 12_000 - Buffer.byteLength(separator + tail, 'utf8');
const details = redactS005PersonalDataText(supportingLines.join('\n'), supportBudget)
  + separator + tail;
```

- [ ] In the overflow branch only, bound summary to 900 bytes, rationale to 1,800, each warnings/errors aggregate to 200, adapter/model to 100/200, and unavailable reason to 1,000. Keep heading/recommendation/confidence short and fixed. These field bounds leave room for labels and metadata within 4,000 bytes. Do not promise every oversized field's end sentinel survives. Empty sections reserve no bytes; no-agent overflow still protects findings, while fitting no-agent reports remain unchanged.
- [ ] Keep the existing contradiction-before-advice test and add an HTML renderer assertion that rationale and metadata appear in expanded details. Test unavailable review text, short reports, and no-agent reports too.
- [ ] Run the three named suites, then commit `fix(s005): reserve report space for advisory review`.

## Task 2: Preserve structured output while redacting secrets

**Files:** modify `src/types/index.ts`, `src/utils/command-runner.ts`, `src/utils/opencode-agent-adapter.ts`; create `src/utils/opencode-output.ts`; test `src/__tests__/command-runner.test.ts`, `src/__tests__/criterion-agent-review.test.ts`, and new `src/__tests__/opencode-output.test.ts`.

**Interfaces:** add optional `stdoutFormat?: 'text' | 'json' | 'opencode-json'` to `CommandExecutionRequest`; default is text. Add optional `stdoutBytes`, `stderrBytes`, `stdoutTruncated`, `stderrTruncated` to `CommandExecutionResult` so existing injected runners remain compatible. Byte counts describe received raw stream bytes; truncation flags cover raw capture loss or sanitized-output budget loss. Include stdoutFormat in command cache identity.

- [ ] Extract current decoding helpers into `opencode-output.ts` without behavioral changes; export `parseOpenCodeReviewPayload(output: string): Record<string, unknown> | undefined`. Run existing criterion-agent tests and commit `refactor: isolate OpenCode output decoding`.
- [ ] Add a real-runner test that prints NDJSON with an advisory embedded in `part.text`; do not rely only on FakeRunner's `sanitized: true` assertion.

```ts
const advisory = { recommendation: 'needs_reviewer_judgment', confidence: 'medium',
  summary: 'Example password=[REDACTED]', rationale: 'Inspect README.md.',
  evidenceReferences: ['README.md'] };
const wire = JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify(advisory) } });
const result = await new LocalCommandRunner().run({ command: process.execPath,
  args: ['-e', 'process.stdout.write(process.env.TEST_WIRE ?? "")'], cwd: process.cwd(),
  env: { TEST_WIRE: wire },
  stdoutFormat: 'opencode-json' });
expect(JSON.parse(JSON.parse(result.stdout).part.text)).toEqual(advisory);
```

- [ ] Confirm failure on existing redaction. Extend through real runner → decoder with nested JSON containing synthetic raw secrets, quoted values/backslashes, fenced JSON, direct JSON, prose-wrapped JSON with stray prose braces and a preceding non-advisory object (the existing supported regression), secret-bearing object keys, private URLs, and tool/error events. Assert secrets are absent from the entire serialized result, not just the accepted advisory. Pass synthetic wire data via `TEST_WIRE`, not command arguments, because returned args/cache identity contain arguments; command-argument redaction is outside this repair.
- [ ] Implement `sanitizeStructuredOutput(output: string, format: 'json' | 'opencode-json', maxBytes: number): { text: string; truncated: boolean }` in the output module. Share supported text recognition with the decoder: whole JSON, fenced JSON, prose-wrapped advisory JSON, and existing event wrappers. Parse outer objects before redacting decoded values and reserializing; decode embedded structured strings at their own encoding boundary, including tool/error strings, not only assistant text. Redact an entire value/subtree for secret-named properties, and redact credential literals in property names too. Do not run generic regex redaction on serialized JSON again.
- [ ] Fail closed for unparseable structured content whose safe redaction cannot be established: replace the unsafe record/fragment with a fixed failure representation recognized by the decoder. Do not return a raw fragment, best-effort regex excerpt, or diagnostic containing original content. A later unsafe record must not disappear and allow earlier advice to succeed. Test an unterminated `{"password":"synthetic-secret`, nested malformed tool/error JSON, and malformed content following valid advice. Safe ordinary prose around a supported advisory remains compatible; ambiguity about an unfinished replacement is handled by Task 3.
- [ ] Preserve whole records when bounding serialized NDJSON; if one record cannot fit, mark truncated and reject its use. Plain text capture retains its existing semantics. JSON debug output uses the JSON mode; `opencode run` uses opencode-json mode.
- [ ] Populate explicit capture metadata in the runner. Test exact byte limit versus limit+1, redaction expanding the sanitized representation, chunk splits through UTF-8, and literal `[output truncated ...]` text without actual overflow. Test that different capture formats produce distinct cache identities.
- [ ] Run `yarn test --runInBand src/__tests__/command-runner.test.ts src/__tests__/opencode-output.test.ts src/__tests__/criterion-agent-review.test.ts` and `yarn build`; commit `fix: preserve JSON framing during command output redaction`.

## Task 3: Reject incomplete final responses and classify failures

**Files:** modify `src/utils/opencode-output.ts`, `src/utils/opencode-agent-adapter.ts`; test `src/__tests__/opencode-output.test.ts`, `src/__tests__/criterion-agent-review.test.ts`.

**Interfaces:** replace the internal payload-only decoder with `decodeOpenCodeOutput(output: string): OpenCodeOutput`, exported from the output module. Keep diagnostics in existing review errors/warnings rather than adding a new public report schema.

```ts
export interface OpenCodeOutput {
  payload?: Record<string, unknown>;
  failure?: 'provider_error' | 'incomplete_response' | 'no_assistant_text' | 'malformed_json';
  finishReason?: string;
  providerError?: { name?: string; message?: string; statusCode?: number };
}
```

- [ ] Add failing event-sequence tests: earlier valid object then final malformed text; earlier valid object then a new assistant message/step with no text; final tool call without a subsequent answer; native lifecycle stream missing its final finish record; one envelope containing a valid advisory followed by an unfinished replacement object; earlier valid object then final `length` or `unknown`; tool-call step then completed valid answer; error event after valid text; nonzero exit whose only explanation is stdout; empty assistant output; truncated output whose prefix happens to contain a valid answer. Positive cases cover multiple completed text parts in one message, distinct messages, prose braces before valid advice, and all supported finish-less legacy forms.
- [ ] Obtain sanitized fixtures/schema examples from the pinned OpenCode version's authoritative source before choosing message/step keys. Record an immutable source reference with the fixtures. Verify completed-part emission and terminal reason names rather than treating the prior review's observations as verified protocol facts. If that version cannot be verified, report the fixture-source blocker; do not silently substitute current-branch behavior.
- [ ] Implement selection before payload validation using the following decision table. Share candidate recognition with sanitization. Remove the existing fallback to a prior parseable advisory both across messages and within one selected envelope.

| Input/sequence | Selection and completion rule |
| --- | --- |
| Direct advisory JSON, with no event lifecycle | Validate directly; no finish record required. |
| Existing finish-less legacy wrappers (`part`, `parts`, text/content, message content/parts) | Preserve tested wrappers. Without lifecycle markers/IDs, select the last text envelope; do not join independent answers. |
| Native stream with lifecycle/message/step markers | Select the latest assistant message/step, even if it has no text. Require its verified successful terminal outcome; missing terminal record is incomplete. |
| Multiple completed text parts with the same verified message identity | Combine only those parts in order before parsing; do not treat completed parts as token deltas. |
| Later message/step is empty or ends in a tool call | Earlier advice is superseded; report no assistant text or incomplete response, not success. |
| Final `length`, `unknown`, error, or non-success terminal reason | Reject; a prior valid payload cannot override that result. Map successful reason names only from pinned-version fixtures. |
| Selected text has valid advice followed by an unfinished/malformed replacement | Reject the final candidate; never recover the earlier valid object. Distinguish JSON-like replacements from ordinary prose braces using shared recognition tests. |
| Selected text has supported prose/non-advisory preamble followed by valid final advice | Accept that final candidate after field validation; preserve the existing prose-wrapped regression. |

- [ ] Apply outcome precedence: timeout/blocked/nonzero command status first; capture truncation next; provider error or explicit incomplete finish next; then missing text, malformed JSON, field validation. Preserve provider error detail alongside a nonzero exit, but never relabel a timeout as malformed JSON. Do not universally require finish records: only lifecycle-bearing streams require them, per the table.
- [ ] Report bounded redacted error name/message/status only. Include stage (`debug config`, `debug agent`, `run`), observed duration, configured timeout, model label, finish reason, and capture counts when available. Do not serialize arbitrary provider response bodies/headers. Existing errors arrays are sufficient.
- [ ] Extend FakeRunner to return injected failures and capture flags. Assert each timeout prevents later stages and total invocation count proves no automatic retry. Ensure config/agent debug capture truncation fails permission verification rather than accepting partial policy output.

```ts
expect(result.available).toBe(false);
expect(result.errors.join('\n')).toContain('capture truncated');
expect(runner.requests.filter(r => r.args?.[0] === 'run')).toHaveLength(1);
```

- [ ] Run `yarn test --runInBand src/__tests__/opencode-output.test.ts src/__tests__/criterion-agent-review.test.ts src/__tests__/command-runner.test.ts`; commit `fix: classify incomplete OpenCode review outcomes`.

## Task 4: Validate advisory fields and usable citations consistently

**Files:** modify `src/utils/criterion-agent-review.ts`, `src/utils/opencode-agent-adapter.ts`, `src/utils/s005-agent-review.ts`, `src/utils/s006-agent-review.ts`; test `src/__tests__/criterion-agent-review.test.ts`, `src/__tests__/s004-agent-review.test.ts`, `src/__tests__/s005-agent-review.test.ts`, `src/__tests__/s006-agent-review.test.ts`, `src/__tests__/s007-agent-review.test.ts`.

**Interfaces:** add `errors: string[]` to `NormalizedCriterionAgentAdvisoryPayload`. Shared normalizer owns validation; both fake and OpenCode adapters reject nonempty errors. Preserve supported aliases and object references, and the existing specialized S007 contract.

- [ ] Add table-driven normalization tests for missing/non-array references, empty list, all unknown references, mixed known/unknown references, whitespace-only summary/rationale, invalid recommendation, and confidence `-0.01`, `1.01`, NaN, Infinity. Test `0`, `0.4`, `0.75`, `1` with independently expected categories low/medium/high/high.

```ts
const normalized = normalizeCriterionAgentAdvisoryPayload({
  recommendation: 'pass', confidence: 0.75, summary: 'Evidence checked.',
  rationale: 'README supports this advice.', evidenceReferences: ['missing.md']
}, ['README.md']);
expect(normalized.errors).toContain('evidenceReferences must include a manifest entry');
expect(normalized.evidenceReferences).toEqual([]);
```

- [ ] Run criterion-agent tests and observe failures; then trim text before checking nonempty content, require a reference array and one surviving manifest reference, and validate finite numeric confidence within [0,1]. Return field-specific errors without echoing invalid values. Mixed references retain valid citations with the existing dropped-reference warning.
- [ ] Replace duplicated adapter truthiness gates with shared validation errors. Keep successful normalized fields unchanged. Add tests that generated S005/S006 evidence manifest paths qualify and that supported aliases/object references still work.
- [ ] Add a positive S006 coverage-only review citing only its generated summary manifest entry. Assert it remains available; no direct repository citation is required. Split S007 empty-citation and summary-only regressions: empty citations receive the shared validation error, while summary-only citations still fail S007's specialized repository-backed rule. Preserve that rule, not its previous error wording for an earlier validation failure.
- [ ] Give S005/S006 the explicit single-object/no-prose/no-fences instruction already used by S004. Include a JSON example with canonical keys and a manifest citation; do not change criterion reasoning or policy. Keep decoder compatibility with previously supported fenced output.
- [ ] Run all five named agent-review suites plus `yarn build`; commit `fix: validate evidence-backed advisory responses`.

## Task 5: Validate timer bounds and document troubleshooting

**Files:** modify `src/utils/agent-review-config.ts`, `docs/agent-review.md`; test `src/__tests__/cli-options.test.ts` and adapter timeout tests from Task 3.

**Interfaces:** `buildCriterionAgentReviewConfig` retains its signature; invalid timeout strings throw an actionable range error. This task changes CLI validation, not generic runner scheduling or default timeout.

- [ ] Add failing boundary tests accepting `1`, `180000`, `420000`, `2147483647`, rejecting `0`, `-1`, `1.5`, `180000ms`, `2147483648`, and an unsafe integer string.
- [ ] Implement the upper bound in the existing positive-integer parser.

```ts
if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
  throw new Error(`Invalid ${label}: expected an integer between 1 and 2147483647`);
}
```

- [ ] Document: 120,000 ms default; the override applies independently to debug config, debug agent, and run; criteria execute sequentially; total criterion/evaluation time may exceed one timeout. Show adding `--criterion-agent-timeout-ms 420000` to the existing documented invocation. State that a longer timeout is a ceiling, not a success guarantee, and that the evaluator adds no retries while OpenCode/provider behavior may include internal retries.
- [ ] Document failure categories and actions: timeout → explicit longer timeout/model choice; provider error → credentials/quota/provider inspection without printing secrets; capture overflow → unavailable review, no advice inferred from prefix; malformed/invalid/incomplete response → inspect sanitized diagnosis and optionally rerun manually. Explain valid citation requirement and unchanged deterministic fallback.
- [ ] Run `yarn test --runInBand src/__tests__/cli-options.test.ts src/__tests__/criterion-agent-review.test.ts`; commit `fix: bound agent timeout configuration and document failures`.

## Task 6: Verify combined behavior and rendered reports

**Files:** tests in `src/__tests__/s006-shared-evaluator.test.ts`, `src/__tests__/report-renderer.test.ts`; use existing report fixtures/generation APIs. No generated report or lifecycle file is committed.

- [ ] Add OpenCode-adapter-backed S006 regressions for malformed JSON, timeout, and all-unknown citations. Use synthetic command responses and the existing prepared evidence path; do not use the fake advisory adapter for these cases. Compare deterministic status and structured findings against the same fixture with review disabled, excluding only advisory-specific fields.

```ts
expect(withFailedReview.status).toBe(EvaluationStatus.MANUAL);
expect(withFailedReview.status).toBe(withoutReview.status);
expect(withFailedReview.agentReview?.available).toBe(false);
expect(JSON.stringify(withFailedReview)).not.toContain('synthetic-secret-value');
```

- [ ] Run `yarn test:unit --runInBand`, `yarn test --runInBand src/__tests__/integration/cli.integration.test.ts -t 'Local S00[247]'`, and `yarn build`, followed by `git diff --check`. Do not run the unrestricted integration suite: it executes target-controlled builds. Report real failures and distinguish pre-existing failures; never remove tests or weaken assertions merely to achieve green checks.
- [ ] Render synthetic S005 long-evidence/successful-review and S006 unavailable-review HTML using the existing renderer fixture APIs. Check expanded DOM text contains preserved S005 rationale/metadata and actionable S006 fallback, with deterministic evidence before advice. This avoids requiring a paid/provider-backed run for acceptance.
- [ ] Load the using-agent-browser skill, serve the temporary report directory using `amp orb service start <name> --command 'python3 -m http.server "$PORT" --directory <temporary-report-directory>' --portal`, and inspect at 2x DPR. Save a representative screenshot under `.amp/in/artifacts/`, inspect it with view_media naming expected rationale and fallback text, and include the inspected screenshot and exact returned portal URL in the implementation handoff. Do not hardcode a service port or share localhost.
- [ ] A real model smoke test is optional and requires an authorized provider configuration; it is not a substitute for regressions. Do not execute trusted-target build commands or upload unapproved repository content merely to validate this patch.
- [ ] Commit integration tests as `test: verify advisory failures preserve deterministic reports`. Report final checks, commits, unpushed state, remaining separate S007 delivery work, and any unavailable verification. Remove scratch fixtures/reports not needed for user review.

## Completion criteria

- Successful S005 advice and bounded contradiction/mismatch evidence remain visible under heavy supporting detail within 12,000 UTF-8 bytes; fitting reports are not newly truncated.
- Real runner sanitization preserves supported JSON framing, including prose-wrapped advice, removes synthetic secrets, and replaces unsafe malformed fragments without disclosing them.
- Timeout, provider failure, capture loss, missing text, malformed JSON, incomplete response, and invalid fields are distinguishable without raw output disclosure.
- Earlier advice cannot hide a later incomplete final response, empty assistant step, unfinished tool-call sequence, or malformed replacement within the final envelope.
- Both advisory adapters enforce the same field/citation rules; deterministic statuses and findings remain unchanged.
- No automatic retries, default timeout increase, report/capture limit increase, or external integration migration.
- Combined tests/build and representative rendered report checks are recorded; implementation remains local until separately authorized to ship.

## Execution results

Implementation is complete locally. The task lists above record the planned sequence; this section records the actual outcome and verification limits.

- S005 budgets successful advice and deterministic findings within 12,000 UTF-8 bytes. Rendered verification revealed that the HTML template independently promoted advice; it now preserves evidence-first ordering for S005 without changing other criteria.
- Structured command capture redacts decoded JSON without breaking framing, reports capture loss, and rejects stale or incomplete final OpenCode answers. Both advisory adapters validate fields and manifest citations. Timeout validation and troubleshooting documentation are implemented without increasing defaults or adding retries.
- `yarn test:unit --runInBand`: 644 passed, 1 skipped; 34 suites passed, 1 skipped. `yarn build` and `git diff --check` passed.
- Selected safe local CLI integration checks: 2 passed, 3 failed, 9 skipped. Existing failures expect HTML entities rather than JSON Unicode escapes (S002/S004), or old “Criterion S007” markup. These integration tests remain unchanged.
- An initial unrestricted test run reached a real-target Maven integration test and was stopped. It was not repeated; the safe commands above replace it. No live provider smoke run was performed.
- Synthetic S005 successful-review and S006 unavailable-review HTML was inspected at 2x DPR. Executed DOM checks confirmed retained rationale/model, evidence-before-advice ordering, and the incomplete-response fallback. The inspected screenshot is `.amp/in/artifacts/advisory-report.png`; generated reports and service artifacts are not committed.
- Separate S007 work in the source thread was not imported. Changes are committed locally only; pushing, merging, and deployment remain outside this authorization.
