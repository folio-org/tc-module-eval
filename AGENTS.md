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

## Criteria
- Follow [Rules for Every Criterion](docs/criterion-notes.md#rules-for-every-criterion) when changing any criterion.
- A change to one criterion must not change another's output. Check by diffing every criterion's full `criterionDetails` JSON against master on real modules.
- Don't change shared `config/*.json` or `src/schemas/` for one criterion; add a separate file or ask.

## Verification
- Routine: `yarn test:unit --runInBand` and `yarn build`. Before every push, run `yarn build && yarn jest --runInBand` on the final commit.
- Run `yarn install --frozen-lockfile` after a rebase or pull that changes `yarn.lock`.
- An intended classification change regenerates `src/__tests__/fixtures/golden-reports/` from a real run.
- Reproduce a reported failure with the CLI against the reported ref before treating it as an evaluator bug.
- Report every reviewer finding left unaddressed and every surviving mutant.

## Tests
- Test scaling with `src/__tests__/helpers/linear-time.ts`, never with wall-clock budgets.
- Use the real `config/` files, not mocked policy.
- Unit tests never use the network; replay fixtures recorded with `yarn capture:remote-fixtures`.
- Assert exact report rows, not substrings.
