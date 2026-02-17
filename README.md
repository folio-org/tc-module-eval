# FOLIO Module Evaluator

A CLI for evaluating FOLIO modules against technical council criteria.

Copyright (C) 2025-2026 The Open Library Foundation

This software is distributed under the terms of the Apache License,
Version 2.0. See the file "[LICENSE](LICENSE)" for more information.

## Overview

This tool provides a modular, extensible framework for automatically evaluating a module against
[FOLIO module acceptance criteria](https://github.com/folio-org/tech-council/blob/master/MODULE_ACCEPTANCE_CRITERIA.MD).

**Note**: Dependency analysis includes all transitive dependencies for Maven, Gradle, and npm projects.  Go modules are not supported yet.

## Security

**⚠️ WARNING**: This tool executes build commands (Maven, Gradle, npm) on cloned repositories.

- **Local CLI usage**: Malicious build files (`pom.xml`, `build.gradle`, `package.json`) can execute arbitrary code with your local user permissions.
- **GitHub Actions usage**: Malicious build files execute in the runner environment with `GITHUB_TOKEN` permissions. Use least-privilege [job level](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions) and/or [workflow level](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions) `permissions` to reduce risk.

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
        default: '18'

permissions:
  contents: read

jobs:
  evaluate:
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
| `java_version` | Java version for Maven/Gradle builds | `17` |
| `node_version` | Node.js version for npm builds | `18` |
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
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
    with:
      criteria_filter: 'S001,S002,S003,B005'
```

**Use Evaluation Results in Downstream Job:**

```yaml
jobs:
  evaluate:
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master

  report:
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
