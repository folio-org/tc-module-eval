# Contributing to FOLIO Module Evaluator

For basic usage, see [README.md](README.md).

## Prerequisites

- Node.js 18.x or later
- Yarn 1.22.x or later
- Maven 3.x (for evaluating Java modules)

## Setup

### Recommended: Use Devcontainer

For local development, use the provided devcontainer configuration in `.devcontainer/`. The container provides isolation with all required tools (Node.js, Java 21, Maven, Gradle).

Supports: VS Code, JetBrains IDEs, GitHub Codespaces, devcontainer CLI, or Docker directly.

### Manual Installation (Advanced)

**Note**: Only install locally if you understand the security risks. The tool executes build commands on cloned repositories.

```bash
# Clone and install
git clone <repository-url>
cd module_eval
yarn install

# Build
yarn build

# Install globally (optional)
yarn global add .
```

## Architecture

The evaluation process:
1. Clones target repository
2. Detects language evaluator
3. Loads criteria definitions
4. Runs evaluation with optional filtering
5. Generates HTML + JSON reports
6. Cleans up (unless `--no-cleanup`)

## Criteria Definitions

Defined in `src/criteria-definitions.ts` with structure:
- **ID/Code**: Unique identifier
- **Description**: Requirement description
- **Section**: Administrative, Shared, Backend, or Frontend
- **Category**: Subcategory

**ID Format:**
- `A###` - Administrative (e.g., A001 - License)
- `S###` - Shared/Common (S001-S014)
- `B###` - Backend Java (B001-B016)
- `F###` - Frontend UI (F001-F007)

Filter with: `--criteria S001,S002,B005`

## Report Output

**HTML**: Visual dashboard with color-coded results, statistics, and criterion breakdown

**JSON**: Machine-readable format with complete evaluation data

## Configuration

License policy files in `config/`:
- `license-categories.json` - Category mappings (A/B/X)
- `license-variations.json` - Name normalizations
- `special-exceptions.json` - Special case handling

Follows Apache Software Foundation license policy.

## CLI Options

```bash
# Evaluation
folio-eval evaluate <repo-url>
folio-eval evaluate <repo-url> --criteria S001,S002,B005
folio-eval evaluate <repo-url> --output ./my-reports
folio-eval evaluate <repo-url> --json-only
folio-eval evaluate <repo-url> --no-cleanup

# Other
folio-eval list-languages
folio-eval info
```
