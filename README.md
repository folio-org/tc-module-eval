# FOLIO Module Evaluator

A CLI for evaluating FOLIO modules against technical council criteria.

## Overview

This tool provides a modular, extensible framework for automatically evaluating FOLIO modules against acceptance criteria. It currently supports Java modules with a pluggable architecture for adding support for additional programming languages.

## Installation

```bash
# Install dependencies
yarn install

# Build the project
yarn build

# Install globally (optional)
yarn global add .
```

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

# Show framework information
folio-eval info
```

## Architecture

### Evaluation Process

1. Clone the target repository
2. Detect appropriate language evaluator
3. Load criteria definitions for the detected language
4. Run evaluation against criteria (with optional filtering)
5. Generate reports (HTML + JSON)
6. Clean up temporary files (unless --no-cleanup is specified)

## Criteria Definitions

Criteria are defined in TypeScript in `src/criteria-definitions.ts` with explicit identifiers and metadata:

### Criterion Structure

Each criterion includes:
- **ID**: Unique identifier (e.g., `A001`, `S001`, `B001`, `F001`)
- **Code**: Same as ID for consistency
- **Description**: Human-readable description of the requirement
- **Section**: Category (Administrative, Shared, Backend, Frontend)
- **Category**: Subcategory for organization

### Criterion ID Format

- `A###`: Administrative criteria (e.g., A001 - License compliance)
- `S###`: Shared/Common criteria applicable to all modules (e.g., S001-S014)
- `B###`: Backend-specific criteria for Java modules (e.g., B001-B016)
- `F###`: Frontend-specific criteria for UI modules (e.g., F001-F007)

Use the `--criteria` option to filter which criteria are evaluated (e.g., `--criteria S001,S002,B005`)

## Report Output

### HTML Report
- Visual dashboard with color-coded results
- Statistics summary (pass/fail/manual counts)
- Detailed criterion-by-criterion breakdown
- Responsive design for various screen sizes

### JSON Report
- Machine-readable format for integration
- Complete evaluation data including evidence
- Suitable for further processing or analysis

## Development

### Prerequisites

- Node.js 18.x or later
- Yarn 1.22.x or later
- Maven 3.x or later (required for evaluating Java modules)

### Local Development Setup

```bash
# Clone and install dependencies
git clone <repository-url>
cd module_eval
yarn install
```

### Development Workflow

```bash
# Development mode (TypeScript, no build required)
yarn dev evaluate <repo-url>
yarn dev info

# Production mode (requires build)
yarn build
yarn start evaluate <repo-url>

# Testing
yarn test
yarn test --watch

# Clean and rebuild
yarn clean && yarn build
```

## Configuration

### License Policy Configuration

The framework includes configuration files that can be updated manually:

- `config/license-categories.json` - License category mappings (A=Compatible, B=Conditional, X=Prohibited)
- `config/license-variations.json` - License name variations and normalizations
- `config/special-exceptions.json` - Special case handling for specific dependencies

These files follow the Apache Software Foundation license categorization policy.

## License

Apache-2.0 License
