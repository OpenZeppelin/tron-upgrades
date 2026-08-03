# Examples

Five modules, each self-contained and **type-checked against the real chain surface**.
There is nothing to install: they import from `src/chain` by relative path, exactly as a
sibling sub-feature does.

```sh
# From the package root. Exits 0.
npx tsc -p docs/chain/examples/tsconfig.json
```

The `tsconfig.json` here extends the package's own, so the examples are checked under the
same `strict` and `exactOptionalPropertyTypes` settings as the source. **A snippet that stops
compiling is a documentation bug**, and this is how you find out. This mirrors
[`../../environment/examples/`](../../environment/examples), which established the idiom.

| File | Shows |
|---|---|
| [`01-access-in-an-operation.ts`](./01-access-in-an-operation.ts) | The primary pattern: resolve the `chain` slot, build `ChainAccess`, hand `access.provider` to `Manifest.forNetwork`, narrow both construction failures, memoize per handle |
| [`02-supply-your-own-transport.ts`](./02-supply-your-own-transport.ts) | All four seams of `ChainAccessDependencies`, a `JsonRpcPost` over any HTTP client, and the different-origin case where supplying one is **required** |
| [`03-read-proxy-state.ts`](./03-read-proxy-state.ts) | Every reader union handled exhaustively, the admin/implementation asymmetry, `sameAddress` instead of `===`, and the free-function form |
| [`04-instance-change-and-the-manifest.ts`](./04-instance-change-and-the-manifest.ts) | `identity()`, `compareChainInstance`, `manifestPathFor`, and building the refusal the record layer throws |
| [`05-diagnose-and-narrow-errors.ts`](./05-diagnose-and-narrow-errors.ts) | Narrowing all eleven error classes, `TvmDiagnosis` as a field rather than a message, the policy tables, and `verifyCapabilities` |

## Three things these examples deliberately do not do

**They never pass the host handle to the engine.** `01-access-in-an-operation.ts` carries
`Manifest.forNetwork(env.chain.tronWrap)` in a comment rather than in code — it does not
compile, and the comment records *why* the seam's `TronWrapHandle` must stay `{ trx: object }`.
See [`../safety.md`](../safety.md#the-engine-gets-accessprovider-and-nothing-else).

**They never construct a fake chain handle.** Every example takes `RawMigrationHandles`,
a `ChainAccess`, or an `EndpointDescriptor` + `JsonRpcPost` as a parameter. Fixtures that
model a real handle — including axios's absolute-URL header behaviour, which is what makes
the credential guarantee measurable rather than asserted — live in
`test/helpers/sf-1-chain.ts`.

**They never set a timeout or add a retry.** SF-1 makes exactly one round-trip per `send`
and inherits the timeout the user configured for the network. A `JsonRpcPost` that retried
would make a transport failure look like a slow success, and would return the second
attempt's outcome as if it were the first.

## Where the real fixtures live

For richer fixtures than these, read the suite. `test/helpers/sf-1-chain.ts` ships the handle
fixture, a recording transport, and the identity fixtures. Three suites are worth reading as
usage documentation in their own right:

- `test/sf-1-composite-lifecycle.test.ts` § 8 drives the **real** `Manifest.forNetwork`
  through `access.provider` and shows both refusals reaching upstream and being absorbed.
- `test/sf-1-credential-reachability.test.ts` drives the *forbidden* implementation
  directly — handing an absolute different-origin URL to `fullNode.request` — to prove the
  fixture can observe a leak that does not happen.
- `test/sf-1-diagnosis-and-readers.test.ts` § 8 drives every reader with a bare
  `{ send }` object and no `ChainAccess` in existence.
