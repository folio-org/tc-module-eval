# S008 interface acceptance

S008 checks declared required and optional interfaces against a checked-in, reviewed FOLIO/Eureka Platform catalog. Normal evaluation is offline: it reads only the evaluated checkout and evaluator-installed `config` files, and never runs descriptor generators or performs network requests.

Use `--s008-catalog official` (the default) or explicitly select `--s008-catalog development`. A missing, malformed, or non-authoritative selected catalog or acceptance ledger produces `MANUAL`. The repository currently ships deliberately non-authoritative empty seeds because authoritative TC acceptance and reviewed Platform catalog data were not available when S008 was implemented.

## Acceptance ledger

`config/acceptance-ledger.json` is shared with future S009. TC review is required for every change. Family acceptance does not automatically approve Maven or npm packages: each library coordinate is explicit. Module renames, forks, and splits likewise need explicit reviewed `moduleIdentities` mappings.

## Catalog refresh

The maintainer importer does not access the network and never changes the acceptance ledger:

```sh
yarn import:s008-catalog snapshots/manifest.json config/s008-catalog-official.json
```

Before running it, a maintainer must:

1. Select an immutable `folio-org/platform-lsp` commit and record the channel (`official` or `development`).
2. Save the Platform descriptor at that commit and enumerate required and optional application pins, excluding experimental applications.
3. Acquire each exact application version and module descriptor through FAR / `mgr-applications`; retain the immutable FAR source references.
4. Record Platform `eureka-components` as family IDs plus exact normalized module identities.
5. Create a snapshot manifest containing the Platform descriptor path, every application descriptor path and provenance, and every provider descriptor path, normalized module identity, and source.
6. Run the importer twice and confirm byte-identical output. It deliberately writes `authoritative: false`; change that to `true` only after reviewing complete inputs, then commit through normal repository review.

The importer requires a non-zero 40-character Platform commit, hashes every descriptor, copies raw `provides` facts, and sorts output deterministically. Catalog review must confirm that all required and optional applications and all provider facts are present.
