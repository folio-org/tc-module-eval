# FOLIO Module Evaluator

A CLI for evaluating FOLIO modules against technical council criteria.

## Overview

This tool provides a modular, extensible framework for automatically evaluating FOLIO modules against acceptance criteria. It currently supports Java modules with a pluggable architecture for adding support for additional programming languages.

**Note**: Dependency analysis includes all transitive dependencies for Maven and npm projects.

## Security

**⚠️ WARNING**: This tool executes build commands (Maven, Gradle, npm) on cloned repositories. Malicious build files (pom.xml, build.gradle, package.json) can execute arbitrary code with your user's permissions.

### For Local Development: Use Devcontainer

For local development, use the provided devcontainer configuration in `.devcontainer/`. The container provides isolation with all required tools (Node.js, Java 21, Maven, Gradle).

Use any devcontainer-compatible tool (VS Code, JetBrains IDEs, GitHub Codespaces, devcontainer CLI, or Docker directly).

**Note**: Running this tool in containers as part of CI/CD pipelines is appropriate and expected, as CI systems already provide isolation.

## Usage

### Web Interface (GitHub Actions)

1. In this tc-module-eval project, click Actions and then (in the left sidebar) FOLIO Module Evaluation.  Or [load that page directly](https://github.com/folio-org/tc-module-eval/actions/workflows/module-evaluation.yml).

1. Click Run Workflow.  In the popup,

    - Enter the GitHub URL of the module to evaluate.

    - Click Run Workflow.

1. Wait for the workflow run to complete, 1-2 minutes, then click into it.

1. Under Artifacts, click to download the reports (as a zip file) for review.


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
