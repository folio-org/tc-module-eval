# FOLIO Module Evaluator

A CLI for evaluating FOLIO modules against technical council criteria.

Copyright (C) 2025-2027 The Open Library Foundation

This software is distributed under the terms of the Apache License,
Version 2.0. See the file "[LICENSE](LICENSE)" for more information.

## Overview

This tool provides a modular, extensible framework for automatically evaluating a module against
[FOLIO module acceptance criteria](https://github.com/folio-org/tech-council/blob/master/MODULE_ACCEPTANCE_CRITERIA.MD).

See [Criterion Notes](docs/criterion-notes.md) for criterion-specific behavior, runtime requirements, and review boundaries.

**Note**: Dependency analysis covers the dependencies a module distributes, including transitive ones, for Maven, Gradle, and npm projects; test-only and development dependencies are excluded.  Go modules are not supported yet.

## Security

**⚠️ WARNING**: This tool executes build commands (Maven, Gradle, npm). Some criteria may also run descriptor-producing build commands when generated artifacts are required.

- **Local CLI usage**: Malicious build files (`pom.xml`, `build.gradle`, `package.json`) can execute arbitrary code with your local user permissions.
- **GitHub Actions usage**: Malicious build files execute in the runner environment with `GITHUB_TOKEN` permissions. Use least-privilege [job level](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions) and/or [workflow level](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions) `permissions` to reduce risk.

By default, local CLI runs use strict command execution and block build-tool commands that require isolation or network-policy enforcement. To run those commands in a trusted local environment, opt in explicitly:

```bash
folio-eval evaluate <repo-url> --allow-local-commands
```

When this flag is used, reports record where commands ran: `github-actions` in GitHub Actions and `local` elsewhere.

Source-inspection review is read-only: it does not mutate evaluated repositories and does not execute repository code, tests, builds, services, databases, or Okapi calls.

Evaluated repositories are open source, so reports show repository text, command output, and agent advice as written. Only the evaluator's own credentials are masked: the values of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `SONAR_TOKEN`, `GITHUB_TOKEN`, and any variable passed to OpenCode with `--criterion-agent-provider-env` or `--criterion-agent-proxy-env` become `[REDACTED_<VARIABLE>]` in all output, and the keys in an OpenCode auth store become `[REDACTED_AUTH_STORE]`. See [Output masking](docs/agent-review.md#output-masking).

### S007 Officially Supported Technologies

S007 evaluates a module against the current policy committed at
`config/officially-supported-technologies.json`. There is no policy selector and no
separate policy per delivery train. Git history preserves prior policy states.

By default, evaluation is static and read-only. It inspects local Maven and Gradle
metadata, `package.json`, and a top-level Yarn Classic lockfile. With
`--allow-local-commands`, Java evaluation may run the pinned Maven Help Plugin
`effective-pom` goal to process remote parents and BOMs for otherwise unresolved
dependency versions. Versions from a successfully validated, explicitly approved
effective POM participate in normative policy comparisons; other remote-derived
evidence remains diagnostic only. Default static S007 evaluation does not run a build,
call Confluence, or modify the evaluated repository. The opt-in Maven command does not
request a build lifecycle, but Maven model construction is not filesystem- or
network-isolated and may modify a trusted repository; see
[`docs/criterion-notes.md`](docs/criterion-notes.md). A definitive violation of a normative rule fails.
Unresolved, conflicting, advisory, provisional, contested, unlisted-framework, or
incomplete evidence remains manual. Pass requires complete relevant evidence and
compliance with every applicable definitive rule.

To update the policy:

1. Edit `config/officially-supported-technologies.json` in place. Do not add another
   policy file or selector.
2. Keep `formatVersion` aligned with
   `src/schemas/officially-supported-technologies.schema.json`. Historical source
   metadata is optional and does not affect status.
3. Preserve normative strength, recommendations, provisional or contested wording,
   applicability exceptions, deprecations, and reviewer notes explicitly.
4. Run `yarn test --runInBand --testPathPattern=s007-policy` and `yarn build`.

S007 consumes only applicable language and framework entries. S012 consumes the
build-tool sections and S013 the testing sections; the infrastructure sections are kept
for future criteria. See [Criterion Notes](docs/criterion-notes.md) for reviewer guidance.

### S012 Officially Supported Build Tools

S012 checks the tools that build the module (Maven, Gradle, Make, Yarn, npm, Node.js,
and others) against the build-tool sections of the same policy. It reads build files
and GitHub Actions workflows only, so it runs in safe mode without network access.
When a repository pins no version, the versions FOLIO's shared workflows supply come
from the maintainer-reviewed `config/folio-shared-workflows.json`. See
[Criterion Notes](docs/criterion-notes.md#s012-officially-supported-build-tools).

### S011 SonarQube Findings

S011 reads the module's SonarCloud analysis (`org.folio:<repository>`) and fails on any open
security issue, unreviewed security hotspot, open high or blocker issue (test code included), or
duplication above 3%. It also scans the repository and its CI for Sonar rule suppressions
(`@SuppressWarnings`, `NOSONAR`) and exclusions, which a reviewer must judge. It needs
`--allow-remote-lookups` and cannot pass unless `SONAR_TOKEN` can administer the SonarCloud
project. See [Criterion Notes](docs/criterion-notes.md#s011-sonarqube-findings).

### S013 Unit Test Coverage

S013 reads the module's overall test coverage from SonarCloud, which must be at least 80%,
and checks the test runners its build files declare (JUnit for Java, Jest for UI modules)
against the testing sections of the same policy. It never runs tests, even with
`--allow-local-commands`, and needs `--allow-remote-lookups` to read SonarCloud; without it
S013 is `manual` and lists the test runners it found. See
[Criterion Notes](docs/criterion-notes.md#s013-unit-test-coverage).

### F001 Consumed Interfaces Declared

F001 checks that every backend interface a UI package calls is declared in `package.json` under
`stripes.okapiInterfaces` or `stripes.optionalOkapiInterfaces`. It reads the request paths in the
committed production source (stripes-connect manifests, `useOkapiKy()` calls and `fetch` on the Okapi
URL, following constants inside the repository) and maps them to interfaces through the handler patterns
of the S008 platform release, kept offline in `config/f001-handler-index.json`. A request that maps to
one undeclared interface fails it, for modules and libraries alike; requests the tool cannot map leave it
`manual`, with a checklist for the reviewer and, when agent review is enabled, the agent's results. See
[Criterion Notes](docs/criterion-notes.md#f001-consumed-interfaces-declared).

### F002 End-to-End Tests

F002 checks that a UI package's end-to-end tests, if it has any, use the supported technology: Cypress
12.0 or later, which the officially supported technologies page lists as pending verification. It finds
the tools from the committed `package.json`, `yarn.lock`, configuration files, test directories and what
CI runs (GitHub workflows, including FOLIO's shared `ui.yml` test jobs, and the `Jenkinsfile`). Without
browser test tooling it is not applicable; another end-to-end framework, such as Playwright, fails it;
Karma or BigTest suites, which may be component tests, and Cypress below 12.0 are left `manual`, with a
checklist for the reviewer and, when agent review is enabled, the agent's results. See
[Criterion Notes](docs/criterion-notes.md#f002-end-to-end-tests).

### F003 Internationalization

F003 checks that a UI package renders its text through react-intl from an English translation file,
`translations/<namespace>/en.json`. It reads the committed production source (`src/`, `lib/` and
root-level files, without tests or stories) and fails without react-intl or a valid `en.json`. Message
ids missing from `en.json`, hard-coded user-visible text and invalid ICU messages make it `manual`,
with a checklist for the reviewer and, when agent review is enabled, the agent's results per item. A
package that renders no user interface, such as stripes-connect, is not applicable. See
[Criterion Notes](docs/criterion-notes.md#f003-internationalization).

### F005 Stripes Version

F005 checks that a UI module uses the Stripes version on the officially supported technologies
page. It takes S007's own finding for `@folio/stripes` from the same policy, so the two always agree,
and `--criteria F005` works on its own. A Stripes library that does not depend on `@folio/stripes`,
such as stripes-components, is left to the reviewer with a checklist item. See
[Criterion Notes](docs/criterion-notes.md#f005-stripes-version).

### B001 Module Descriptor Template

B001 checks that a backend or edge module commits a module descriptor template that matches the Okapi
ModuleDescriptor schema, with build placeholders such as `${artifactId}` replaced from `pom.xml` and
`gradle.properties`. It runs no build; S002 checks the descriptor the build generates. Shared libraries
are not applicable, and a repository that is neither a module nor a known library is left to the
reviewer. `--existing-module` marks the evaluation of an existing module rather than a new one; later
B criteria relax some new-module rules for it. See
[Criterion Notes](docs/criterion-notes.md#b001-module-descriptor-template).

### B006 API Documentation

B006 checks that every endpoint in the module descriptor (for an edge module, every router route) is
documented in an OpenAPI spec in the repository. It follows `$ref`s inside the repository, matches
methods and paths with any parameter names, and fails on an undocumented endpoint or on RAML in a new
module; with `--existing-module`, an RMB module may keep RAML. Endpoints served by a library, such as
custom fields, and specs it cannot fully read leave it to the reviewer. See
[Criterion Notes](docs/criterion-notes.md#b006-api-documentation).

### Agent Review

Some criteria can optionally add advisory OpenCode review to manual results. See [Agent Review Configuration](docs/agent-review.md) for provider setup, CLI flags, supported criteria, and GitHub Actions notes.

S010 third-party resilience uses conservative committed-source checks for Java and
Stripes/React modules. Difficult static cases remain manual and can use the optional
agent review for broader cited analysis, for example
`--criterion-agent-opencode --criterion-agent-criteria S010`. Agent advice never changes
the deterministic status. See [Criterion Notes](docs/criterion-notes.md#s010-third-party-system-resilience).

### Remote Lookups

Evaluation is offline by default. S011 (SonarQube findings) and S013 (test coverage) need to read
SonarCloud, and S014 (assigned to exactly one application on the FOLIO LSP platform) needs to read
`folio-org/platform-lsp` and FAR, so all three are `manual` unless you opt in:

```bash
folio-eval evaluate https://github.com/folio-org/mod-search --allow-remote-lookups --application app-search
```

`--application` is the application named in the evaluation's Jira task. `--platform-ref` picks the
platform-lsp branch, tag or commit (default `snapshot`). Remote reads are read-only, allowlisted and
bounded, and each one is recorded in the report. An optional `SONAR_TOKEN` is sent to SonarCloud only;
S011 reads SonarCloud's own project settings only when that token can administer the project. See
[Criterion Notes](docs/criterion-notes.md#remote-lookups).

### For Local Development: Use Devcontainer

For local development, use the provided devcontainer configuration in `.devcontainer/`. The container provides isolation with all required tools (Node.js, Java 21, Maven, Gradle).

Use any devcontainer-compatible tool (VS Code, JetBrains IDEs, GitHub Codespaces, devcontainer CLI, or Docker directly).

**Note**: Running this tool in containers as part of CI/CD pipelines is appropriate and expected, as CI systems already provide isolation.

## Usage

### Integrate with Your FOLIO Module Repository

To run evaluations from your FOLIO module repository, add this workflow file at `.github/workflows/tc-evaluation.yml`:

```yaml
name: TC Module Evaluation

on:
  workflow_dispatch:
    inputs:
      ref:
        description: 'Git ref to evaluate (defaults to current ref)'
        required: false
        type: string
      output_format:
        description: 'Report format'
        required: false
        type: choice
        options:
          - both
          - json-only
          - html-only
        default: 'both'
      criteria_filter:
        description: 'Comma-separated criterion IDs (e.g., S001,S002,B005). Leave empty for all.'
        required: false
        type: string
      java_version:
        description: 'Java version'
        required: false
        type: string
        default: '21'
      node_version:
        description: 'Node.js version'
        required: false
        type: string
        default: '20'

jobs:
  evaluate:
    permissions:
      contents: read
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
    with:
      ref: ${{ inputs.ref }}
      output_format: ${{ inputs.output_format }}
      criteria_filter: ${{ inputs.criteria_filter }}
      java_version: ${{ inputs.java_version }}
      node_version: ${{ inputs.node_version }}
```

This creates a workflow you can trigger manually from the Actions tab. Reports are uploaded as artifacts.

#### Inputs

All inputs are optional:

| Input | Description | Default |
|-------|-------------|---------|
| `ref` | Git ref to evaluate | Triggering ref (PR head or push ref) |
| `output_format` | Report format: `both`, `json-only`, or `html-only` | `both` |
| `criteria_filter` | Comma-separated criterion IDs to evaluate (e.g., `S001,S002,B005`) | All criteria |
| `java_version` | Java version for Maven/Gradle builds | `21` |
| `node_version` | Node.js version for npm builds | `20` |
| `evaluator_ref` | tc-module-eval branch/tag to use | `master` |
| `allow_remote_lookups` | Allow read-only lookups of SonarCloud, platform-lsp and FAR, needed for S011, S013 and S014 (the job's read-only `GITHUB_TOKEN` is then sent to api.github.com only) | `false` |
| `application` | Application named in the evaluation's Jira task, e.g. `app-search` (S014) | none |
| `platform_ref` | platform-lsp branch, tag or commit S014 reads | `snapshot` |
| `existing_module` | Evaluate an existing module rather than a new one (passes `--existing-module`) | `false` |

#### Outputs

The workflow provides these outputs for use in downstream jobs:

| Output | Description |
|--------|-------------|
| `report_artifact` | Name of the uploaded artifact containing reports |
| `passed` | Number of passed criteria |
| `failed` | Number of failed criteria |
| `manual` | Number of criteria requiring manual review |

**Note:** The `passed`, `failed`, and `manual` outputs are parsed from the JSON report. If `output_format` is `html-only`, these values will be 0.

#### Examples

**Evaluate Specific Criteria:**

```yaml
jobs:
  evaluate:
    permissions:
      contents: read
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
    with:
      criteria_filter: 'S001,S002,S003,B005'
```

**Use Evaluation Results in Downstream Job:**

```yaml
jobs:
  evaluate:
    permissions:
      contents: read
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master

  report:
    permissions: {}
    needs: evaluate
    runs-on: ubuntu-latest
    steps:
      - name: Check results
        env:
          PASSED: ${{ needs.evaluate.outputs.passed }}
          FAILED: ${{ needs.evaluate.outputs.failed }}
          MANUAL: ${{ needs.evaluate.outputs.manual }}
        run: |
          echo "Passed: $PASSED"
          echo "Failed: $FAILED"
          echo "Manual: $MANUAL"

      - name: Fail if any criteria failed
        if: needs.evaluate.outputs.failed != '0'
        run: exit 1
```

#### Versioning

- Use `@master` for the latest version
- Use a specific commit SHA for pinned versions (e.g., `@abc1234`)

### Web Interface (GitHub Actions)

To evaluate any repository without adding a workflow to it:

1. In this tc-module-eval project, go to [Actions > Evaluate Remote Repository](https://github.com/folio-org/tc-module-eval/actions/workflows/evaluate-remote.yml).

1. Click Run Workflow, enter the GitHub URL of the module to evaluate, and click Run Workflow. To check S011, S013 and S014, also tick remote lookups, and for S014 enter the application named in the evaluation's Jira task.

1. Wait for the workflow to complete, then download the reports from Artifacts.

### Command Line Interface

```bash
# Evaluate a repository
folio-eval evaluate https://github.com/folio-org/mod-search

# Evaluate specific criteria only
folio-eval evaluate <repo-url> --criteria S001,S002,B005

# Custom output directory or format
folio-eval evaluate <repo-url> --output ./my-reports --json-only

# List supported languages
folio-eval list-languages
```

### Refresh the S008 Interface Catalog

Maintainers can acquire a review bundle for an exact Platform LSP baseline with:

```bash
yarn acquire:s008-catalog --platform-commit <40-character-commit> --channel official --output-dir /tmp/s008-acquisition
```

This networked command requires an immutable Platform LSP commit and a new output
directory. It produces a deterministic, non-authoritative catalog plus snapshots,
provenance, discovery suggestions, and acquisition diagnostics for review. It never
modifies the checked-in S008 catalog or acceptance ledger; maintainers must review and
promote the generated data through the normal repository and TC review processes.
See [S008 Interface Acceptance](docs/s008-interface-acceptance.md) for artifact details,
development-channel usage, and the review procedure.

For all CLI options and advanced usage, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

For local development, setup instructions, architecture details, and contribution guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 License
