# Live e2e coverage report

## Public readers and warning silencing

- `e2e/consumer/migrations/4_beacon.js` now reads the beacon address from the live beacon proxy and the implementation address from the live beacon, requires canonical 34-character base58 results, and compares each result by canonical address identity with the corresponding deployment result.
- `e2e/consumer/migrations/6_uups_and_options.js` now reads the implementation and admin slots from the live UUPS proxy. It requires canonical base58 output, matches the implementation reader to the upgrade result by canonical address identity, and requires the admin reader to return the base58 zero address.
- The reader asymmetry is intentional: the UUPS proxy has a populated implementation slot, so the implementation reader must return the upgraded implementation; its empty admin slot returns the zero address rather than throwing. The beacon proxy has a populated beacon slot, while the beacon reader resolves the implementation through `implementation()`. No assertion asks the implementation or beacon slot readers to smooth an empty slot into zero.
- The linked-library acceptance calls `silenceWarnings()` immediately before the allowed validation. The returned degraded note proves the engine advisory was still captured, while `e2e/run.mjs` requires the advisory text to be absent from both migration outputs.

## Reuse-only refusal

- `e2e/consumer/contracts/BoxNever.sol` supplies a bytecode-distinct, storage-compatible implementation that is never normally deployed.
- Migration 6 attempts to upgrade the live transparent proxy to `BoxNever` with `redeployImplementation: 'never'`, requires `implementation-not-previously-deployed`, and reports only that refusal code.
- `e2e/run.mjs` requires the refusal on both runs and rejects any additional `m6.never.*` report field, so the refused path introduces no reported deployment address.

## Linked-library verdict

- `e2e/consumer/contracts/BoxLinked.sol` calls a public library function, producing a real unresolved external-library link reference.
- Migration 6 first requires the real validation engine to reject the artifact with a diagnosis naming external libraries and `LinkedMath`.
- The same artifact is then accepted with the single `unsafeAllow: ['external-library-linking']` use. Both refusal and acceptance, plus the retained warning-note count, are asserted on both runs.

## Verification

- A local `tronbox/tre` container was available and the full packed-consumer harness ran against it with a funded quickstart account.
- `E2E_PRIVATE_KEY=<funded TRE quickstart key> npm run test:e2e` passed: pack, install, compile, migrate, independent node verification, replay, and `tronbox test`.
- `node --check` passed for `e2e/consumer/migrations/4_beacon.js`, `e2e/consumer/migrations/6_uups_and_options.js`, and `e2e/run.mjs`.
- Live verification is complete locally; CI is not carrying deferred TRE verification for this change.

## Draft reply note

Added live packed-consumer coverage for the base58 readers and warning silencing, pre-spend reuse-only refusal, and one real linked-library validation verdict flip, with both migration runs passing against TRE.
