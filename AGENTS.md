# AGENTS.md

## Comments
- Default to no comment. Never restate the code or a name.
- Keep only: public API contracts, external constraints (protocol, vendor, FOLIO/Okapi behavior), and links explaining a rule code can't express.
- Write for any developer: professional, no possessive language ("your").
- Task history, future plans, and notes about removed code go in the PR or issue, not the code.
- If a comment states a rule, encode it as a test instead.

## Reuse before writing
- Search `src/utils/` for equivalent behavior before adding a helper; reuse only when semantics match.
- `src/utils/` holds shared logic, `src/types/` shared types, `src/tools/` CLI entry points only.
- Don't import from one tool into another; move shared logic to `src/utils/` first.

## Exports
- Keep declarations private unless another module needs them.
- `src/index.ts` is the public API; don't remove its exports for lack of an in-repo importer.
