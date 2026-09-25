# S009 library acceptance

S009 verifies direct production dependencies on packages in the authoritative FOLIO namespaces: Maven `org.folio:*` and npm/Yarn `@folio/*`. It matches each exact package coordinate to `libraryCoordinates` in the shared `config/acceptance-ledger.json`, then verifies that the mapped family has an APPROVED TCR, PROVISIONALLY APPROVED TCR, TC-ratified legacy baseline, or exception scoped to S009 (or both S008 and S009).

Acceptance is family-level, not version-level. Declared versions and ranges are retained as report evidence but do not change eligibility. A deployable module that publishes a consumed package still needs an explicit package-coordinate mapping; that mapping may point to the already accepted module family without a separate library TCR. Renames, forks, and splits do not inherit acceptance automatically.

## Static dependency evidence

Normal evaluation is offline and never executes repository code or performs network requests. It scans:

- every Maven `pom.xml`: `compile` (including the default), `runtime`, and `provided` dependencies, including dependencies in profiles;
- every root and subproject `build.gradle` or `build.gradle.kts`: `api`, `implementation`, `compileOnly`, and `runtimeOnly` declarations that can be resolved statically; and
- the root npm/Yarn `package.json` plus declared workspaces: `dependencies`, `optionalDependencies`, `peerDependencies`, `bundledDependencies`, and `bundleDependencies`.

Test/dev dependencies, Maven parents, dependency-management imports, build plugins, and Gradle platform/project/file dependencies are excluded. S009 intentionally checks direct declarations only; lockfiles and transitive dependency graphs are not approval evidence, so a missing lockfile does not make the result incomplete.

Unsupported or dynamic production declaration syntax, malformed manifests, unreadable or oversized manifests, unmatched workspace declarations, and traversal limits produce incomplete evidence. Source manifests are SHA-256 hashed in the report. Generated/dependency directories and symlinks are not traversed.

## Deterministic outcomes

- `NOT_APPLICABLE`: no Maven, Gradle, npm, or Yarn dependency project exists.
- `MANUAL`: a dependency project exists but the installed ledger is missing, malformed, non-authoritative, or internally inconsistent; or no definite violation exists but dependency evidence is incomplete.
- `FAIL`: at least one observed `org.folio:*` or `@folio/*` production coordinate has no eligible S009 mapping. A definite violation outranks unrelated incomplete evidence.
- `PASS`: dependency evidence is complete and every observed FOLIO coordinate is eligible. A complete project with no FOLIO candidate dependencies passes.

The checked-in ledger is authoritative and contains the TC-reviewed module and [library baseline](s009-library-baseline.md). Only its exact `libraryCoordinates` are accepted. Every other observed `org.folio:*` or `@folio/*` production dependency fails until the Technical Council explicitly adds that package coordinate. Existing family records, `moduleIdentities`, S008 catalog providers, FAR presence, module-registry publication, Platform inclusion, repository ownership, and package publication do not imply package acceptance.

Ledger changes require TC review; Git history and the evaluator-reported ledger SHA-256 provide provenance. Registry or network availability cannot affect normal S009 evaluation because it performs no remote lookup.
