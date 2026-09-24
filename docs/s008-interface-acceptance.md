# S008 interface acceptance

S008 checks declared required and optional interfaces against a checked-in, reviewed FOLIO/Eureka Platform catalog. Normal evaluation is offline: it reads only the evaluated checkout and evaluator-installed `config` files, and never runs descriptor generators or performs network requests.

Use `--s008-catalog official` (the default) or explicitly select `--s008-catalog development`. A missing, malformed, or non-authoritative selected catalog or acceptance ledger produces `MANUAL`. The checked-in official catalog is the reviewed R1-2026 GA Platform baseline at its immutable Platform LSP commit. The acceptance ledger records the TC-authorized `platform-lsp` legacy baseline; Eureka component eligibility remains catalog-derived rather than permanent ledger acceptance.

## Acceptance ledger

`config/acceptance-ledger.json` is shared with future S009. TC review is required for every change. Family acceptance does not automatically approve Maven or npm packages: each library coordinate is explicit. Module renames, forks, and splits likewise need explicit reviewed `moduleIdentities` mappings. The current legacy baseline intentionally has no library coordinates.

## Catalog refresh

Normal evaluation never accesses the network. Catalog acquisition is a separate maintainer-only command and requires an explicit immutable Platform LSP commit:

```sh
yarn acquire:s008-catalog \
  --platform-commit <40-character-commit> \
  --channel official \
  --output-dir /tmp/s008-acquisition
```

The command fetches `platform-descriptor.json` from exactly that commit and resolves only the required and optional (not experimental) application pins through FAR. FAR-embedded backend and UI descriptors are used when their identities match; otherwise the exact module ID is fetched from the configured registry. For Eureka components, Keycloak, Kong, and Module Sidecar are recorded as intentionally descriptorless infrastructure. The three manager services use an allowlisted `folio-org` repository, exact `v<Platform version>` tag, peeled immutable commit, and fixed `src/main/resources/descriptors/ModuleDescriptor.json` path. Their raw descriptor IDs are preserved even when they differ from the Platform component version. The command never follows descriptor-supplied URLs, chooses “latest,” executes repository code, or reads credentials from the evaluated repository.

Public defaults are `https://far.ci.folio.org` and `https://folio-registry.dev.folio.org`. Maintainers may use `--far-url` and `--registry-url` for trusted environments. Overrides must use HTTPS; HTTP is accepted only for loopback test fixtures. Authentication is not supported, and 401/403 responses are reported clearly.

The output directory must not already exist. It is published atomically and contains:

- normalized Platform, FAR application, and provider descriptor snapshots;
- `snapshot-manifest.json` with exact provenance;
- `s008-catalog.json`, always generated with `authoritative: false`;
- `s008-discovered-identities.json`, whose family/display/repository hints are explicitly unreviewed; and
- `acquisition-diagnostics.json`, where `complete: false` identifies material acquisition gaps.

The command never creates or modifies `config/acceptance-ledger.json`. Platform or FAR presence is not evidence of TC acceptance. A human must use the discovery report to prepare reviewed family, identity, repository, and APPROVED / PROVISIONALLY APPROVED / legacy / scoped-exception evidence changes. Those changes require TC review. After confirming complete diagnostics and reviewing all snapshots, a maintainer may copy the reviewed catalog to the appropriate checked-in catalog and mark it authoritative through normal repository review.

For already-acquired or manually supplied snapshots, the lower-level offline importer remains available:

```sh
yarn import:s008-catalog snapshots/manifest.json config/s008-catalog-official.json
```

Before running the offline importer, a maintainer must:

1. Select an immutable `folio-org/platform-lsp` commit and record the channel (`official` or `development`).
2. Save the Platform descriptor at that commit and enumerate required and optional application pins, excluding experimental applications.
3. Acquire each exact application version and module descriptor through FAR / `mgr-applications`; retain the immutable FAR source references.
4. Record Platform `eureka-components` as family IDs plus exact normalized module identities.
5. Create a snapshot manifest containing the Platform descriptor path, every application descriptor path and provenance, and every provider descriptor path, normalized module identity, and source.
6. Run the importer twice and confirm byte-identical output. It deliberately writes `authoritative: false`; change that to `true` only after reviewing complete inputs, then commit through normal repository review.

The importer requires a non-zero 40-character Platform commit, hashes every descriptor, copies raw `provides` facts, and sorts output deterministically. Catalog review must confirm that all required and optional applications and all provider facts are present.
