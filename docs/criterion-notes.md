# Criterion Notes

This document collects criterion-specific evaluator behavior that is too detailed for the README.

## S002 Descriptor Generation

Descriptor validation may run descriptor-producing build commands when a static descriptor is not present. Treat this like other build execution: only enable local command execution for trusted repositories and trusted runner environments.

## Source Inspection Boundaries

Source-inspection evidence gathering is read-only: it does not mutate evaluated repositories and does not execute repository code, tests, builds, services, databases, or Okapi calls.

## S005 Personal Data Disclosure Review

Personal data disclosure evaluation checks `PERSONAL_DATA_DISCLOSURE.md` mechanics, completion, and bounded source-inspection evidence. Completed forms remain subject to manual review; the tool does not certify legal or privacy compliance.

## S006 Sensitive Information Review

Sensitive-information evaluation uses Gitleaks for committed secret detection, plus bounded local checks for FOLIO/environment-specific endpoints and local paths. Reports use redaction and never expose raw sensitive values; high-confidence production, CI, or deployment evidence can fail deterministically, while documentation, fixtures, local defaults, private endpoints, and scan-coverage uncertainty stay subject to manual review.

The devcontainer and GitHub Actions workflows install Gitleaks automatically. For other local runs, install the `gitleaks` binary on `PATH`, or set `GITLEAKS_PATH` to use a specific binary. If Gitleaks is unavailable or fails, sensitive-information review reports a material scanner warning and returns manual review rather than silently passing.

## Advisory Agent Review

Some criteria can add optional OpenCode advisory review to manual results. Agent output is reviewer background only; it does not directly pass or fail a criterion. See [Agent Review Configuration](agent-review.md) for provider setup, CLI flags, supported criteria, and GitHub Actions notes.
