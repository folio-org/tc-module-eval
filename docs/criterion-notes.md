# Criterion Notes

This file records criterion behavior not covered in the README.

## S002 Descriptor Generation

When no static descriptor exists, descriptor validation may run its build command. Enable local commands only for trusted repositories and runners.

## Source Inspection Boundaries

Source inspection never modifies evaluated repositories or runs their code, tests, builds, services, databases, or Okapi calls.

## S005 Personal Data Disclosure Review

S005 checks `PERSONAL_DATA_DISCLOSURE.md` mechanics and completion, plus bounded source-inspection evidence. Completed forms still require manual review; S005 does not certify legal or privacy compliance.

## S006 Sensitive Information Review

S006 runs Gitleaks on the working tree and bounded checks for credential URLs, secret assignments, FOLIO or environment endpoints, and local paths. Reports redact raw values. High-confidence production, CI, or deployment evidence can fail; documentation, fixtures, local defaults, private endpoints, and incomplete scans require manual review.

The devcontainer and GitHub Actions install Gitleaks. Elsewhere, install `gitleaks` on `PATH` or set `GITLEAKS_PATH`. An unavailable or failed scanner produces a material warning and manual status.

## S007 Officially Supported Technologies

S007 evaluates the current committed `config/officially-supported-technologies.json`. It has no policy selector or Confluence lookup. Maintainers update this file in place; optional source metadata is for reviewer context only.

S007 reads static, repository-local Maven, Gradle, and package metadata. A top-level Yarn Classic lockfile may supply exact JavaScript versions. It does not run builds or repository code, and remote evidence cannot determine status. Unsupported, dynamic, remote, conflicting, or incomplete evidence prevents a pass.

- `pass`: every relevant technology has a definitive rule, all available version checks comply, and evidence is complete. Rules without version constraints require no comparison.
- `fail`: conclusive version evidence violates an explicit normative rule. A failure takes precedence over concurrent manual findings.
- `manual`: the evidence or policy requires judgment, including unlisted frameworks and advisory, provisional, or contested rules.

Recommendations and deprecation notes remain visible but cannot cause failure on their own.

S012 build tools, S013 testing, infrastructure compatibility, live policy synchronization, and new-module applicability remain outside S007.

## Advisory Agent Review

Optional OpenCode review can inform manual results but cannot change criterion status. See [Agent Review Configuration](agent-review.md) for setup and supported criteria.
