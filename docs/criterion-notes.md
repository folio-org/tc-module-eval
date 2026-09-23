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

S007 evaluates the current committed `config/officially-supported-technologies.json`. It has no policy selector, does not query Confluence, and does not report a release or delivery-train context. Policy maintainers update this file in place. Optional source metadata is reviewer context only.

S007 uses static, repository-local Maven, Gradle, and package metadata. A top-level Yarn Classic lockfile may supply exact JavaScript dependency versions. The evaluator does not run builds or repository code and does not use remote evidence to determine status. Unsupported, dynamic, remote, conflicting, or incomplete evidence prevents a pass.

- `pass`: every detected relevant technology is covered by a definitive rule, every available version check complies, and evidence is complete. A policy entry without a version constraint requires no comparison.
- `fail`: conclusive version evidence violates an explicit normative rule. A failure takes precedence over concurrent manual findings.
- `manual`: the evidence or applicable policy requires reviewer judgment, including unlisted framework candidates and advisory, provisional, or contested rules.

Recommendations and deprecation notes remain visible but cannot cause failure on their own.

S012 build-tool evaluation, S013 testing evaluation, infrastructure compatibility, live policy synchronization, and new-module applicability are outside S007.

## Advisory Agent Review

Some criteria can add optional OpenCode advisory review to manual results. Agent output is reviewer background only; it does not directly pass or fail a criterion. See [Agent Review Configuration](agent-review.md) for provider setup, CLI flags, supported criteria, and GitHub Actions notes.
