# Okapi Module Descriptor Schemas

These schemas are vendored from Okapi's RAML schema directory:

https://github.com/folio-org/okapi/tree/master/okapi-core/src/main/raml

Baseline: `folio-org/okapi` `master`, retrieved 2026-06-08.

Root schema source:

https://raw.githubusercontent.com/folio-org/okapi/master/okapi-core/src/main/raml/ModuleDescriptor.json

The TypeScript loader in `index.ts` imports the root schema and every sibling schema referenced by the draft-04 `$ref` closure so packaged builds can validate descriptors offline.
