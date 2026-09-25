# S009 FOLIO library acceptance baseline

This document records the one-time Technical Council review used to seed exact Maven and npm package coordinates for S009. The canonical, machine-readable decisions are the `families` and `libraryCoordinates` entries in `config/acceptance-ledger.json`; this document records their review basis and discovery provenance.

The baseline was approved on 2026-09-24. It contains 143 exact coordinates: 88 Maven `org.folio:*` artifacts and 55 npm `@folio/*` packages. Those coordinates add 37 families and map 26 client, DTO, and plugin coordinates to families already accepted by the module baseline. Package versions are provenance, not part of acceptance.

## Review decisions

- The Trillium-named RAML Module Builder, FOLIO Spring Support, FOLIO Vert.x Library, Edge Common, Edge Common Spring, FOLIO S3 Client, and Stripes families are accepted as legacy baseline libraries.
- All identified reusable RMB, Spring Support, and Vert.x artifacts are included. Example, integration-test, and deployable-module artifacts are excluded. Historical `spring-module-core` artifacts map to FOLIO Spring Support.
- All 29 published `@folio/stripes*` coordinates are in the Stripes family, including current, domain, build, testing, and legacy packages.
- The linked-data MARC4LD, Fingerprint, and RDF4LD families are approved under [TCR-47](https://github.com/folio-org/tech-council/blob/1417e7c959eec98e0aa4d43de5b1307c33cd729c/module_evaluations/TCR-47_2024-11-19-lib-linked-data-marc4ld.MD), [TCR-48](https://github.com/folio-org/tech-council/blob/1417e7c959eec98e0aa4d43de5b1307c33cd729c/module_evaluations/TCR-48_2024-12-16-lib-linked-data-fingerprint.MD), and [TCR-58](https://github.com/folio-org/tech-council/blob/1417e7c959eec98e0aa4d43de5b1307c33cd729c/module_evaluations/TCR-58_2025-07-23-lib-linked-data-rdf4ld.MD).
- Maintained standalone producers found during the review are legacy-baseline families. Old and current Data Import Utils artifacts form one family.
- Client and DTO contracts produced by accepted deployable modules map to those existing module families. Other reusable module-produced artifacts—Job Profile Wrangler, Record Specifications Validator, and Workflow Components—are standalone legacy families.
- Existing plugin coordinates map to their existing `folio_plugin-*` families. Seven published plugins without an existing family receive standalone legacy families. This includes archived aliases and the two published Markdown example packages.
- Acceptance is an exact allowlist. Family presence, repository ownership, publication, module identity, Platform membership, or S008 catalog membership never implies acceptance for an unlisted coordinate.

## Evidence and discovery method

The review enumerated 469 `folio-org` repositories, default-branch Maven/npm producer manifests, and the FOLIO Nexus release repositories. Maven discovery covered 9,011 released components representing 232 distinct `org.folio` artifact IDs. npm discovery enumerated the complete 3,738-component `npm-folio` repository and then compared the accepted sets against publication data. The final comparisons exactly matched all 29 published `@folio/stripes*` coordinates and all 25 published `@folio/plugin-*` coordinates; both set differences were empty.

Producer identity was checked against immutable source revisions. The accepted family evidence includes:

- [Applications PoC Tools](https://github.com/folio-org/applications-poc-tools/tree/36cfa69e5d0b7bed5c6bbda53ef9285d6cece962), [Data Import Processing Core](https://github.com/folio-org/data-import-processing-core/tree/8ae8d983859992177fce7dda99ed6f2c838a4f28), and [Data Import Utils](https://github.com/folio-org/data-import-utils/tree/853543b095b87d40c8eab5bccad45908ac0646cd)
- [Edge API Utils](https://github.com/folio-org/edge-api-utils/tree/22fa91b648d454bda6583c783e93bf6b44fde739), [Edge Common](https://github.com/folio-org/edge-common/tree/9ca2aa1a1cb290ed42f60aee0416003657f0e8aa), and [Edge Common Spring](https://github.com/folio-org/edge-common-spring/tree/ad5d9c35620d3f52c324e27d2b3aa5e6c6b81e35)
- [FOLIO Custom Fields](https://github.com/folio-org/folio-custom-fields/tree/fa387116bc491f4f9654f6bffa8950060ce942f6), [DI Support](https://github.com/folio-org/folio-di-support/tree/83dc1d073b7cea957406becca0ddf7ba9e94bd08), [Flow Engine](https://github.com/folio-org/folio-flow-engine/tree/792eb7dcdc38f0075d627ee7ea39da0bb8666e80), [HoldingsIQ Client](https://github.com/folio-org/folio-holdingsiq-client/tree/48887cd423f0c9338f1d92cd8bfdb8491cc592ed), [ISBN Utils](https://github.com/folio-org/folio-isbn-util/tree/47cc71ed2acdf4d2cb3f482890ad2413d40b4aa1), [Kafka Wrapper](https://github.com/folio-org/folio-kafka-wrapper/tree/fdd70447e3acd14603ad050fa961dc2e101d7ca2), [Liquibase Utils](https://github.com/folio-org/folio-liquibase-util/tree/5a5e374ad785c9c24fc85cad90c4254c7213728a), [Query Tool Metadata](https://github.com/folio-org/folio-query-tool-metadata/tree/ef38484ba9475e296e2ff72639fbc2e8d389130c), [S3 Client](https://github.com/folio-org/folio-s3-client/tree/e70b8a6d9398cd28766223d502a056fc713e135e), and [Service Tools](https://github.com/folio-org/folio-service-tools/tree/43ea3b151329ee4bc21208d74f663b17de06474c)
- [FOLIO Spring Support](https://github.com/folio-org/folio-spring-support/tree/ec7ad91e1d4f537c50fec054330c4f3a1029c9bf), [FOLIO Vert.x Library](https://github.com/folio-org/folio-vertx-lib/tree/320a0b0aeec9169384aa7541d4fd17f10c44163f), [RAML Module Builder](https://github.com/folio-org/raml-module-builder/tree/169f31f898d9e124eb6cd5cec89fc373fe16b837), and [Stripes](https://github.com/folio-org/stripes/tree/85d7886ec72d5c2135cc0c08322b50635eea338e)
- [Generate MARC Utils](https://github.com/folio-org/generate-marc-utils/tree/3825a552956bd68390014eb6be20dd7ae7a09920), [Job Profile Wrangler producer](https://github.com/folio-org/mod-di-converter-storage/tree/c9ac2391d50e5368cd6648c0396a7a0c649f5a4b), [FQM Query Processor](https://github.com/folio-org/lib-fqm-query-processor/tree/ba03be48e3ebe22c5d500980d4b43ce10ed98700), [Linked Data Dictionary](https://github.com/folio-org/lib-linked-data-dictionary/tree/cc944fccac4a6a2654a3bd5e2d32ad4634189cb8), [Record Specifications](https://github.com/folio-org/mod-record-specifications/tree/2a727cefbc342405024753dc2ebb89ed6aa04025), [React Intl Safe HTML](https://github.com/folio-org/react-intl-safe-html/tree/1e38d8e174d4baab763062ceb6c8de72e7a4f550), and [Workflow Components producer](https://github.com/folio-org/mod-workflow/tree/55b5eccac7f9b29aa99791ffac2b39a5cd3c629f)
- New plugin-family evidence came from immutable manifests for [Create Item](https://github.com/folio-org/ui-plugin-create-item/blob/554574a65024e04ddb380a88cc9782ac68d3e63a/package.json), [finc Metadata Collection](https://github.com/folio-org/ui-plugin-find-finc-metadata-collection/blob/eb8962746062e589b30dfdd7cb1c85bfdcbe1d5a/package.json), [finc Metadata Source](https://github.com/folio-org/ui-plugin-find-finc-metadata-source/blob/0deaf78c6ac74d4b8ae783b247878b28f2eb6cf2/package.json), [Find Vendor](https://github.com/folio-org/ui-plugin-find-vendor/blob/8b86d681a88eb5d0dea6dbecca8a799bc2f8b31e/package.json), [the two Markdown packages](https://github.com/folio-org/ui-plugin-example/tree/c986d42d13aae2bcc448c610dc0008dd5e83f7a0), and [Select Application](https://github.com/folio-org/ui-plugin-select-application/blob/8f78025e57b245cc61de4208a7961a1470f847df/package.json). Existing plugin-family IDs were checked against the module baseline before mapping.

Released Maven coordinates were additionally checked against their POMs under `https://repository.folio.org/repository/maven-releases/org/folio/`. Two classes use immutable producer evidence instead: `folio-spring-kafka` and the newly split Data Import Utils coordinates were present in current producer manifests but not historical Nexus releases.

## Explicit exclusions

| Candidate | Reason |
| --- | --- |
| `@folio/stripes-registry` | A historical producer manifest exists, but no scoped publication was found. |
| `@folio/stripes-sample-platform` | A producer manifest exists, but no scoped publication was found. |
| `@folio/stripes-vendor-dll` | A producer manifest exists, but no scoped publication was found. |
| `folio-org/stripes-component-number-generator` | No package manifest or published `@folio/stripes*` coordinate was found. |
| `org.folio:domain-models-runtime-it` | RMB integration-test artifact. |
| `org.folio:folio-core-schema` | Historical orphan with unresolved provenance; not accepted. |
| `org.folio:mod-example` | Deployable Vert.x example module. |
| `org.folio:vertx-lib-example` | Vert.x example artifact. |

Future additions or mapping changes require TC review and a direct edit to the canonical acceptance ledger. Discovery output is evidence only and must never be applied as acceptance automatically.
