# Security

**⚠️ WARNING**: This tool executes build commands (Maven, Gradle, npm). Some criteria may also run descriptor-producing build commands when generated artifacts are required.

- **Local CLI usage**: Malicious build files (`pom.xml`, `build.gradle`, `package.json`) can execute arbitrary code with your local user permissions.
- **GitHub Actions usage**: Malicious build files execute in the runner environment with `GITHUB_TOKEN` permissions. Use least-privilege [job level](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions) and/or [workflow level](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions) `permissions` to reduce risk.

By default, local CLI runs block build-tool commands. Their isolation and network policies only gate them behind `--allow-local-commands`; once allowed, they run on the host with the current user's permissions and network access, not in a sandbox. To run those commands in a trusted local environment, opt in explicitly:

```bash
folio-eval evaluate <repo-url> --allow-local-commands
```

Dependency installs (S003, and S002 before a Stripes descriptor script) pass `--ignore-scripts`, so dependencies' install scripts never run; the repository's own descriptor script still does.

When this flag is used, reports record where commands ran: `github-actions` in GitHub Actions and `local` elsewhere.

Source-inspection review is read-only: it does not mutate evaluated repositories and does not execute repository code, tests, builds, services, databases, or Okapi calls.

`--allow-runtime-checks`, which needs `--allow-local-commands`, goes further: the [backend runtime harness](usage.md#backend-runtime-harness) builds the module and runs it in Docker. Access to the Docker daemon is root-equivalent on the evaluating host, and the harness runs repository code, so use it only for trusted repositories on a disposable host, such as an orb or a CI runner. A dedicated rootless Docker context is recommended but not required.

Evaluated repositories are open source, so reports show repository text, command output, and agent advice as written. Only the evaluator's own credentials are masked: the values of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `SONAR_TOKEN`, `GITHUB_TOKEN`, `FOLIO_UI_USERNAME`, `FOLIO_UI_PASSWORD`, and any variable passed to OpenCode with `--criterion-agent-provider-env` or `--criterion-agent-proxy-env` become `[REDACTED_<VARIABLE>]` in all output, and the keys in an OpenCode auth store become `[REDACTED_AUTH_STORE]`. See [Output masking](agent-review.md#output-masking).

## Isolation

For local development, use the provided devcontainer configuration in `.devcontainer/`. The container provides isolation with all required tools (Node.js, Java 21, Maven, Gradle).

Use any devcontainer-compatible tool (VS Code, JetBrains IDEs, GitHub Codespaces, devcontainer CLI, or Docker directly).

**Note**: Running this tool in containers as part of CI/CD pipelines is appropriate and expected, as CI systems already provide isolation.
