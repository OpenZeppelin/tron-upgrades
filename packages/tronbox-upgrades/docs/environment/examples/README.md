# Examples

Four modules, each self-contained and **type-checked against the real seam**. There is
nothing to install: they import from `src/environment` by relative path, exactly as a sibling
sub-feature does.

```sh
# From the package root. Exits 0.
npx tsc -p docs/environment/examples/tsconfig.json
```

The `tsconfig.json` here extends the package's own, so the examples are checked under the
same `strict` and `exactOptionalPropertyTypes` settings as the source. **A snippet that stops
compiling is a documentation bug**, and this is how you find out.

| File | Shows |
|---|---|
| [`01-resolve-in-an-operation.ts`](./01-resolve-in-an-operation.ts) | The primary pattern: resolve inside the operation, ask for the minimum, handle all three `ArtifactResolution` statuses, narrow the three errors, memoize per migration |
| [`02-inject-a-build-info-reader.ts`](./02-inject-a-build-info-reader.ts) | `deps.buildInfoReader` — an in-memory reader, collision and unique fixtures, and a reader per `IndeterminateReason` branch |
| [`03-render-the-slot-table.ts`](./03-render-the-slot-table.ts) | Reading `slotRequirements` instead of hardcoding an invocation-context list |
| [`04-safe-diagnostics.ts`](./04-safe-diagnostics.ts) | Diagnostics that cannot leak a credential, and the `logger.warn` capability probe |

## Two things these examples deliberately do not do

**They never `console.log` or `util.inspect` a host handle.** `04-safe-diagnostics.ts` carries
the unsafe forms in a comment rather than in code, so nothing here can be copied into a leak.
See [`../safety.md`](../safety.md#handles-are-safe-in-serialization-only).

**They never call `logger.warn` directly.** It does not compile, and routing around the type
is a `TypeError` under `--quiet` and under `tronbox test`. The probe in
`04-safe-diagnostics.ts` is the supported form.

## Where the real fixtures live

For richer fixtures than these, read the suite. `test/helpers/` ships plain-object stand-ins
for **both** TronBox `Config` lineages — in both property ownerships, because the seam reads
own properties and prototype members through different primitives — plus `BuildInfoReader`
fixtures for all three `IndeterminateReason` branches and all three packaged-artifact causes.

Two suites are worth reading as usage documentation in their own right:

- `test/performance-and-reuse.test.ts` drives the artifact layer with **no TronBox present at
  all**, via direct module imports. It is the strongest demonstration that the seam is a pure
  projection of its arguments.
- `test/real-tronbox.test.ts` is the only place a composite is built from a real `Config`,
  `Deployer` and `Resolver`, on both 4.9.0 and 4.8.0.
