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

S007 reads static, repository-local Maven, Gradle, and package metadata. A top-level Yarn Classic lockfile may supply exact JavaScript versions. In trusted evaluations using `--allow-local-commands`, the pinned Maven Help Plugin `effective-pom` goal may process remote parents and BOMs to enrich otherwise unresolved dependency versions. This does not request a build lifecycle, but Maven model construction can read project Maven configuration, load project extensions, access the network allowed by the execution environment, and potentially modify repository files; the command runner records the requested host policy but does not enforce a network sandbox. It therefore remains opt-in for trusted repositories. Versions from a successfully validated effective POM participate in normative comparisons; other remote-derived evidence remains diagnostic and cannot determine Pass or Fail. Unsupported, dynamic, remote, conflicting, or incomplete evidence prevents a pass.

- `pass`: every relevant technology has a definitive rule, all available version checks comply, and evidence is complete. Rules without version constraints require no comparison.
- `fail`: conclusive version evidence violates an explicit normative rule. A failure takes precedence over concurrent manual findings.
- `manual`: the evidence or policy requires judgment, including unlisted frameworks and advisory, provisional, or contested rules.

Recommendations and deprecation notes remain visible but cannot cause failure on their own.

S012 build tools, S013 testing, infrastructure compatibility, live policy synchronization, and new-module applicability remain outside S007.

## S010 Third-Party System Resilience

S010 applies to deployable Java and Stripes/React modules and covers every runtime
dependency outside the evaluated module, including other FOLIO modules, databases,
brokers, object storage, search, and external services. Explicit FOLIO library
repositories are `not_applicable`. General Node.js and mixed or unresolved runtimes
remain `manual` in the initial implementation. S008 interface and S009 library
acceptance decisions are independent of S010 resilience behavior.

The deterministic evaluator reads bounded immutable `HEAD` blobs only. It never runs
target builds, tests, package installs, scripts, services, databases, or network
clients, and it ignores uncommitted or earlier generated artifacts. Narrow Java and
Stripes/React recognizers link dependency declarations or calls to their failure path,
failure bound, fallback, startup coupling, and readiness outcome. Unsupported wrappers,
generated clients, dynamic configuration, incomplete discovery, or ambiguous linkage
remain `manual`; missing visible handling alone never proves failure.

- `pass`: every identified scenario has satisfactory linked evidence, or complete
  semantic coverage proves there are no external runtime dependencies. Missing required
  configuration may pass through clear startup fail-fast when no sensible default exists.
  A required dependency may also pass when startup failure is clear and bounded, or when
  runtime loss is bounded and controlled; a required dependency may make the module
  unready after startup.
- `fail`: positive linked evidence proves an optional dependency has an uncontrolled
  outcome or makes the module unready, or required configuration explicitly continues
  into deferred/uncontrolled failure. An explicitly uncontrolled required dependency
  outage also fails.
- `manual`: applicability, discovery, dependency ownership, bounds, fallback, startup,
  readiness, or another material semantic fact remains unresolved.
- `not_applicable`: the repository is explicitly identified as a FOLIO library.

Optional dependencies may use feature isolation or controlled module-wide degradation,
but loss must remain bounded and must not make the module unready. Tests strengthen
evidence but are not mandatory. For deterministic manual results, optional S010 agent
review receives a broader bounded redacted committed-source snapshot. Its cited advice
helps human review but never changes criterion status.

For Java databases, the evaluator groups JDBC, JPA, R2DBC, datasource, Liquibase, and
Flyway usage into dependency-level evidence rather than one diagnostic per source file.
It recognizes unconditional Spring startup lifecycle ownership and local exception
propagation. A finite database bound is proven only when committed configuration shows
both a positive connection bound and a positive operation bound; framework defaults,
transactions, and batch-to-row retries are not treated as resilience proof. Conditional
or incompletely linked database behavior remains `manual` for agent and human review.

## Advisory Agent Review

Optional OpenCode review can inform manual results but cannot change criterion status. See [Agent Review Configuration](agent-review.md) for setup and supported criteria.
