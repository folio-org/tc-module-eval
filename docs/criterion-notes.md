# Criterion Notes

This file records criterion behavior not covered in the README.

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

## S004 Installation Documentation

S004 reads the README, conventional install files, Markdown in `docs/`, `doc/`, and `deployment/`, and linked local docs. It fails only when they contain no build, run, configuration, or setup evidence, not even a link to other documentation; everything else needs manual review. The top tier ("concrete steps to install, deploy, or run") needs a recognized install, deploy, or run command. Okapi or tenant steps add context but never reach that tier alone, because S004 asks for developer build and run instructions.

Okapi/tenant evidence must be a step: an Okapi admin endpoint (`/_/proxy`, `/_/discovery`, `/_/tenant`), `--okapi` or `--tenant` flags, posting or deploying to Okapi, or enabling the module for a tenant. Mentions of Okapi or tenants in prose, API examples (including curl calls with an `X-Okapi-Tenant` header), and configuration tables do not count. Neither an Okapi or tenant admin step (unless it also runs a build or run tool, such as `yarn start --okapi …`) nor a developer build such as `mvn clean install` counts as the install or run example, even under an "Installation" heading. The report shows at most one example per paragraph, with code fences and table pipes removed.

## S005 Personal Data Disclosure Review

S005 checks `PERSONAL_DATA_DISCLOSURE.md` mechanics and completion, plus bounded source-inspection evidence. Completed forms still require manual review; S005 does not certify legal or privacy compliance.

## S006 Sensitive Information Review

S006 runs Gitleaks on the working tree and bounded checks for credential URLs, secret assignments, FOLIO or environment endpoints, and local paths. A value that looks like a real secret in production code or CI/deployment files fails; documentation, tests, examples, local Docker defaults, helper scripts, host names, private addresses, and incomplete scans require manual review. Helper scripts are files in `scripts/` folders and shell scripts, except those under `src/`, container entrypoints, Jenkinsfiles and GitLab CI files, and scripts in CI pipeline folders (including `.buildkite/`).

The built-in scan reads up to 2,000 files and 8 MB in total (96 KB per file), which covers every candidate file in large FOLIO modules such as mod-inventory-storage and ui-users. In folders where secrets are often kept (CI, deployment, configuration, and `src/main/resources`), it also reads files without an extension, such as `CODEOWNERS`; binary ones are skipped after a 1 KB probe, which counts toward the 8 MB. Data tables, stylesheets, sample payloads, and disabled files there (`.csv`, `.xsl`, `.sample`, `*.disabled`) are not read and are listed under "Skipped" without creating a coverage gap. It reads only regular files inside the repository: it never follows symbolic links, and on Linux it skips a file whose open handle resolves outside the repository, such as when a folder is swapped for a link during the scan.

The report lists each finding by file, line, kind (`[secret]`, `[token]`, `[api-key]`, `[private-key]`, `[login-url]`, `[private-url]`, `[host]`, `[local-path]`, `[env-file]`), and where it was found. It hides matched values; for an assignment it names only the variable, such as "assigned to DB_PASSWORD". Agent review receives the matched values. "Coverage gaps" lists what was not fully scanned and keeps the result in manual review; "Skipped" lists folders and files that do not affect the result, such as `.git` and `node_modules`.

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

## Advisory Agent Review

Optional OpenCode review can inform manual results but cannot change criterion status. See [Agent Review Configuration](agent-review.md) for setup and supported criteria.
