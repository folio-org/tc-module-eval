# FOLIO Module Evaluator

A CLI for evaluating FOLIO modules against technical council criteria.

Copyright (C) 2025-2027 The Open Library Foundation

This software is distributed under the terms of the Apache License,
Version 2.0. See the file "[LICENSE](LICENSE)" for more information.

## Overview

This tool provides a modular, extensible framework for automatically evaluating a module against
[FOLIO module acceptance criteria](https://github.com/folio-org/tech-council/blob/master/MODULE_ACCEPTANCE_CRITERIA.MD).

See [Criterion Notes](docs/criterion-notes.md) for criterion-specific behavior, runtime requirements, and review boundaries.

**Note**: Dependency analysis includes all transitive dependencies for Maven, Gradle, and npm projects.  Go modules are not supported yet.

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

The policy also retains build-tool, testing, and infrastructure sections for future
criteria. S007 consumes only applicable language and framework entries. See
[Criterion Notes](docs/criterion-notes.md) for reviewer guidance.

### Agent Review

Some criteria can optionally add advisory OpenCode review to manual results. See [Agent Review Configuration](docs/agent-review.md) for provider setup, CLI flags, supported criteria, and GitHub Actions notes.

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

1. Click Run Workflow, enter the GitHub URL of the module to evaluate, and click Run Workflow.

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

For all CLI options and advanced usage, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

For local development, setup instructions, architecture details, and contribution guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 License
