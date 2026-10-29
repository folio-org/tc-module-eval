# Criterion Notes

This file records criterion behavior not covered in the README.

## Rules for Every Criterion

- Missing, truncated, unreadable or unverifiable evidence gives `manual` with a diagnostic, never `pass` and never an empty result. Every collector limit (depth, file count, rejected value) adds a diagnostic. A proven violation still fails.
- Evaluated repositories are untrusted. Every repository or remote string in a report goes through `reportText` or `reportPath`. Reads, file counts and loops over repository-controlled lists are bounded, and symlinks outside the repository are never followed. Every regex or scan over repository or agent text has a linear-time test. Lookups keyed by repository data use `Map` or `Object.create(null)`.
- Reports are written for TC members in plain English with a "What to do" line. They show no internal enum values and no model or adapter names, and agent review has the same layout for every criterion.
- Agent review never changes a status. An invalid review item is dropped on its own instead of rejecting the whole review, structured JSON is never truncated, and a review that did not run is not shown as unavailable.
- FOLIO shared workflows are modelled from their upstream YAML. A workflow or ref missing from `config/folio-shared-workflows.json` is unknown, not empty.

## S001 Open-Source License

S001 reads up to 20 top-level license files: `LICENSE`, `LICENCE` and `COPYING` in any case, with an optional single suffix and extension such as `.md`, `-MIT` or `-2.0.txt` (multi-word names such as `LICENSE-THIRD-PARTY.txt` are notices, not the module's license). Only the first 64 KB of each is read. A file counts as the Apache License 2.0 only when a line among its first ten non-empty lines names it as the file's own license (the title and version, a "licensed/distributed under the Apache License, Version 2.0" notice, or an `Apache-2.0` SPDX id) before any line naming another license. Third-party notices appended after the Apache text do not matter; an MIT or other license file that merely mentions Apache-2.0 code does not pass.

- `pass`: every license file is Apache 2.0. Without a license file, pass when `pom.xml` or the `package.json` `license` field declares only Apache 2.0 (`package.json` must use the exact SPDX id `Apache-2.0`).
- `fail`: the license files are not Apache 2.0; or there is no license file and the declared licenses are not Apache 2.0, or nothing declares a license.
- `manual`: license files disagree; a license file links outside the repository, or more than 20 license files exist; declarations list Apache 2.0 with another license (including SPDX `OR` expressions); there is no license file and `pom.xml` declares no license but has a `<parent>` that may supply one; or the check cannot read the repository.

When a license file exists, `pom.xml` and `package.json` declarations are not consulted. Parent POMs are never resolved. Files that link outside the repository (or to nothing) are never read; such a license file makes the result `manual`, and such a `pom.xml` or `package.json` is ignored, as is one larger than 1 MB.

## S002 Descriptor Generation

S002 checks the final `ModuleDescriptor.json` against the Okapi schema. It picks the descriptor source in this order:

1. A Maven project (`pom.xml`): run `mvn process-resources -DskipTests` and use the `ModuleDescriptor.json` generated under a `target/` directory. When several are generated, use the one whose `id` is the module name or `<module name>-<version>`, where the module name is the `package.json` name without `@folio/`, or else the `pom.xml` `artifactId`. If not exactly one matches, S002 needs manual review.
2. A Gradle project (`build.gradle` or `build.gradle.kts` at the repository root or in `service/`): run the wrapper's `processResources` and use the `ModuleDescriptor.json` generated under that project's `build/resources/main/`. See [Gradle Modules](#gradle-modules).
3. A `package.json` script named `build-mod-descriptor`, `build-module-descriptor`, or `generate-module-descriptor`: run it with `yarn run` and use the `ModuleDescriptor.json` it writes at the repository root.
4. Otherwise, a committed `ModuleDescriptor.json` at the repository root.

When a repository has a Maven or Gradle project or a descriptor script, the build always runs, even if a `ModuleDescriptor.json` is also committed; the committed file is not used as a fallback. If the build is blocked because local commands are off, or the build fails, S002 needs manual review. Enable local commands only for trusted repositories and runners.

Files whose repository path contains `template` are never used as the final descriptor. A repository with no descriptor source but with a descriptor template (a `*ModuleDescriptor*.json` file under a path containing `template`, such as `descriptors/ModuleDescriptor-template.json`) fails with a message naming the templates.

## Gradle Modules

A Gradle build is found at the repository root or in `service/`, where FOLIO's Grails modules (mod-agreements, mod-licenses, mod-serials-management) keep it. With local commands, S002 runs the Gradle wrapper's `processResources` to generate the descriptor from its template, and S003 lists dependencies with the [jk1 license report plugin](https://github.com/jk1/Gradle-License-Report), which the evaluator applies through an init script because FOLIO projects do not apply it. The wrapper runs on the `java` found on `PATH`; Gradle 7.x, used by these modules, does not run on Java 21, so put a Java 17 JDK first on `PATH` for them.

## Source Inspection Boundaries

Source inspection never modifies evaluated repositories or runs their code, tests, builds, services, databases, or Okapi calls.

## S003 Third-Party Licenses

S003 checks the dependencies the module distributes against the [ASF 3rd Party License Policy](https://www.apache.org/legal/resolved.html). It lists them with the build tool, so it needs local commands; in safe mode it reports that the licenses were not checked.

- Only distributed dependencies are checked, including their transitive dependencies. Maven excludes `test` (and `system`) scope. Gradle uses only the license report's `runtimeClasspath`. npm installs and checks production dependencies only. UI modules are published as source and bundled by a platform that installs only their `dependencies`, so `devDependencies` are never shipped.
- A Category X license fails. A Category B license, or an LGPL library on the special-exception list, needs a README label: the README must name the dependency itself (its full name or artifactId, as a whole name: `rhino.engine` does not name `rhino`), not just the license family. Only the first 1 MiB of a README inside the repository is read; a README or `pom.xml` that links outside the repository is ignored. An unnamed one, an unknown license, a missing license, or an unsplit license expression requires manual review.
- An SPDX `AND` expression passes only when every operand passes. Licenses listed together for a Maven or Gradle dependency all apply, unless `config/license-dual-licensed.json` records the dependency as offering a choice of license.

## S004 Installation Documentation

S004 reads the README, conventional install files, Markdown in `docs/`, `doc/`, and `deployment/`, and linked local docs. It fails only when they contain no build, run, configuration, or setup evidence, not even a link to other documentation; everything else needs manual review. The top tier ("concrete steps to install, deploy, or run") needs a recognized install, deploy, or run command. Okapi or tenant steps add context but never reach that tier alone, because S004 asks for developer build and run instructions.

Okapi/tenant evidence must be a step: an Okapi admin endpoint (`/_/proxy`, `/_/discovery`, `/_/tenant`), `--okapi` or `--tenant` flags, posting or deploying to Okapi, or enabling the module for a tenant. Mentions of Okapi or tenants in prose, API examples (including curl calls with an `X-Okapi-Tenant` header), and configuration tables do not count. Neither an Okapi or tenant admin step (unless it also runs a build or run tool, such as `yarn start --okapi …`) nor a developer build such as `mvn clean install` counts as the install or run example, even under an "Installation" heading. The report shows at most one example per paragraph, with code fences and table pipes removed.

## S005 Personal Data Disclosure Review

S005 checks `PERSONAL_DATA_DISCLOSURE.md` mechanics and completion, plus bounded source-inspection evidence. Completed forms still require manual review; S005 does not certify legal or privacy compliance.

## S006 Sensitive Information Review

S006 runs Gitleaks on the working tree and bounded checks for credential URLs, secret assignments, FOLIO or environment endpoints, and local paths. A value that looks like a real secret in production code or CI/deployment files fails; documentation, tests, examples, local Docker defaults, helper scripts, host names, private addresses, and incomplete scans require manual review. Helper scripts are files in `scripts/` folders and shell scripts, except those under `src/`, container entrypoints, Jenkinsfiles and GitLab CI files, and scripts in CI pipeline folders (including `.buildkite/`).

The built-in scan reads up to 2,000 files and 8 MB in total (96 KB per file), which covers every candidate file in large FOLIO modules such as mod-inventory-storage and ui-users. In folders where secrets are often kept (CI, deployment, configuration, and `src/main/resources`), it also reads files without an extension, such as `CODEOWNERS`; binary ones are skipped after a 1 KB probe, which counts toward the 8 MB. Data tables, stylesheets, sample payloads, and disabled files there (`.csv`, `.xsl`, `.sample`, `*.disabled`) are not read and are listed under "Skipped" without creating a coverage gap. It reads only regular files inside the repository: it never follows symbolic links, and on Linux it skips a file whose open handle resolves outside the repository, such as when a folder is swapped for a link during the scan.

The report lists each finding by file, line, kind (`[secret]`, `[token]`, `[api-key]`, `[private-key]`, `[login-url]`, `[private-url]`, `[host]`, `[local-path]`, `[env-file]`), and where it was found. It hides matched values; for an assignment it names only the variable, such as "assigned to DB_PASSWORD". Agent review receives the matched values, and its prose is reported as written: it is told not to repeat them, but nothing masks a value it quotes. "Coverage gaps" lists what was not fully scanned and keeps the result in manual review; "Skipped" lists folders and files that do not affect the result, such as `.git` and `node_modules`.

Gitleaks runs with its default rules and `--ignore-gitleaks-allow`, so a `.gitleaks.toml` or `gitleaks:allow` comment in the evaluated repository cannot hide findings. Gitleaks still reads a `.gitleaksignore` file at the repository root; the report notes such a file without changing the status. Gitleaks `generic-api-key` findings whose value is a plain UUID are record IDs and are dropped. When Gitleaks and the built-in scan report exactly the same value on the same line, the report shows one finding found by both, unless only the built-in finding fails S006. A value marked as made up, including inside a camelCase or snake_case word such as `dummyToken`, counts as a test or example value and cannot fail S006. The built-in secret-assignment check skips:

- values shorter than 8 characters, such as `LETTER_TOKEN_PREFIX = "1"`; the same applies to Gitleaks' generic secret rule, but not to its specific secret types such as AWS keys, or to private keys. Password keys (`password`, `passwd`, `pwd`, `userpassword`, `DB_PASSWORD`, …) in production, CI/deployment, and Docker configuration are reported at any length by the built-in scan, so a default such as `admin` still needs review;
- comparisons (`==`, `===`) and arrow functions (`=>`);
- unquoted values in program source (Java, Kotlin, Groovy, Gradle, JavaScript, TypeScript, Python, Ruby, and Jenkinsfiles), which are code rather than committed values, unless they sit inside a string literal (including a multiline one) such as a JDBC URL;
- an unquoted `${VAR}` reference followed by a command in a shell script or Dockerfile, as in `PGPASSWORD=${DB_PASSWORD} psql …`;
- `%s`, `%d`, `{}`, and `{NAME}` placeholders (such as `{VAULT_TOKEN}`), `$NAME` references, and empty lists (`accessToken: []`);
- header names: a standard or Okapi header name such as `X-Okapi-Token` or `Authorization`, or any header name held by a constant named as a header (ending in `HEADER` or `HEADER_NAME`), such as `OKAPI_TOKEN_HEADER = 'X-Okapi-Tenant-Id'`.

Java `import` and `import static` lines, identifiers such as `Constants.LOCAL_ERROR`, and public FOLIO hosts (`folio.org` and its subdomains, such as `okapi.ci.folio.org`) are never reported as host names. Localhost URLs in helper scripts are not reported.

The devcontainer and GitHub Actions install Gitleaks. Elsewhere, install `gitleaks` on `PATH` or set `GITLEAKS_PATH`. An unavailable or failed scanner produces a material warning and manual status.

## S007 Officially Supported Technologies

S007 evaluates the current committed `config/officially-supported-technologies.json`. It has no policy selector or Confluence lookup. Maintainers update this file in place; optional source metadata is for reviewer context only.

S007 reads static, repository-local Maven, Gradle, and package metadata. A top-level Yarn Classic lockfile may supply exact JavaScript versions. In trusted evaluations using `--allow-local-commands`, the pinned Maven Help Plugin `effective-pom` goal may process remote parents and BOMs to enrich otherwise unresolved dependency versions. This does not request a build lifecycle, but Maven model construction can read project Maven configuration, load project extensions, access the network allowed by the execution environment, and potentially modify repository files; the command runner records the requested host policy but does not enforce a network sandbox. It therefore remains opt-in for trusted repositories. Versions from a successfully validated effective POM participate in normative comparisons; other remote-derived evidence remains diagnostic and cannot determine Pass or Fail. Unsupported, dynamic, remote, conflicting, or incomplete evidence prevents a pass.

- `pass`: every relevant technology has a definitive rule, all available version checks comply, and evidence is complete. Rules without version constraints require no comparison.
- `fail`: conclusive version evidence violates an explicit normative rule. A failure takes precedence over concurrent manual findings.
- `manual`: the evidence or policy requires judgment, including unlisted frameworks and advisory, provisional, or contested rules.

Recommendations and deprecation notes remain visible but cannot cause failure on their own.

Some artifacts show that a framework is used but have their own version line, so S007 does not compare their version with the framework rule: Grails plugins and other `org.grails` artifacts outside the Grails core project (GORM's `grails-datastore-*`, the `*-testing-support` libraries), and Spring projects in `org.springframework.*` groups other than Spring Boot (Spring Kafka, Spring Batch, Spring Data, Spring Cloud). If no other declaration gives the framework version, the version counts as missing. Grails 7 publishes under `org.apache.grails`, with one version for all its artifacts.

An imported BOM only supplies versions for dependencies declared without one, and versions set in the repository take precedence. So once every production Maven dependency has a version, from the repository or (with `--allow-local-commands`) from the effective POMs, imported BOMs no longer block a pass.

Without a `yarn.lock`, each declared `package.json` range is checked as a whole, with npm's version semantics (a prerelease matches only a range that names one): it passes when every version it allows meets the policy (`^18.2.0` allows only 18.x), needs review when it also allows unsupported versions (`>=18` allows any later major), and fails when it allows none.

Only production dependencies decide the status. Maven `test` scope dependencies and Gradle `test*`, `testFixtures*`, and `integrationTest*` configurations are listed as notes, are not compared with each other for conflicts, and leave no coverage gap.

RMB (raml-module-builder) is recognized from its `org.folio:domain-models-*` artifacts, which carry the RMB version, as well as `org.folio:raml-module-builder`. A failing version newer than the rule allows gets different advice from an older one: use an allowed version or ask the Technical Council to update the policy.

Groovy is detected from the Gradle `groovy` and Grails plugins and the Maven GMavenPlus plugin. Grails modules usually declare no Java version and take versions from the Grails BOM; both remain coverage gaps.

In safe mode, a dependency with no version anywhere in the repository takes the version of a `<artifactId>.version` property set in the repository (for example `lombok.version`), following the Spring Boot convention for overriding the versions it manages. This applies only when that management is probably inherited from a parent POM: the parent outside the repository is a Spring Boot parent, or the module uses Spring Boot, has a parent outside the repository, and imports no BOM. A property does not change the versions of an imported BOM. The report labels such a version as inferred from the property. With `--allow-local-commands` the effective-POM version replaces it.

The report lists each problem once under "Repository evidence coverage"; problems of the same kind in one file, such as dependencies without a version, are merged into one row.

S012 build tools, S013 testing, infrastructure compatibility, live policy synchronization, and new-module applicability remain outside S007.

## S008 Interface Acceptance

S008 checks every interface the module requires or optionally uses against the checked-in catalog of interfaces that accepted modules provide in a platform release (see [S008 interface acceptance](s008-interface-acceptance.md)). A backend module's interfaces come from the `ModuleDescriptor.json` that S002 generated in the same evaluation, or else from the first of `descriptors/ModuleDescriptor.json`, `descriptors/ModuleDescriptor-template.json`, `ModuleDescriptor.json`, `src/main/resources/descriptors/ModuleDescriptor.json`, and, for the [Gradle modules](#gradle-modules) that keep their build in `service/`, `service/src/main/okapi/ModuleDescriptor-template.json`. An interface listed twice in the same way counts once. A UI module's come from `stripes.okapiInterfaces` and `stripes.optionalOkapiInterfaces` in `package.json`. Versions are compared the way Eureka compares them: same major version, and at least the required minor (and patch) version. As in mgr-tenant-entitlements, provided interfaces of type `system` (such as `_tenant`) never satisfy a requirement.

- `pass`: every interface is provided, in a compatible version, by a module the Technical Council has accepted or by a Eureka platform component.
- `fail`: a required interface is not in the catalog; an interface is there only in a different major version, or only in an older minor version from modules that are not accepted; or it is provided only by modules that are not accepted. This applies to optional interfaces too, except when none is in the catalog. The report lists each problem with what the catalog has, and says how to fix it.
- `manual`: an accepted module in the catalog has the interface with the same major version but an older minor version (the catalog has only one platform release, so a reviewer must check that an accepted module now provides the newer version); no module in the catalog provides an optional interface; some declarations could not be read (no descriptor, invalid JSON, placeholders, or version formats S008 cannot check); the catalog or acceptance ledger could not be loaded; or the repository kind is unclear. A failure takes precedence over all of these.
- `not_applicable`: the repository is an explicit FOLIO library.

## S009 Library Acceptance

S009 checks that every direct production dependency on a FOLIO library (Maven `org.folio:*` and sub-groups such as `org.folio.okapi:*`, npm `@folio/*`) is on the Technical Council's approved list, the `libraryCoordinates` in `config/acceptance-ledger.json`. [S009 library acceptance](s009-library-acceptance.md) describes the rules. The report lists each library under "Not approved", "Also built in this repository (needs review)", or "Approved", with the reason and where it is declared.

- Maven: only the build is read: the root `pom.xml`, the modules it lists (recursively, including profile modules), and the local parents they inherit from. Other `pom.xml` files, such as test fixtures, do not count. Module paths may use `/` or `\`. A listed module that is missing, outside the repository, or reached through a symbolic link (even one a later `..` cancels) makes the evidence incomplete, as do a symbolic-link root `pom.xml`, a parent path through a symbolic link, and a local parent declared with a version range. A module listed only in a profile is read, but it does not prove that a dependency on it is built locally.
- Maven: a POM whose parent path holds a different POM (another groupId, artifactId, or version) is read like a POM whose parent is published outside the repository. The report notes it, but it does not make the evidence incomplete. An unresolved property in a dependency's scope or name matters only when its group is, or may be, in the FOLIO namespace.
- Gradle: `api`, `implementation`, `compileOnly`, `runtimeOnly`, and the legacy `compile` and `runtime` configurations are read. A dependency written without parentheses ends at the end of the line, a `;`, or a `}` that closes the enclosing block, so `dependencies { implementation 'org.folio:lib:1.0' }` on one line is read. A coordinate must be a single string literal (single, double, or triple quotes); a concatenation such as `'org' + '.folio:lib:1.0'` is reported as unreadable.
- npm and Yarn: only `package.json` files matched by the root `workspaces` patterns are read, at most 128; other `package.json` files, such as test fixtures, are ignored.

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

Configuration optionality is not service optionality. A default address or an
environment variable not marked required does not establish that the service can
be absent. Configuration scenarios retain explicit required-input evidence;
otherwise their requirement is unresolved rather than inferred optional.
Agent review must establish service ownership from architecture and usage.

For required services, graceful failure does not mean continued functionality:
clear, bounded startup or tenant-initialization failure and controlled runtime
failure with truthful loss of readiness are acceptable. Distinguish process
startup, tenant initialization, and runtime operations, and liveness from readiness.
Startup coupling or lack of a feature toggle alone is not a defect. Review failure
bounds, diagnostics, readiness, and recovery rather than demanding a fallback;
an exception or connect timeout alone does not prove a bounded failure path.

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
review browses the eligible committed source tree and follows cross-file references,
using deterministic findings as starting points rather than a file-selection boundary.
Workspace safety ceilings and the review timeout still apply. Its cited advice
helps human review but never changes criterion status.

For Java databases, the evaluator groups JDBC, JPA, R2DBC, datasource, Liquibase, and
Flyway usage into dependency-level evidence rather than one diagnostic per source file.
It recognizes unconditional Spring startup lifecycle ownership and local exception
propagation. A finite database bound is proven only when committed configuration shows
both a positive connection bound and a positive operation bound; framework defaults,
transactions, and batch-to-row retries are not treated as resilience proof. Conditional
or incompletely linked database behavior remains `manual` for agent and human review.

OpenSearch Java client discovery recognizes qualified references to `RestHighLevelClient`,
`RestClient`, `OpenSearchClient`, and `OpenSearchAsyncClient` in production sources.
It groups their source locations into a `search/runtime-unavailable` scenario rather
than an unsupported-client diagnostic. This is discovery support, not automatic
call-chain analysis: requiredness, end-to-end failure bounds, readiness, and recovery
remain unresolved for agent and human review. Nearby timeouts, catch blocks, or feature
conditions do not establish resilience. Other unsupported datastore clients remain
diagnosed even when they share a file with a recognized OpenSearch client.

Stripes interfaces are read from `stripes.okapiInterfaces` and `stripes.optionalOkapiInterfaces`
in `package.json`, whether written as an object of interface versions or as a list. Each one is a
dependency that needs review. Browser `fetch` calls with a literal `https://` address are followed
to their host; `fetch` with a computed or relative URL, `XMLHttpRequest`, `WebSocket`, and
`EventSource` are reported as requests the tool cannot follow. Co-located tests (`*.test.js`,
`*.spec.ts`) and `__mocks__` are not production code.

A browser request counts as an optional service only when it has a time limit and error handling
and there is evidence that the feature can be turned off: a setting read in the same file
(`stripes.config.<key>`), an interface check in the same file (`hasInterface(...)`), or
`optionalOkapiInterfaces` in `package.json`. A timeout and a catch alone leave it `manual`.

A Java client call counts as handled only when its own call path has a time limit and error
handling: a timeout operator on the call's own method chain (`.timeout(...)`, `.orTimeout(...)`,
`Future.get(n, TimeUnit...)`, ...), and an error operator on that chain (`onErrorResume`,
`exceptionally`, ...) or a `try` block with a `catch` directly around a call whose result is
awaited there. Operators inside arguments, lambdas, comments and strings do not count, and an
asynchronous result returned from a `try` block is not handled by its `catch`. Every call through
the client must qualify; if the tool cannot follow every use of the client (it is passed to other
code, built and returned or passed on instead of assigned, declared together with another
variable, or used in more than 200 calls), the file stays `manual`. Settings and interface checks
named only in comments, strings, templates or regular expressions do not make a browser request
optional.

Agent review receives the analysis as JSON of at most 48 KB: each scenario lists up to five
references, and when the whole still does not fit, the scenarios and findings that decide the
status are kept and the rest are counted as omitted. The FOLIO interfaces of a UI module are one
dependency for the agent (`folio-interfaces`), not one per interface.

Environment variables named `AWS_*` or `S3_*`, or containing `BUCKET`, all configure one
object-storage service.

Java clients the tool recognizes but does not trace are reported as warnings and keep the result
`manual`, so a module using only them cannot pass as having no dependencies: Spring HTTP interfaces
(`@HttpExchange`, `@GetExchange`, ...), `RestClient`, Feign, Retrofit, OkHttp, Apache HttpClient,
Kafka listeners and consumers, JMS, RabbitMQ, gRPC, and S3, MinIO or `FolioS3Client` object
storage. A JDBC `DataSource` type counts as a datastore client only as a type name such as
`HikariDataSource`; `dataSource` variables and names like `DataSourceResolver` do not.

## S011 SonarQube Findings

S011 reads the module's SonarCloud project, `org.folio:<repository name>` (FOLIO's shared workflows name it that way; it is not the descriptor name S014 uses), so it runs only with `--allow-remote-lookups`. It also scans the checkout for what tells Sonar to ignore something; that scan runs without remote lookups too, and runs no commands.

SonarCloud evidence, about 15 requests through the remote-evidence transport: the project, its branches, the latest analysis, `duplicated_lines_density` (with the coverage measures S013 uses), counts of open issues with a `SECURITY` impact or of type `VULNERABILITY`, of open issues with any `HIGH` or `BLOCKER` impact (with a per-rule facet), of issues `ACCEPTED` or `FALSE_POSITIVE`, of hotspots to review and of hotspots closed by review (`REVIEWED`: safe, or marked fixed while analysis still finds them; SonarCloud has no acknowledged status), the project's quality profiles, and the rule names the report mentions. Counts come from SonarCloud's totals, so the 10,000-result cap on listings only shortens the examples. A count SonarCloud did not return is unavailable, never zero. Severities are MQR impacts, not legacy severities: mod-search has 17 legacy BLOCKER and CRITICAL issues but 28 with a HIGH or BLOCKER impact.

Branch and freshness: S011 reads the `--branch` analysis when SonarCloud has one, otherwise the main branch, and says so. The analysis must be of the evaluated commit. After every other request it reads the latest analysis again, and SonarCloud's analysis queue (`api/ce/component`); a different analysis, or a queued or running analysis of the branch, means SonarCloud was re-analysing while it was being read. An analysis of another commit, an unknown evaluated commit, a re-analysis, or a queue that cannot be read is stale, and stale data can neither pass nor fail.

The repository scan reads source, build and CI files (at most 20,000 files of 1 MiB each, skipping `node_modules`, and `target`, `build`, `dist` and other build output only at the root of the repository or of a module; an oversized non-code file such as test XML is noted but does not make the scan incomplete):

- `@SuppressWarnings` (Java, Groovy) and `@Suppress` (Kotlin, including `@file:` and other use-site targets) values naming a Sonar rule (`java:`, `squid:` with old names such as `squid:HiddenFieldCheck`, `javabugs:`, `javasecurity:`, `kotlin:`, `groovy:`) or `"all"`, with what they annotate (class, method or field). In Java files, the javac and Eclipse warning names sonar-java also reads as Sonar suppressions count too, with the rules they hide: `"unused"`, `"null"` (`java:S2259`), `"resource"`, `"rawtypes"`, `"deprecation"` and the rest of sonar-java's `SuppressWarningFilter` table. Other values (`unchecked`, `checkstyle:...`) are not Sonar suppressions.
- `NOSONAR` in a comment, in any language.
- Analysis scope: `sonar.sources`, `sonar.inclusions`, `sonar.exclusions`, `sonar.test.inclusions`, `sonar.test.exclusions`, `sonar.cpd.exclusions`, `sonar.issue.ignore.*`, `sonar.issue.enforce.*`, and language exclusions and file suffixes (`sonar.javascript.exclusions`, `sonar.java.file.suffixes`, …) in `pom.xml`, `build.gradle(.kts)`, `gradle.properties`, `sonar-project.properties`, `.mvn/maven.config` and `-D` options in workflows, and the `sonar-exclusions` and `sonar-sources` inputs to FOLIO's shared workflows, minus the defaults `config/folio-shared-workflows.json` records for that workflow. `sonar.coverage.exclusions` is listed but does not count for S011.
- A comment on the same line or ending on one of the two lines above. Javadoc describes the method, not the suppression, so it does not count.

`eslint-disable` is ESLint, not Sonar; the report counts it in one line and it never counts as an ignored rule.

SonarCloud's own project settings (Administration > Analysis Scope) can also exclude code. SonarCloud answers `api/settings/values` anonymously with an empty list, which cannot be told apart from nothing set, so S011 reads them only when `SONAR_TOKEN` is supplied and `api/navigation/component` for the project reports `configuration.showSettings: true`. It then reads the same scope keys from `api/settings/values`, counting project and organization values but not built-in defaults; an entry it cannot read leaves the settings unread. SonarQube sets that flag only for project administrators (`ComponentAction.writeConfigPageAccess`). Without such a token S011 cannot pass, and every report says the settings were not read.

Checked in order; the first that applies decides:

- `manual`: remote lookups are off; SonarCloud has no project (the report explains FOLIO's `gradle.yml` does not run SonarCloud when the CI uses it, as for mod-agreements); SonarCloud, its branch list or the latest analysis could not be read; or the analysis is stale.
- `fail`: an open security issue of any severity, a security hotspot to review of any probability, an open issue with a `HIGH` or `BLOCKER` impact in main or test code, or more than 3.0% duplication (3.0% passes). Each is judged from its own evidence, so a proven violation fails even when another count could not be read.
- `manual`: a count could not be read; the repository or CI suppresses a Sonar rule or sets analysis scope; SonarCloud's project settings set scope; an issue is accepted or marked false positive; a hotspot was closed by review; a quality profile is not the organization default; the scan was incomplete; or SonarCloud's project settings could not be read.
- `pass`: a fresh analysis with every count available and clean, nothing ignored, and SonarCloud's project settings read and empty.

Whether a suppression is reasonably justified is never decided by the tool. The report flags where suppressions depart from FOLIO's guidance (no comment, `NOSONAR`, `"all"`, class level, a security rule) and lists them for failing modules too. Optional agent review assesses each group of suppressions; see [Agent Review Configuration](agent-review.md#s011-sonarqube-suppression-review).

Fixtures are recorded with `yarn capture:remote-fixtures --sonar <checkout...>`, which runs S011 on each local checkout and writes `sonarcloud-<repository>.json`. Response bodies are trimmed to the fields the evaluator reads (`src/tools/sonarcloud-fixture-trim.ts`), keeping every request URL and the totals, paging and facets as recorded; `--no-trim` keeps whole bodies and `--retrim <fixture...>` trims recorded fixtures again. The S011 tests fail if the evaluator reads a field the trim drops, so add a new field to the trim list and re-record.

## S012 Officially Supported Build Tools

S012 checks the tools that build the module against the build-tool sections of the committed `config/officially-supported-technologies.json` (the frontend section for UI modules and libraries, the backend section for Java modules). It reads build and workflow files only, so it runs the same in safe mode and never makes a network request. `--allow-local-commands` adds nothing.

S012 reads these files at the repository root (Gradle files also in `service/`): `pom.xml` (only the `maven-enforcer-plugin` `requireMavenVersion` rule), `.mvn/wrapper/maven-wrapper.properties`, `build.gradle(.kts)`, `gradle/wrapper/gradle-wrapper.properties`, `package.json` (`packageManager` and `engines.node`), the start of `yarn.lock` (Yarn 1 writes `# yarn lockfile v1`, Yarn 2+ a `__metadata` entry), `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `.yarnrc.yml` (`yarnPath`), `.nvmrc`, `.node-version`, `Makefile`, `go.mod`, `Dockerfile`, `build.sbt`, `WORKSPACE`/`MODULE.bazel`, root `Jenkinsfile*` files, and every `.github/workflows/*.yml`. It reads at most 64 files of up to 1 MB each and never follows a symbolic link; a file it cannot read keeps the result from passing.

The tool that CI runs decides which build is checked: a job that calls `folio-org/.github/.github/workflows/maven.yml`, `gradle.yml` or `ui.yml` at a ref in the shared-workflow table, or an inline step that runs `mvn`, `./gradlew`, `yarn`, `npm ci`/`npm install`, `pnpm`, `make`, `sbt` or `bazel` in the repository root or `service/`. Commands are read with shell quoting, comments, here-documents and command substitutions in mind, so a tool named in an `echo` string, a comment or here-document text does not count, while one inside `"$(...)"` does; nor do commands after a `cd` to another folder, `npm run`, global installs, or commands run through `bash -c`. At most 200 build commands are read; reaching that limit keeps the result from passing. Without CI evidence the build files decide; if a workflow file could not be read and more than one build tool's files are present, a tool chosen that way needs review instead of failing. Build files of other tools, such as a `package-lock.json` next to a Maven build, are listed as not used by the build. For a UI module the package manager comes from CI, then the `packageManager` field, then the lockfiles; files pointing to a second package manager (for example both `yarn.lock` and `package-lock.json`) need review.

Versions: each declaration becomes a range before it is compared the way S007 compares versions. A Maven or Gradle wrapper, `.nvmrc`, `.node-version`, a workflow `node-version` (including `${{ env.X }}` values set in the workflow, job or step, and a plain `${{ matrix.X }}` list; a matrix with `include` or `exclude`, or any other expression, leaves the version unsettled), a `maven-version` for `stCarolas/setup-maven`, the `packageManager` version and the `yarn.lock` format pin the version the build uses. A Node version set in a CI job counts only when that job builds the module (it calls `maven.yml`, `gradle.yml` or `ui.yml` at any ref, or runs a Yarn, npm or pnpm build command such as `yarn install` in the repository root or `service/`); one set in another job, such as a module-descriptor or docs job, is shown but does not count. `requireMavenVersion` (after Maven's merges: managed executions join the declared plugin, execution configuration wins; a rule counts when its execution runs the `enforce` goal, is not bound to phase `none` and is not skipped; a rule that does not run is shown only; a rule only in `<pluginManagement>` or skipped by a property may run, so it cannot help a pass and, if it allows no supported version, needs review) and `engines.node` only make the build refuse other versions: a bare `3.6` means 3.6 or later (Maven range semantics), `[3.9]` exactly 3.9, `[3.6,3.8)` as written. When the repository pins nothing, the version comes from the shared-workflow table for the shared workflow that builds the module.

- `pass`: every tool the module builds with is listed with a normative rule, and its version is pinned or inherited and allowed, or enforced within the policy.
- `fail`: the module builds with npm, pnpm, Yarn 2 or later, sbt or Bazel; a pinned version (all of them, when there are several) is outside the policy; or a `requireMavenVersion` or `engines.node` rule allows no supported version. A failure takes precedence over everything below.
- `manual`: the policy entry is provisional (Gradle, Make), advisory or contested; pinned versions disagree; no version is settled (for example only `requireMavenVersion 3.1.1`, with no CI the table covers); a UI module's only CI is a root `Jenkinsfile` (Jenkins is listed "for legacy projects"); the evidence is incomplete; no build tool is recognized; or the policy or table could not be loaded.

Docker is listed as advisory and never changes the result. GitHub Actions and Jenkins appear only in the frontend list, so for backend modules CI is reported but does not decide. Inactive Jenkins files (`Jenkinsfile-disabled`, `Jenkinsfile.deprecated`, other `Jenkinsfile.*`) are listed as not used by community CI.

The report names the policy page status and export date. The committed policy records no release name, so the report shows `ACCEPTED, exported 2026-07-14` rather than a release.

### FOLIO Shared-Workflow Table

`config/folio-shared-workflows.json` (schema `src/schemas/folio-shared-workflows.schema.json`) records what FOLIO's reusable workflows at one ref (`v1`) supply when a repository does not: the build tool, the Node.js line `ui.yml` installs, and the Maven and Yarn versions that ship with the `ubuntu-latest` runner, each with its source and the date it was recorded. A workflow or ref not in the table supplies nothing. Maintainers refresh the table when `folio-org/.github` moves `v1` or GitHub updates the runner image: check the workflow inputs at the new commit and the runner image readme, update `reviewedCommit`, `reviewedAt` and each `recordedAt`, and run `yarn test --testPathPattern=s012`.

## S013 Unit Test Coverage

S013 checks that the module's unit tests cover at least 80% of its code and use officially supported test technologies.

Coverage comes only from SonarCloud's overall `coverage` measure for the project `org.folio:<repository name>`, which combines line and branch coverage and is the figure TC evaluations quote. The report also shows line and branch coverage and the lines and conditions to cover. S013 never runs tests, even with `--allow-local-commands`, and does not download CI coverage artifacts. For Java modules SonarCloud's figure includes every test the build runs (unit and integration, merged by JaCoCo); the evaluator cannot separate them. Reading SonarCloud needs `--allow-remote-lookups`; S013 shares one SonarCloud snapshot per evaluation with S011. It reads the default branch's analysis, or the `--branch` analysis when SonarCloud has one, and uses it only when the analysis is of the evaluated commit and SonarCloud did not re-analyse the project while it was being read.

Test technologies come from the build files, read without running anything: dependencies of the root `pom.xml` and of the modules it lists (one level down), the `test*` configurations of `build.gradle(.kts)` at the root or in `service/`, and `package.json` `dependencies` and `devDependencies`. They are checked against the `s013` testing sections of `config/officially-supported-technologies.json`:

- Runners: JUnit (`junit-jupiter*`, `junit:junit`, `spring-boot-starter-test`, `vertx-junit5`) and Jest (`jest`, or `@folio/jest-config-stripes`, which also brings React Testing Library) are listed. Spock (`org.spockframework`, `spock-reports`, Grails testing support), TestNG, Mocha, Karma, BigTest, Jasmine and Vitest are not.
- React Testing Library, REST Assured and Testcontainers are listed and reported. Mockito, AssertJ, WireMock and Awaitility are shown but not judged; the page does not govern them. Cypress and Karate are integration or end-to-end tools and do not count.
- Jest and React Testing Library versions come from the `jest` and `@testing-library/react` entries of a Yarn 1 `yarn.lock`, wherever they sit in the tree. The policy's version advice (Jest 29 or greater, RTL 14 or greater) is shown as a recommendation and never changes the result; a `yarn.lock` that cannot be read only hides the versions.

- `pass`: SonarCloud's overall coverage for the evaluated commit is at least 80.0, it measured some lines to cover, and every unit-test runner found is listed.
- `fail`: SonarCloud's overall coverage for the evaluated commit is below 80.0, with at least one line to cover. A reported 0.0% is a real figure and fails; the report adds a hint to check that CI uploads its coverage report to SonarCloud.
- `manual`: remote lookups are off; SonarCloud has no project (the report says when the module builds with FOLIO's `gradle.yml`, which does not run SonarCloud) or could not be read; the analysis is of another commit, the evaluated commit is unknown, SonarCloud re-analysed during the read, or a new analysis of the branch was still being processed; the `coverage` or `lines_to_cover` figure is missing, or `lines_to_cover` is 0; a unit-test runner is not listed; no runner was found; a build file that can declare test dependencies could not be read; or the policy could not be loaded. A failing coverage figure takes precedence over everything in this list except the gates for remote lookups and stale analyses.

When SonarCloud has an analysis, the report also lists what the coverage figure leaves out, for review only: `sonar.coverage.exclusions`, `sonar.exclusions` (and language-specific exclusions), `sonar.sources` and `sonar.inclusions` that S011's scan finds in build files, properties files and `-D` options; the sources and exclusions each FOLIO shared workflow passes to the scanner (its defaults from `config/folio-shared-workflows.json`, or the caller's `sonar-sources`/`sonar-exclusions` input, which replaces them; nothing when `do-sonar-scan` or `sonar-enabled` is `false`); and SonarCloud's own project settings when `SONAR_TOKEN` can read them. A FOLIO build workflow at a ref the table does not cover is listed as unknown, and an unreadable build or CI file is reported, so the list never claims to be complete when it is not.

A module without tests is never failed on that alone: its coverage figure decides. A missing figure is never read as 0. The report names the policy page status and export date, like S012 (`ACCEPTED, exported 2026-07-14`; the committed policy records no release name), and lists every SonarCloud request under "Sources".

## S014 Application Assignment

S014 checks that the module is in exactly one application of the FOLIO LSP platform, and that it is the application the evaluation's Jira task names. Jira tasks are not public, so the person running the evaluation passes that application with `--application <name>`.

The check reads the network, so it runs only with `--allow-remote-lookups`. It resolves `--platform-ref` (default `snapshot`, the branch with the current platform; `master` is stale) in `folio-org/platform-lsp` to a commit, reads `platform-descriptor.json` there, and reads each pinned application's descriptor from FAR (`far.ci.folio.org`), about 40 requests. Required, optional and experimental applications all count; experimental ones are labelled as such. Applications outside the platform, such as `app-platform-full` or `app-edge-locate`, never count. When the module is in no platform application and the named application is not on the platform, S014 also reads that application's own `<name>.template.json` from its `folio-org` repository.

The module name is the one applications list: for a backend module, the name part of the committed descriptor's `id` (for example `mod-search` from `mod-search-${version}`), else the project's own `artifactId` in `pom.xml` (not its parent's), else the repository name; for a UI module, the `package.json` name with `@folio/x` read as `folio_x` (ui-users is `folio_users`).

- `pass`: exactly one platform application lists the module, and it is the one `--application` names.
- `fail`: two or more platform applications list the module; exactly one lists it and `--application` names another; or none lists it and the named application, if any, is on the platform or its own template does not list the module either. A proven violation fails even when other applications could not be read.
- `manual`: remote lookups are off; the module name could not be determined; the platform descriptor could not be read or lists no applications; some applications could not be read and those that could list the module at most once (and in the named application, if one is given); exactly one application lists the module but `--application` was not given; or no platform application lists it and the named application is not yet on the platform but its own template lists the module (or could not be read).
- `not_applicable`: the repository is an explicit FOLIO library.

An application whose FAR descriptor is missing, not exactly one record, for another version, or has module entries the tool cannot read counts as unread, never as empty. An application pinned twice at the same version is one application; pinned at two versions, it is unread.

### Remote lookups

`--allow-remote-lookups` turns on the evaluator's only network reads during evaluation (catalog refresh commands are separate). Every read goes through `src/utils/remote-evidence.ts`:

- HTTPS `GET` only, to `far.ci.folio.org/applications`, `sonarcloud.io/api/`, and `raw.githubusercontent.com` or `api.github.com` paths of `folio-org/platform-lsp` and `folio-org/app-*`. Every redirect is checked against the same list, and at most 3 are followed.
- Per request: 15 s and 4 MiB, and the response must be JSON. One retry on HTTP 429 or 5xx, waiting for `Retry-After` only up to 10 s.
- Per evaluation: at most 150 requests, 32 MiB and 120 s, with at most 4 requests in flight. A read that hits a limit fails; it never returns partial or empty data.
- Optional tokens: `SONAR_TOKEN` is sent only to `sonarcloud.io` and `GITHUB_TOKEN` only to `api.github.com`, so a redirect to another host drops it. A token that is not a valid header value is not sent. Tokens are never recorded, and network error text, which can quote request headers, is not either; a token value that reaches any output is masked as `[REDACTED_SONAR_TOKEN]` or `[REDACTED_GITHUB_TOKEN]`. Without a token, GitHub allows 60 anonymous API requests an hour; S014 uses one per evaluation. SonarCloud answers S011 and S013 anonymously (they share one set of about 14 reads); a `SONAR_TOKEN` matters only for reading the project's own settings (see S011).
- Every read is recorded in `criterionDetails.remoteEvidence` with its URL, time, HTTP status and the SHA-256 of the response, plus each redirect hop and retry with its status, and the report lists them under "Sources". A response that completes after its time limit is rejected even if it arrived in full.

Tests never touch the network: they replay responses recorded by `yarn capture:remote-fixtures` into `src/__tests__/fixtures/remote/`, and an unrecorded URL fails the test.

## F001 Consumed Interfaces Declared

F001 checks that every API the package consumes is declared in `package.json`: each backend interface its code calls is a key of `stripes.okapiInterfaces` or `stripes.optionalOkapiInterfaces` (the version is S008's concern). It works offline in safe mode from the committed production source (the same read as F003), `package.json` as S008 reads it for UI modules (`collectFrontend`, here for libraries too), and `config/f001-handler-index.json`.

**Request sites** (the `uiRequestSites` run artifact, which S010 can use later): stripes-connect manifest resources of type `okapi` (`path`, and the `path` of `GET`, `POST`, `PUT`, `PATCH` and `DELETE`); calls on a ky instance (`ky(...)`, `ky.get|post|put|patch|delete|head(...)`), where an instance is `useOkapiKy()`, a variable named `ky` or `okapiKy`, or `.extend({ prefixUrl })` of one; and `fetch` on `okapi.url`. A path may be a string or template literal, a concatenation, a constant, an object property, or a function that returns one, from the same file or a relative import inside the production source (re-exports included, at most 8 steps). Both branches of `cond ? a : b` are requests, and a stripes-connect path function sends whatever its return statements name. stripes-connect tokens (`%{}`, `!{}`, `?{}`, `:{}`) and run-time values become one segment `{}`; the query string is dropped. An import from a package or outside the production source (a test fixture, say) is not followed, so a path that needs it is unresolved. Requests to Okapi's own `_/` endpoints and to other hosts are not counted.

**Matching**, against the handler `pathPattern`s of every non-system interface (`{name}` is one segment, `*` any text): exact matches win, and among them the most specific pattern (more fixed segments, then more parameters, then fewer wildcards), so `inventory/items/move` is `inventory-move`, not `inventory`'s `/inventory/items/{id}`. Two interfaces with equally specific patterns are ambiguous. A run-time segment exact-matches a `{param}` segment, so `users/${id}` is `users` even though `/users/capabilities` exists. Without an exact match, a run-time segment may stand for a fixed one (or for text a wildcard segment such as `settings*` accepts): the request maps only when every such pattern belongs to one interface, otherwise it is dynamic. A path the code ends with an unknown value (`${ENDPOINT}${query}`) maps only when every pattern it could continue into belongs to one interface.

- `fail`: a request maps to exactly one interface that `package.json` declares in neither list (Q1), for modules and libraries alike. A declaration S008 cannot check (an unusual version, say) still declares its interface.
- `pass`: every request maps to a declared interface, or there are no requests (stripes-components).
- `manual`: requests the tool could not read, dynamic or ambiguous matches, paths not in the handler index, a handler index that did not load, unreadable declarations or source. A proven violation still fails, but not when `package.json` or one of its two declaration maps could not be read, since it might declare the interface.

Declared interfaces no request maps to are listed for information only.

**Handler index.** `yarn build:f001-handler-index` reads `config/s008-catalog-official.json` and fetches each provider's descriptor again from the source the catalog records (the FAR application with `full=true`, or a manager's pinned descriptor URL), so mod-circulation-bff, added to the catalog by hand from app-requests-ecs, is included. Each descriptor must hash to the catalog's descriptor hash, or the build stops. The index keeps, per provider, each interface's `methods` and `pathPattern`, without system interfaces (ids starting with `_`, or `interfaceType: system`); a handler with Okapi's legacy `path` instead of a `pathPattern` stops the build. It records the catalog's digest; F001 treats an index built from another catalog as not loaded. S008's catalog and results are unchanged. Refresh the index whenever the S008 catalog changes; the platform is a GA release, so newer interfaces show up as "Paths not in the handler index" (manual, never fail).

Checklist items, shown for fail and manual: **F001-C1** (reviewer only) each interface under "Used but not declared" is declared, in `optionalOkapiInterfaces` when the code checks `stripes.hasInterface`; **F001-C2** each unresolved request goes to a declared interface; **F001-C3** each path not in the handler index belongs to a declared interface; **F001-C4** (reviewer only) requests made through shared-library hooks (`use…` imported from `@folio` packages other than stripes itself) go to declared interfaces.

F001 has agent review, which runs by default for a manual result when agent review is enabled (Q6), so it never sees a fail. See [Agent Review Configuration](agent-review.md#f00x-frontend-criteria-review).

## F002 End-to-End Tests

F002 checks "if E2E tests are provided, they use a supported technology". The officially supported technologies page lists one entry for UI integration and end-to-end testing, "Cypress 12.0, pending verification" (section `frontend-integration-testing`, which F002 selects by its id, minimum 12.0.0, provisional). F002 detects the tooling itself, from the committed tree, in safe mode: `package.json` dependencies and scripts, `yarn.lock`, configuration files at the repository root, test directories, and what CI runs (`.github/workflows/*.yml` and the `Jenkinsfile`; `Jenkinsfile.*` variants are inactive, as for S012). S013's test evidence is not used: it reads only dependencies, from the working tree.

| Tool | Seen from | Kind |
| --- | --- | --- |
| Cypress | `cypress` dependency, `cypress.config.*` or `cypress.json`, `cypress/`, `cypress run\|open`, the `cypress-io/github-action` step | supported |
| Playwright, WebdriverIO, Nightwatch, TestCafe, Puppeteer, Nightmare | `@playwright/test`, `webdriverio` or `@wdio/cli`, `nightwatch`, `testcafe`, `jest-puppeteer`, `nightmare` dependencies; their configuration files (`playwright.config.*`, `wdio*.conf.*`, `nightwatch.conf.*`, `.testcaferc*`, `jest-puppeteer.config.*`); `playwright test`, and `wdio`, `nightwatch` or `testcafe` run as a command (at the start, after `&&`, `;` or `|`, or after `npx`, `yarn`, `pnpm` or `exec`; a word in a path or an `echo` does not count), `stripes test nightmare` | end-to-end framework not on the page |
| Karma, BigTest | `karma` and `karma-*` dependencies, `karma.conf.*`, `karma start` or `stripes test karma` (stripes-cli runs Karma itself); `@bigtest/*` dependencies, `test/bigtest/` | browser tests that may be component or end-to-end tests |
| unrecognized | a `test/e2e/` directory with none of the above (with exactly one of them, it counts as that one's suite) | end-to-end tests of unknown framework |

`tests/` counts like `test/`. A bare `puppeteer` or `playwright` dependency does not count: Karma setups use Puppeteer to download Chrome. Jest and React Testing Library are unit tests (S013), never end-to-end tests.

**CI.** Each workflow step's `run` lines (shell comments skipped) and each `Jenkinsfile` line outside `//` and `/* */` comments are read for the commands above, following the `package.json` scripts they call (`yarn test`, `npm run e2e`, scripts calling scripts). A job that uses FOLIO's shared `ui.yml` at the ref `config/folio-shared-workflows.json` records (`v1`) runs its test jobs as the table records them: `jest-test-command` unless `jest-enabled` is `false`, and `bigtest-test-command` unless `bigtest-enabled` is left out or `false`, both `yarn test` by default; an expression such as `${{ inputs.e2e }}` counts as enabled. FOLIO's Jenkins `buildNPM` with `runTest` set (`'yes'`, `true`, …, as `buildNPM` accepts) runs `yarn test`. A tool only CI runs still counts.

- `not_applicable`: none of the tools above. FOLIO's end-to-end tests for UI modules live in stripes-testing.
- `fail`: an end-to-end framework not on the page, whatever else the repository has (a proven violation fails).
- `pass`: Cypress is the only tool, at 12.0 or later: the version `yarn.lock` resolves for the `package.json` range, or, without one, a range whose every version is 12.0 or later (the comparison S007 uses). The page marks Cypress "pending verification", which S007 treats as manual; F002 passes it (decision Q3) and says so in the report.
- `manual`: Cypress below 12.0, with a range that allows versions below it, or of unknown version (no `cypress` dependency); Karma, BigTest or an unrecognized `test/e2e/`, alone or with Cypress; the Cypress policy entry could not be read; or a file that could show a tool (`package.json`, a workflow, the `Jenkinsfile`, the tree listing) could not be read, which also stops a pass or not applicable. A `yarn.lock` that cannot be read only hides Cypress's resolved version.

Checklist items, shown for fail and manual: **F002-C1** each browser test suite found is a component test, or an end-to-end test in a supported framework (one obligation per tool found, at its configuration file, else the first file it was seen in); **F002-C2** CI runs end-to-end tests only with a supported framework (starting points: the CI lines found, or the CI files read).

F002 has agent review, which runs by default for a manual result when agent review is enabled (Q6), so it never sees a fail. See [Agent Review Configuration](agent-review.md#f00x-frontend-criteria-review).

## F003 Internationalization

F003 checks "i18n support via react-intl": the package renders its user-visible text through react-intl from `translations/<namespace>/en.json`, a JSON object of English texts. Everything comes from the committed tree: production source (`src/`, `lib/` and root-level `.js`/`.jsx`/`.ts`/`.tsx` files, without tests, stories, examples, fixtures and mocks), `package.json` and the `en.json` files. Source is at most 2,000 files with the default size limits; `package.json` and `en.json` are read separately, so a large source tree cannot crowd them out. JSX is parsed with the TypeScript parser, so comments never count as text.

- `not_applicable`: the package renders no user interface (Q10): its production code renders no HTML element, no JSX text and no literal text prop (`label="Save"`), and it has no `translations/` directory. JSX that only renders components it is given, such as stripes-connect's `<Wrapped {...props} />`, does not count. F006 uses the same check, and F004 and F007 will.
- `fail`: react-intl is not in `dependencies` or `peerDependencies`, or no production file imports it; or there is no `en.json` for the namespace, or it is not valid JSON or not a JSON object.
- `manual`: literal message ids of the namespace missing from `en.json` (Q4), each counted once however often it is used; hard-coded text; texts in `en.json` that are empty, not strings, or not valid ICU messages (`@formatjs/icu-messageformat-parser`, as react-intl parses them); an unclear namespace; or source that could not be read or parsed.
- `pass`: none of the above.

The namespace is the only directory under `translations/` (ui-checkin's package is `@folio/checkin`, its namespace `ui-checkin`). With several directories, the Stripes naming rule picks `ui-` plus the package name, or the bare name for `stripes-*` packages; otherwise the namespace is unclear. Message ids are read from `<FormattedMessage id>`, `<FormattedHTMLMessage id>`, `formatMessage({ id })` and `translate(...)`; both ids of `cond ? 'a' : 'b'` count as literal. An id of the namespace, `ui-checkin.statusModal.cancel`, is the key `statusModal.cancel` in `en.json`. Ids of other namespaces (`stripes-core.…`) are counted, not checked. Computed ids (template literals, variables) are listed but not checked and never block a pass. Hard-coded text candidates are JSX text and string values of `aria-label`, `label`, `placeholder` and `title` with two or more words; HTML entities such as `&nbsp;` are not words.

Checklist items, shown for fail and manual: **F003-C1** each listed id exists in `en.json`, or the code supplies English fallback text; **F003-C2** no user-visible text is hard-coded; **F003-C3** computed message ids resolve to keys in `en.json`; **F003-C4** every `en.json` value has valid ICU syntax. An item appears when it has something to check: C1 and C2 also when source could not be read, C1 also for an unclear namespace.

F003 has agent review, which runs by default for a manual result when agent review is enabled (Q6). See [Agent Review Configuration](agent-review.md#f00x-frontend-criteria-review).

## F005 Stripes Version


F005 checks that the module uses the Stripes version on the officially supported technologies page ("Stripes 10.1 or greater" in the committed policy). It does not compare versions itself: it takes S007's own finding for `@folio/stripes`, which S007 and F005 read from one analysis per run, so the two always agree and `--criteria F005` works without S007.

- `pass`, `fail` or `manual`: as S007's Stripes finding. For example, `^10.0.0` without a `yarn.lock` is manual (the range also allows 10.0.x), and the same range with a `yarn.lock` resolving 10.1.5 passes.
- `manual`: a library without an `@folio/stripes` dependency, i.e. a Stripes constituent library such as stripes-components (checklist item F005-C2: this release is part of, or compatible with, the supported Stripes version); a module without an `@folio/stripes` dependency; or the policy could not be loaded.

F005 has no agent review: nothing in the repository can settle what it leaves to the reviewer.

Like every F criterion, the report has up to three layers: what the tool found and the status it decided; a checklist for the reviewer, whose items have stable IDs such as `F005-C1`, are phrased as the desired state and list where to start (`criterionDetails.checklist`; empty for pass and not applicable); and, for criteria with agent review, the agent's results attached to the checklist items they address, with the reason for each result that was dropped.

## F006 UI Layouts and Patterns

F006 checks that the package follows existing FOLIO UI layouts, patterns and norms. Most of that is judgment, so F006 is `not_applicable` when the package renders no user interface (the check F003 uses) and otherwise always `manual`; it never passes or fails. It reads the committed production source F003 reads, plus the component CSS under `src/` and `lib/` (without stories and examples, at most 2,000 files), in safe mode.

What the tool lists for the reviewer:

- **Stripes components**: JSX uses of known layout, search and filter, action and menu, confirmation, form control and settings components (`Paneset`, `Pane`, `Layer`, `SearchAndSort`, `FilterGroups`, `PaneMenu`, `ConfirmationModal`, `Button`, `Settings`, …) imported from `@folio/stripes/components`, `@folio/stripes/smart-components`, `@folio/stripes-components` or `@folio/stripes-smart-components`, including aliased and namespace imports. In stripes-components and stripes-smart-components themselves, their own components imported from inside the package count too.
- **Forms**: calls of `stripesFinalForm` (`@folio/stripes/final-form` or `@folio/stripes-final-form`) and `stripesForm` (`@folio/stripes/form` or `@folio/stripes-form`), whatever the local name, with their `navigationCheck` option: `true`, `false`, not set, or an expression the tool cannot read (options passed as a variable, a spread after the option or, without it, anywhere in the options). Both default to `false`, so a form without it does not ask before discarding unsaved changes; "not set" is listed apart from `false` but is a starting point all the same. Forms built directly with react-final-form or redux-form are not listed.
- **Raw HTML controls**: `<button>`, `<select>`, `<textarea>` and `<input>` where a Stripes component exists (an input `type` written as a string, also inside `{}`: text-like inputs, checkboxes, radio buttons, date and time inputs, and submit buttons; not file, range, color or hidden inputs). `<option>` is not a control. In `@folio/stripes-components`, which implements the Stripes controls, HTML controls are not counted.
- **Hex colors** of 3, 4, 6 or 8 digits in CSS declaration values (`color: #333`, `--accent: #abcdef80`) and at-rules such as `@value brand: #123`, not in comments, strings or `#id` selectors. In stripes-components, which defines the Stripes color variables, their definitions (`--name: #fff`) are not counted.
- **The app**: `stripes.actsAs`, `route` and `home` from `package.json`, and settings pages (object literals with a literal `route`, a `label` and a `component`, as the Stripes `Settings` component takes them).
- **External links**: `http` and `https` URLs in JSX (attribute values, text, and strings inside JSX expressions) and in each committed `translations/<namespace>/en.json`; XML namespace URIs are left out. They are never fetched.

Unreadable or unparsable source is listed and the summary says so; the result is `manual` either way.

Checklist items, all phrased as the desired state: **F006-C1** screens use the standard pane layout; **F006-C2** search and filter screens follow the SearchAndSort and filter pane patterns; **F006-C3** every form asks before discarding unsaved changes (starting points: the forms whose `navigationCheck` is not `true`); **F006-C4** destructive actions ask for confirmation with standard wording; **F006-C5** actions, buttons and menus follow the action menu and button guidelines; **F006-C6** Stripes components and color variables are used instead of raw HTML controls and hard-coded colors; **F006-C7** (reviewer only) state is kept when navigating between apps and back, or the user is told it will be lost; **F006-C8** settings pages follow the settings layout; **F006-C9** (reviewer only) each documentation link shown in the UI is publicly accessible.

**UX guidelines.** `config/f006-ux-guidelines/` holds a pinned copy of stripes-components' `guides/ux-guidelines` (the source of ux.folio.org): `layout/`, `forms/`, `navigation/`, `actions/` (confirmation wording, buttons and action language), `feedback/ConfirmationModalPattern.mdx` and `data-display/MultiColumnListGuidelines.mdx`, about 78 KB (Q9, plus the button and results-list pages that F006-C2, C5 and C6 are measured against). `source.json` records the repository, commit and commit date, and lists the files; the report shows the commit. To refresh it, copy the same files from a newer stripes-components commit and update `source.json`.

F006 has agent review, which runs by default for a manual result when agent review is enabled (Q6). See [Agent Review Configuration](agent-review.md#f00x-frontend-criteria-review).

## B001 Module Descriptor Template

B001 checks that the repository includes a compliant module descriptor: the committed template, not the descriptor the build generates (that is S002). It reads the template from the committed source, replaces the build placeholders the build properties define, and validates it against the same Okapi ModuleDescriptor schema S002 uses. It runs no commands, so it works in safe mode.

- **Template:** a `ModuleDescriptor*.json` in `descriptors/`, `src/main/resources/descriptors/`, `service/src/main/okapi/` or the repository root, the same places that make a repository a backend module.
- **Placeholders:** `${name}` and `@name@` take their values from the nearest `pom.xml` (its `<properties>`, and the project's `artifactId`, `version`, `groupId` and, with `project.`, `name` and `parent.version`; the version and groupId fall back to the parent's) and from the `gradle.properties` files of the template's folder and its parents, nearest first. A property may refer to other properties. A placeholder the build properties do not define, such as Grails' `${info.app.name}`, is left as written; inside a JSON string that does not affect validity, and the report lists where it is used.
- `pass`: exactly one template, valid JSON that matches the schema.
- `fail`: the template is not valid JSON after placeholders are replaced, or does not match the schema; or an edge module (an `edge-` artifactId with an `edge-common` or `edge-common-spring` dependency in `pom.xml`) has no template.
- `manual`: several candidate templates; a placeholder outside a JSON string, such as a number, whose JSON only the build decides; a template that could not be read; or a repository with no descriptor that is not a known shared library ("a module must have one; a library need not").
- `not_applicable`: an allowlisted shared library without a descriptor, now including `edge-common` and `edge-common-spring`.

With `--allow-local-commands`, when S002 generated the descriptor in the same evaluation, B001 also says whether that descriptor matches the schema; it does not change B001's status. B001 has no agent review. Its checklist for the reviewer has B001-C1 (the template is the one the build uses) and, for a repository that is neither a module nor a known library, B001-C2.

B001 builds the evidence the other B criteria share, read once per evaluation from committed files: the repository kind, the parsed template, the framework and storage. It reads only `src/main/` (in any module folder), `grails-app/`, descriptor templates, `ramls/`, `templates/db_scripts/`, YAML and JSON files under `api/`, `openapi/` or `swagger/` folders, build files, `Dockerfile`, and the root `README*` and `ENV_VARS.md`, up to 2,000 files of up to 1 MB each and 8 MB in total; binaries and large files elsewhere, such as test images, do not make it incomplete. A larger file there still makes it incomplete: large data files, such as mod-source-record-manager's MARC mapping rules, share folders and formats with large OpenAPI specs, such as mod-erm-usage-counter's `COUNTER_API.json`, so one cannot be skipped as data without reading it. Git submodules, such as `ramls/raml-util` and `ramls/acq-models`, are skipped. Reference-data folders (`ref-data/`, `reference-data/`) are listed, not read. The framework is detected from main-class and source evidence, never from a dependency alone: RMB from `org.folio.rest.RestVerticle` as the main verticle in a `pom.xml` or a `templates/db_scripts/schema.json`, Spring Boot from `@SpringBootApplication`, Vert.x from a class extending `AbstractVerticle`, Grails from `grails-app/`. Storage needs positive evidence: an RMB `schema.json`, `PostgresClient` or `PgUtil` used (not only imported), a Liquibase changelog (a `*changelog*.xml`, `.yaml` or `.json` under `src/main/resources`), a datasource in `application*.yml` or `.properties`, or Grails domain classes with a datasource. A `domain-models-runtime` dependency alone is not storage (mod-circulation uses it only for logging).

`--existing-module` records that an existing module is evaluated rather than a new one (the default). B001 and B003 do not depend on it; B006 allows RAML for RMB modules in that mode, and B004 and B005 will relax some new-module rules for existing modules.

B criteria use the same three-layer report and checklist as the F criteria (see [F005](#f005-stripes-version)).

## B003 Endpoint Implementations

B003 checks that every endpoint the module provides has an executable implementation. It reads the committed source B001 reads, so it runs in safe mode.

- **Endpoints:** each method and path of the descriptor template's handlers, without system interfaces, as for B006. An edge module's endpoints also include the operations of its own API specs.
- **Generated interfaces:** RMB and Spring modules generate their resource interfaces from the API spec during the build, so the interfaces are not committed. B003 derives each interface's name from the spec (`backendApiSpecs`) and looks for a committed class in `src/main` that implements it, by its simple or fully qualified name:
  - RMB, from RAML: the top-level resource the operation is under, named as raml-for-jax-rs 3.0.7 (which RMB runs) names it: each run of letters and digits starts with a capital (`/check-in-storage/check-ins` gives `CheckInStorageCheckIns`; `/loans` under `/loan-storage` gives `LoanStorage`). The class must be in package `org.folio.rest.impl`, the only place RMB looks.
  - Spring, from OpenAPI: openapi-generator's `<Group>Api`. The groups are the operation's tags (`DefaultApi` without one) when a build file sets `useTags` to true, and otherwise the first segment of the path as the spec writes it, without a server path (`/note-links/type/{type}` gives `NoteLinksApi`). Unless a build file sets `skipDefaultInterface` to true, the generated interface answers every operation with 501 Not Implemented by default, so the class's file must also declare the operation's `operationId` as a method; an operation without an `operationId` is not matched.
- **Routes:** in `src/main` sources, Vert.x router routes (as B006 reads them), mod-circulation's `RouteRegistration` (`new RouteRegistration(path, router)` with `getMany`, `get`, `create`, `replace`, `delete` and `deleteAll`; the router calls inside `RouteRegistration` itself are not routes), and Spring mapping annotations (`@GetMapping`, ..., `@RequestMapping` with its `method`), under a class-level `@RequestMapping` path. Paths are string literals or string constants in the same file (Vert.x router routes also accept `Other.CONSTANT`, read as B006 reads it); a Spring or RouteRegistration path with a property placeholder (`${...}`) or a qualified constant, and Spring member mappings in an interface, an abstract class or a file with more than one type (where the prefix that applies is not known), are routes the tool could not read. In Grails, the `static mappings` of `grails-app/controllers/**/UrlMappings*.groovy`: `"/path"(controller: ..., method: 'GET')`, closure mappings with `method = 'GET'`, `resources:` and `resource:` mappings with `excludes`, `includes`, `collection { }` and nested mappings, and `group "/prefix", { }`; `$name` is a parameter and `$name?` optional (at most 16 paths per mapping). `$controller`, `$action` and `$namespace` choose the code that runs, and a `method` that is not a string literal is not read; such mappings are routes the tool could not read. Commented-out code does not count, and a route whose path has `*` implements nothing on its own. A route without a method serves every method.
- **Matching:** as for B006, methods must match and parameter names do not matter. A route that has the endpoint's path only for fixed values of a parameter counts as such only when every route was read; otherwise the endpoint could not be checked.
- `pass`: every endpoint is in an API spec and a committed class implements its generated interface, or a route serves it.
- `fail`: in an RMB or Spring module, an endpoint is in no API spec, no route serves it, and nothing the tool could not read could hold it. The report ends with a "What to do" line.
- `manual`: an endpoint whose generated interface no committed class implements; a wildcard handler (`/groups*`); an endpoint served by a library (`/custom-fields` from folio-custom-fields); an endpoint found only for fixed values of a path parameter; in a Vert.x, Grails or edge module, an endpoint no route serves; an endpoint not found where part of a spec, a spec submodule, a route (its path or method is not a literal or constant, or a Grails statement of another form) or the committed source could not be read; or a repository with no readable descriptor template.
- `not_applicable`: a shared library; a module that provides only system interfaces; an edge module whose descriptor provides nothing and whose API specs document nothing.

The checklist has B003-C1: each endpoint the tool could not match has an implementation that serves its methods, starting from the spec, descriptor, build file or route of each. B003 has no agent review yet.

## B006 API Documentation

B006 checks that every endpoint the module serves is documented in an OpenAPI spec, or, for an RMB module evaluated with `--existing-module`, in RAML. It reads the committed source B001 reads, so it runs in safe mode.

- **Endpoints:** each method and path of the descriptor template's handlers, without system interfaces (named with a leading underscore, such as `_tenant` and `_timer`, or typed `system`). An edge module's endpoints are its Vert.x router routes in `src/main` (`router.route(HttpMethod.GET, "/path")`, `router.get("/path")`, with a path literal or a string constant in the same file), without `/admin/health`.
- **Specs:** OpenAPI and Swagger files (JSON or YAML with a top-level `openapi` or `swagger` key) and RAML root files (`#%RAML 1.0` or `0.8`), outside `raml-util`. OpenAPI `$ref`s are followed inside the repository as far as the paths and their operations (up to 32 references in a row); references to URLs or outside the repository, missing files or pointers, and cycles are reported. Paths are prefixed by a server URL's path (`url: /data-export/`) or Swagger 2.0's `basePath`. RAML resources take their methods from the resource and its resource type; types from FOLIO's shared `raml-util` submodule, which is not committed, are read from the methods those types define.
- **Matching:** methods must match. Parameters match whatever their names (`{id}` and `{noteId}`), and a spec parameter documents any value of its segment (OpenAPI path templating). A handler parameter that the spec documents only with fixed values (`/erm/jobs/packageImport` for `/erm/jobs/{type}`) is documented in part. A wildcard handler (`/groups*`; Okapi's `*` matches across segments) is documented by a spec path it covers.
- `pass`: every endpoint is documented in OpenAPI, or in RAML for an existing RMB module.
- `fail`: an endpoint is in no spec (including when there is no spec); or an endpoint is documented only in RAML in a new-module evaluation, or in a module that is not RMB (edge modules and plain Vert.x modules such as mod-circulation).
- `manual`: an endpoint served by a library whose own spec documents it (`/custom-fields` from folio-custom-fields; checklist item B006-C1); an endpoint documented only for fixed values of a parameter; an endpoint not found where part of a spec could not be read (an unresolvable `$ref`, a file that is not valid YAML), where the build reads specs from a git submodule (`ramlfiles_path`, `ramlDirs` or `inputSpec` naming it, as in mod-codex-mux), or where the committed source was not read completely; an edge router route whose path is not a literal or constant; or a repository with no readable descriptor template (B006-C2).
- `not_applicable`: a shared library, or a module that provides only system interfaces.

B006 has no agent review. The parsed specs are a run artifact (`backendApiSpecs`): for each spec its root file, format and version, operations (method, full path, defining file, the resource as the spec writes it, and OpenAPI tags and operationId), and the parts that could not be read.

## Advisory Agent Review

Optional OpenCode review can inform manual results but cannot change criterion status. See [Agent Review Configuration](agent-review.md) for setup and supported criteria.
