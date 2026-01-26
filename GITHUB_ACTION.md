# Integrating TC Module Evaluation with Your Repository

This guide explains how to set up TC module evaluations in your FOLIO module repository using the reusable workflow from tc-module-eval.

## Quick Start

Add this workflow file to your repository at `.github/workflows/tc-evaluation.yml`:

```yaml
name: TC Module Evaluation

on:
  workflow_dispatch:

jobs:
  evaluate:
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
```

This creates a workflow you can trigger manually from the Actions tab. Reports are uploaded as artifacts.

## Inputs

All inputs are optional:

| Input | Description | Default |
|-------|-------------|---------|
| `branch` | Branch to evaluate | Triggering ref (PR head or push branch) |
| `output_format` | Report format: `both`, `json-only`, or `html-only` | `both` |
| `criteria_filter` | Comma-separated criterion IDs to evaluate (e.g., `S001,S002,B005`) | All criteria |
| `java_version` | Java version for Maven/Gradle builds | `17` |
| `node_version` | Node.js version for npm builds | `18` |
| `evaluator_ref` | tc-module-eval branch/tag to use | `master` |

## Outputs

The workflow provides these outputs for use in downstream jobs:

| Output | Description |
|--------|-------------|
| `report_artifact` | Name of the uploaded artifact containing reports |
| `passed` | Number of passed criteria |
| `failed` | Number of failed criteria |
| `manual` | Number of criteria requiring manual review |

## Examples

### Automatic Triggers

Run evaluations on pushes and pull requests:

```yaml
name: TC Module Evaluation

on:
  push:
    branches: [master, main]
  pull_request:
  workflow_dispatch:

jobs:
  evaluate:
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
```

### Custom Java Version

```yaml
name: TC Module Evaluation

on:
  push:
    branches: [master, main]
  pull_request:

jobs:
  evaluate:
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
    with:
      java_version: '21'
```

### Evaluate Specific Criteria

```yaml
name: TC Module Evaluation

on:
  pull_request:

jobs:
  evaluate:
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
    with:
      criteria_filter: 'S001,S002,S003,B005'
```

### Use Evaluation Results in Downstream Job

```yaml
name: TC Module Evaluation

on:
  pull_request:

jobs:
  evaluate:
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master

  report:
    needs: evaluate
    runs-on: ubuntu-latest
    steps:
      - name: Check results
        run: |
          echo "Passed: ${{ needs.evaluate.outputs.passed }}"
          echo "Failed: ${{ needs.evaluate.outputs.failed }}"
          echo "Manual: ${{ needs.evaluate.outputs.manual }}"

      - name: Fail if any criteria failed
        if: needs.evaluate.outputs.failed != '0'
        run: exit 1
```

### JSON-Only Output

```yaml
name: TC Module Evaluation

on:
  workflow_dispatch:

jobs:
  evaluate:
    uses: folio-org/tc-module-eval/.github/workflows/evaluate.yml@master
    with:
      output_format: 'json-only'
```

## Versioning

- Use `@master` for the latest version
- Use a specific commit SHA for pinned versions (e.g., `@abc1234`)

## Viewing Results

1. After the workflow completes, go to the workflow run in the Actions tab
2. The job summary shows a table with pass/fail/manual counts
3. Download the artifact (named `<repo-name>-evaluation-reports`) for detailed HTML and JSON reports
