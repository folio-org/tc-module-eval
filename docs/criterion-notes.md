# Criterion Notes

This document collects criterion-specific evaluator behavior that is too detailed for the README.

## S002 Descriptor Generation

Descriptor validation may run descriptor-producing build commands when a static descriptor is not present. Treat this like other build execution: only enable local command execution for trusted repositories and trusted runner environments.

## Source Inspection Boundaries

Source-inspection evidence gathering is read-only: it does not mutate evaluated repositories and does not execute repository code, tests, builds, services, databases, or Okapi calls.

## S005 Personal Data Disclosure Review

Personal data disclosure evaluation checks `PERSONAL_DATA_DISCLOSURE.md` mechanics, completion, and bounded source-inspection evidence. Completed forms remain subject to manual review; the tool does not certify legal or privacy compliance.

## S006 Sensitive Information Review

Sensitive-information evaluation uses Gitleaks against the checked-out working tree, plus bounded local checks for credential URLs, concrete secret assignments, FOLIO/environment-specific endpoints, and local paths. Reports use redaction and never expose raw sensitive values; high-confidence production, CI, or deployment evidence can fail deterministically, while documentation, fixtures, local defaults, private endpoints, and scan-coverage uncertainty stay subject to manual review.

The devcontainer and GitHub Actions workflows install Gitleaks automatically. For other local runs, install the `gitleaks` binary on `PATH`, or set `GITLEAKS_PATH` to use a specific binary. If Gitleaks is unavailable or fails, sensitive-information review reports a material scanner warning and returns manual review rather than silently passing.

## S007 Officially Supported Technologies

S007 always evaluates the current committed
`config/officially-supported-technologies.json`. The evaluator has no policy selector,
does not query Confluence, and does not report a delivery-train context. Optional
source metadata is reviewer background only. Policy maintainers update this one file
in place; the schema validates its complete shape and Git history records earlier
states.

### Evidence boundary

S007 reads repository-resident evidence only:

- Maven POMs, declared local modules, local parents, properties, and local dependency
  management;
- Groovy or Kotlin Gradle files, declared local modules, literal coordinates and
  plugins, Java compatibility settings, and local `gradle.properties` values; and
- `package.json` dependency fields plus exact resolutions from a top-level Yarn
  Classic lockfile.

It does not execute Maven, Gradle, npm, Yarn, repository scripts, or an additional
build. Remote parents, imported BOMs, version catalogs, dynamic build logic,
unsupported lockfiles, symlinks, out-of-repository modules, and conflicting
declarations weaken coverage and prevent pass. Remotely resolved shared artifacts may
help a reviewer but cannot establish deterministic status.

The framework-indicator registry is code-owned in
`src/utils/s007-technology-evidence.ts`. It recognizes policy entries and explicit
unlisted candidates for Angular, Vue, Svelte, Express, NestJS, Micronaut, and Helidon.
Ordinary unlisted utility, logging, and test-support libraries are outside S007.

### Interpreting results

- `pass`: every detected relevant technology is covered by a definitive rule, every
  locally resolved version complies, and coverage is complete. A listed language or
  framework without a version constraint needs no version comparison.
- `fail`: at least one confident exact version or conclusively disjoint declared
  range violates an explicit normative rule. This takes precedence over concurrent
  manual findings.
- `manual`: evidence is missing, unresolved, overlapping, conflicting, or incomplete;
  a framework candidate is unlisted; or the applicable entry is advisory,
  provisional, contested, or otherwise requires reviewer judgment.

Reports identify the repository path, detected declaration or resolution, matched
policy section and entry, rule strength, per-technology contribution, and final
rationale. Recommendations and deprecation notes remain visible but cannot be the
sole reason for failure.

S012 build-tool evaluation, S013 testing evaluation, infrastructure compatibility,
live policy synchronization, and new-module applicability are outside S007.

## Advisory Agent Review

Some criteria can add optional OpenCode advisory review to manual results. Agent output is reviewer background only; it does not directly pass or fail a criterion. See [Agent Review Configuration](agent-review.md) for provider setup, CLI flags, supported criteria, and GitHub Actions notes.
