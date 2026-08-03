# API reference — `src/environment`

Every export of `src/environment/index.ts`, with full TypeScript signatures. Import from
the directory, never from a module inside it:

```ts
import { resolveEnvironment, type TronBoxEnvironment } from '../environment';
```

Everything here is **synchronous**. Nothing in this seam returns a `Promise`, registers a
callback, or starts a timer (INV-38).

---

## Contents

- [Entry point](#entry-point) — `resolveEnvironment`, `EnvironmentDependencies`
- [The composite](#the-composite) — `TronBoxEnvironment`, `EnvironmentProvenance`
- [Slot shapes](#slot-shapes) — `ProjectPaths`, `NetworkEnvironment`, `ArtifactAccess`, `ChainHandleSlot`, `ReceiptSlot`, `SchedulingSlot`, `OutputChannelSlot`
- [Artifact resolution](#artifact-resolution) — `ArtifactResolution`, `ArtifactAmbiguityReport`, `IndeterminateReason`
- [The build-info reader](#the-build-info-reader) — `BuildInfoReader`, `buildArtifactAmbiguityIndex`, `fileSystemBuildInfoReader`, `normalizeArtifactName`
- [Errors](#errors) — the three-member family, plus `ArtifactNameAmbiguousError`
- [The slot table](#the-slot-table) — `slotNames`, `slotRequirements`
- [Cross-check field lists](#cross-check-field-lists)
- [Constants and helpers](#constants-and-helpers)
- [Handle types](#handle-types)
- [Branded types](#branded-types)

---

## Entry point

### `resolveEnvironment(handles, spec, deps?)`

```ts
function resolveEnvironment<
  const R extends readonly SlotName[],
  const O extends readonly SlotName[] = readonly [],
>(
  handles: RawMigrationHandles | undefined,
  spec: { readonly require: R; readonly optional?: O },
  deps: EnvironmentDependencies = {},
): TronBoxEnvironment<R[number], O[number]>;
```

Resolves the TronBox environment for the current migration, returning a frozen composite
carrying exactly the slots requested plus `provenance`.

**`handles` (`RawMigrationHandles | undefined`)** — the migration's own globals. Every
member is `unknown`, because these cross a trust boundary out of a `vm` sandbox and typing
them as their expected shapes would assert exactly what the shape guards exist to check
(INV-25):

```ts
interface RawMigrationHandles {
  readonly deployer?: unknown;
  readonly artifacts?: unknown;
  readonly tronWrap?: unknown;
  readonly tronWeb?: unknown;
  readonly waitForTransactionReceipt?: unknown;
}
```

A handle counts as **supplied** when it is anything other than `undefined` —
`src/environment/handles.ts:supplied`. Passing `undefined` for `handles` itself is
equivalent to passing `{}`.

**`spec.require` (`R`)** — slots that must be present. Each appears as a non-optional
member of the return type. Duplicates are deduplicated.

**`spec.optional` (`O`)** — slots that may be present. Each appears as an optional member.
A slot named in both lists is treated as required, and is removed from the optional set. An
optional slot that cannot be constructed is simply absent, and `provenance.slots` says so —
it never fails the resolution.

**`deps` (`EnvironmentDependencies`)** — the seam's one injected dependency:

```ts
interface EnvironmentDependencies {
  readonly buildInfoReader?: BuildInfoReader;
}
```

Defaults to `fileSystemBuildInfoReader`. Only the `artifacts` slot consults it.

**Returns:** `TronBoxEnvironment<R[number], O[number]>` — frozen. Every required slot is an
own property; unrequested slots are absent from both the value and the type.

**Throws:**

- `EnvironmentAbsentError` (`code: 'TRONBOX_ENV_ABSENT'`) — no handle bearing on any
  requested slot was supplied. Note the guard is skipped entirely when `require` and
  `optional` are both empty.
- `EnvironmentIncompleteError` (`code: 'TRONBOX_ENV_INCOMPLETE'`) — a **required**
  capability could not be constructed.
- `EnvironmentInconsistentError` (`code: 'TRONBOX_ENV_INCONSISTENT'`) — every required
  capability was constructed and the sources disagree.

The three are strictly ordered: `absent`, then `incomplete`, then `inconsistent`
(INV-11). A disagreement is never reported while a required capability is still
unconstructible.

> **`const` type parameters require TypeScript ≥ 5.0** (INV-46). Without them the literal
> array widens to `SlotName[]` and every slot becomes present in the type, which discards
> the whole point of `spec`.

Source: `src/environment/resolve.ts:resolveEnvironment`.

---

## The composite

### `TronBoxEnvironment<R, O>`

```ts
type TronBoxEnvironment<
  R extends SlotName = SlotName,
  O extends SlotName = never,
> = {
  readonly [K in R]: SlotShapes[K];
} & {
  readonly [K in O]?: SlotShapes[K];
} & {
  readonly provenance: EnvironmentProvenance;
};
```

The default type parameters describe a composite with **every** slot required — useful as
an annotation for code that resolves all seven, and wrong as an annotation for anything
else. Prefer inference from the call.

### `EnvironmentProvenance`

```ts
interface EnvironmentProvenance {
  readonly slots: Readonly<Record<SlotName, 'present' | 'absent'>>;
  readonly configLineages: ConfigLineageProvenance;
  readonly internalPathsRead: readonly string[];
}
```

`slots` reports all seven names regardless of what was requested. `internalPathsRead`
covers this `resolveEnvironment` call only — reads performed by a later `resolve()` or
`ambiguities()` call are outside the snapshot.

### `ConfigLineageProvenance`

```ts
interface ConfigLineageProvenance {
  readonly viaDeployer: ConfigLineageBinding;
  readonly viaArtifacts: ConfigLineageBinding;
  readonly crossChecked: boolean;
  readonly crossCheckSkippedBecause?:
    | 'only-deployer-lineage-available'
    | 'only-artifacts-lineage-available';
  readonly sameObject: boolean;
}

type ConfigLineageBinding = 'live-config' | 'materialized-snapshot' | 'absent';
```

Both lineages are inspected unconditionally — four property reads — so this describes what
was *reachable*, not what this particular slot list happened to look at.

- `crossChecked` is `false` exactly when fewer than two lineages were reachable, and
  `crossCheckSkippedBecause` names which one was available. Neither is inferable from the
  other fields, which is why both are reported (INV-34 mode 1).
- `sameObject` is `true` under `tronbox migrate`, where both lineages are one object.
- The binding is decided by whether the lineage computes its values on read:
  `working_directory` is an own **accessor** on a live `Config` and an own **data property**
  on a `Config.prototype.with` snapshot. Verified on 4.9.0 and 4.8.0 —
  `src/environment/config-lineage.ts:classifyBinding`.

---

## Slot shapes

```ts
interface SlotShapes {
  readonly paths: ProjectPaths;
  readonly network: NetworkEnvironment;
  readonly artifacts: ArtifactAccess;
  readonly chain: ChainHandleSlot;
  readonly receipts: ReceiptSlot;
  readonly scheduling: SchedulingSlot;
  readonly output: OutputChannelSlot;
}

type SlotName =
  | 'paths' | 'network' | 'artifacts' | 'chain'
  | 'receipts' | 'scheduling' | 'output';
```

### `ProjectPaths`

```ts
interface ProjectPaths {
  readonly root: AbsolutePath;
  readonly contractsDirectory: AbsolutePath;
  readonly contractsBuildDirectory: AbsolutePath;
  readonly buildInfoDirectory: AbsolutePath;
  readonly contractsBuildDirectoryIsExternal: boolean;
}
```

All four paths are asserted absolute **independently** rather than trusting `root`. TronBox
applies a path key's `transform` on set but calls its `default()` on get, and every path
default is a bare `path.join(self.working_directory, …)` that never passes through
`transform` — so absoluteness on a defaulted key is inherited rather than enforced. And
`working_directory` is itself declared as a bare no-op in the `props` map and is absent from
`Config.prototype.merge`'s `strictPathKeys`, so a `tronbox.js` declaring
`working_directory: '../shared'` silently replaces the absolute value.

Nothing is normalized — values pass through byte for byte, so a cross-lineage comparison
sees what the tool holds.

`contractsBuildDirectoryIsExternal` is **observed by containment**, never inferred from the
invoking command (INV-3). `build_info_directory` escaping the project root is a violation
rather than a supported configuration and yields an `invariant-violated` failure;
`contracts_build_directory` escaping is legal, which is how
`build/lib/commands/test.js` points the build tree at a temporary directory.

Source: `src/environment/paths.ts:buildProjectPaths`.

### `NetworkEnvironment`

```ts
interface NetworkEnvironment {
  readonly name: string;
  readonly artifactNetworkId: string;
  readonly configuredId: {
    readonly value: string;
    readonly syntax: 'exact' | 'wildcard';
  };
  readonly txDefaults: NetworkTxDefaults;
  readonly sender: NonAuthoritativeSender;
  readonly signingKeyConfigured: boolean;
}

interface NetworkTxDefaults {
  readonly feeLimit: number | null;
  readonly userFeePercentage: number | null;
  readonly originEnergyLimit: number | null;
  readonly callValue: number | null;
  readonly tokenValue: number | null;
  readonly tokenId: number | null;
}

interface NonAuthoritativeSender {
  readonly kind: 'configured-not-authoritative';
  readonly address: string | null;
}
```

Five things about this slot that will bite a consumer who assumes otherwise:

1. **`artifactNetworkId` is compatibility metadata about the tool, never evidence about the
   chain.** It is what keys the `networks` map of every saved artifact. If you need to know
   which chain you are actually talking to, ask the chain.
2. **`configuredId.syntax` is derived by strict equality against `'*'`** — never a
   truthiness or regex test — so `'**'` and `'*3'` are `'exact'` (INV-6). `'*'` is legal
   and TronBox never resolves it.
3. **`sender` is wrapped in an object whose `kind` states the caveat**, so a call site
   cannot skip it (INV-7). The effective sender is chosen at send time —
   `TronWrap._getAccounts` replaces `_accounts` wholesale on a TRE node while resetting
   `privateKeyByAccount` — so an authority preflight against this address can pass while
   the transaction sends from a different account.
4. **`txDefaults` members are `null` where TronBox resolved nothing**, and TronBox's own
   `||` chains treat a configured `0` as absent: with `callValue: 0` merged in from
   `deployParameters`, `config.callValue` reads `undefined`, hence `null` here. An
   upstream `undefined` always becomes `null`, never the reverse (INV-4).
5. **`signingKeyConfigured` is derived from presence alone and is never the key**
   (INV-40). It is a boolean by construction. `Config`'s own top-level `privateKey` getter
   is hardcoded to return `null`, so it is useless as a presence check — the real key lives
   on the network entry.

**A misspelled network name is refused, not defaulted.** The selected network is validated
against the `networks` map itself before any derived getter is read (INV-16), because
TronBox's `network_config` getter throws only when the selected network is *falsy* — a name
merely absent from `networks` yields `_.extend({}, default_tx_values, self.networks[network] || {})`,
which is pure defaults with no error at all. Reading the getters cannot tell that apart from
a real configuration; checking `networks` can. Verified on 4.9.0 and 4.8.0.

Source: `src/environment/network.ts:buildNetworkEnvironment`.

### `ArtifactAccess`

```ts
interface ArtifactAccess {
  resolve(name: string): ArtifactResolution;
  resolvePackaged(packageRelativePath: string): ContractAbstraction;
  ambiguities(): ArtifactAmbiguityReport;
  readonly intercept: ResolverInterceptHandle;
}
```

#### `resolve(name)`

```ts
resolve(name: string): ArtifactResolution
```

Resolves a bare contract name through the injected `ResolverIntercept` and reports whether
the name is unambiguous across the project's build info.

The name is normalized by `normalizeArtifactName` first. Resolution happens **before** the
ambiguity index is touched, so a name that does not resolve at all fails with its own
diagnosis rather than after megabytes of build-info I/O.

**Never returns nullish.** Three statuses, and only the verified branch names the
abstraction `contract` — see [`ArtifactResolution`](#artifactresolution).

**Throws** `EnvironmentIncompleteError` with an `invariant-violated` cause when:

- `name` is not a string;
- every resolver source reported no artifact (the host's `Resolver.prototype.require`
  threw);
- a resolver source returned no usable artifact object (the host signals failure by
  returning `null`);
- the abstraction carries no `sourcePath` and no build-info entry names one either.

For the first two, a name containing a path separator gets an added hint pointing at
`resolvePackaged`, because TronBox's filesystem resolver returns nothing for such a name
unless it ends in `.json`.

#### `resolvePackaged(packageRelativePath)`

```ts
resolvePackaged(packageRelativePath: string): ContractAbstraction
```

Loads a JSON artifact from an installed package under `node_modules`. **Returns a
`ContractAbstraction` or throws — never nullish** (INV-18).

TronBox's own `FS.prototype.requireJson` collapses three different causes into one `null`.
This method separates them, deciding each with the least capability that can decide it, in
this order:

| Order | Cause | Decided by | Cost |
|---|---|---|---|
| 1 | The path escapes the project | pure path arithmetic | zero I/O |
| 2 | The file is missing | the reader's `exists` probe | one stat-class call |
| 3 | The file is malformed | existence **and** the host's failure | — |

Deciding containment first is what guarantees an escaping path is never probed. The probe
runs only after the host has already failed, so **the happy path performs no filesystem
access at all.**

Accepted paths must be relative, must not begin with `./`, must not escape upwards, must
not be empty, must contain no NUL byte, and must end in `.json`. These refusals subsume
TronBox's own containment test rather than reproducing it.

**Throws** `EnvironmentIncompleteError` with an `invariant-violated` cause and one of four
distinct remedies:

- the path is not a valid packaged path (escaping, absolute, `./`-prefixed, empty, NUL, or
  not `.json`) — fix the argument;
- *"does not exist at `<hostPath>`. Nothing is installed at the path TronBox resolves, so
  install or update the package that provides the artifact."*;
- *"exists at `<hostPath>` but TronBox could not load it: the file is unreadable or is not
  valid JSON. Reinstall the package that provides it, or check its permissions."*;
- the injected reader's existence probe itself threw, *"so the seam cannot say whether the
  file is missing or malformed."* Unreachable through `fileSystemBuildInfoReader`, whose
  probe cannot throw.

`<hostPath>` is `path.join(paths.root, 'node_modules', validated)` — reproduced from
`requireJson`'s own arithmetic so the message names a real location rather than the
caller's argument.

> **`EACCES` diagnoses as missing.** The default probe is `fs.existsSync`, chosen because
> it is stat-class *and* cannot throw, so an unreadable parent directory answers "not
> there" rather than escaping as an untranslated host failure (INV-15). The recorded cost
> is that a permission-denied path is reported as absent. This is the same direction
> TronBox's own resolver collapses it in.

#### `ambiguities()`

```ts
ambiguities(): ArtifactAmbiguityReport
```

The bare-name collision report for the whole project. The index behind it is **lazy and
computed at most once**, memoized per `ArtifactAccess` instance — never at module scope,
which would carry a stale index across migrations and, under `tronbox test`, index a build
tree the run has already replaced (INV-23).

#### `intercept`

```ts
readonly intercept: ResolverInterceptHandle
```

The host `ResolverIntercept`, handed over by name. **This is the write-back path — never
substitute `config.resolver`** (INV-24).
`build/components/Resolver/intercept.js:ResolverIntercept.prototype.contracts` returns
exactly `Object.keys(this.cache).map(key => this.cache[key])`, and that set is what
`artifactor.saveAll` writes back at the end of the migration. An abstraction obtained from
a fresh resolver is functionally identical and absent from that cache, so it works for the
whole operation and its address is then silently missing from the artifact.

Source: `src/environment/artifacts.ts:createArtifactAccess`.

### `ChainHandleSlot`

```ts
interface ChainHandleSlot {
  readonly tronWrap: TronWrapHandle;
}

interface TronWrapHandle {
  readonly trx: object;
}
```

**One name.** Both `tronWrap` and `tronWeb` are accepted as inputs and normalized one-way
to `tronWrap`; `tronWeb` is never re-exported (INV-27). TronBox builds the sandbox with
`tronWeb: tronWrap`, so the misleading name is the host's. If both are supplied and they
are **not** the same object, that is an `EnvironmentInconsistentError`
(`chain-handle-conflict`) rather than a preference.

`trx` is read through property access, never a descriptor: the `TronWebProxy`'s `get` trap
returns a bound sub-module proxy while the descriptor exposes the raw one.

### `ReceiptSlot`

```ts
interface ReceiptSlot {
  readonly waitForTransactionReceipt: WaitForTransactionReceipt;
}

type WaitForTransactionReceipt = (...args: unknown[]) => unknown;
```

Accepted only when `typeof handle === 'function'`.

### `SchedulingSlot`

```ts
interface SchedulingSlot {
  readonly deployer: DeployerHandle;
}

interface DeployerHandle {
  then(step: (...args: unknown[]) => unknown): unknown;
}
```

INV-29's one deliberate exception: the whole deployer, named as such, because SF-4 needs
the queue. `then` is probed with `in` because it lives on `Deployer.prototype`.

> **Do not log or `util.inspect` this handle.** See
> [`safety.md`](./safety.md#handles-are-safe-in-serialization-only).

### `OutputChannelSlot`

```ts
interface OutputChannelSlot {
  readonly logger: TronBoxLogger;
  readonly origin: 'deployer' | 'config-lineage';
  readonly hostQuietRequested: boolean;
}

interface TronBoxLogger {
  log(...args: unknown[]): void;
}
```

`logger` is `deployer.logger` when a deployer was supplied, else the Config lineage's
`logger`. `origin` reports which applied, so the choice is a statement rather than a silent
preference.

**This slot makes no visibility claim.** Neither `origin` value implies output is visible,
and neither implies it is discarded:

- `origin: 'config-lineage'` may be TronBox's own `{ log(){} }` default —
  `build/components/Config.js:Config` defaults `logger` to a noop.
- `origin: 'deployer'` is no better. `build/lib/commands/migrate.js:command.run` replaces
  the logger *before* `Config.detect`, and `build/lib/test.js:Test.performInitialDeploy`
  passes `{ log(){} }`. A discarding channel is the **normal case in two of the five
  invocation contexts**, with no flag involved.

`hostQuietRequested` is read from the lineage matching `origin`, never mixed across
lineages, and is **not** a cross-checked field. Under `tronbox test` the two lineages
genuinely disagree — the deployer's snapshot carries `quiet: true` while the live Config
the resolver holds carries no `quiet` key at all — so comparing it would throw
`EnvironmentInconsistentError` on every `tronbox test` run. Absence means `false`. And
`false` does not imply output is visible.

SF-10 owns the output and warning channel outright; degraded-mode statements ride the
returned result and failures ride typed errors, with logging advisory only. Do not build a
visibility decision on this slot.

Source: `src/environment/output.ts:outputFromHandles`.

---

## Artifact resolution

### `ArtifactResolution`

```ts
type ArtifactResolution =
  | { readonly status: 'unique';
      readonly name: string;
      readonly contract: ContractAbstraction;
      readonly sourcePath: string }
  | { readonly status: 'ambiguous';
      readonly name: string;
      readonly candidates: readonly ArtifactCandidate[];
      readonly unverifiedContract: ContractAbstraction }
  | { readonly status: 'indeterminate';
      readonly name: string;
      readonly reason: IndeterminateReason;
      readonly unverifiedContract: ContractAbstraction };
```

**Only the verified branch names the abstraction `contract`.** The asymmetric field name is
the enforcement, not a convention: storing an unverified abstraction into a `contract`-typed
position is impossible without renaming it (INV-5).

`status: 'unique'` asserts that the index is complete and holds no bare-name collision for
this name — including the zero-candidate case, where the index simply has no entry and the
source path falls back to the abstraction's own. The index deliberately assesses no
freshness; that is SF-2's concern.

`status: 'ambiguous'` is **detection only**. Policy for that branch belongs to SF-5, and
`ArtifactNameAmbiguousError` is exported for SF-5 to throw.

### `ArtifactCandidate` / `ArtifactNameCollision`

```ts
interface ArtifactCandidate {
  readonly sourcePath: string;
  readonly contractName: string;
  readonly buildInfoFile: AbsolutePath;
}

interface ArtifactNameCollision {
  readonly name: string;
  readonly candidates: readonly ArtifactCandidate[];
}
```

Identifiers and paths only — never the compiled output the name maps to (INV-42).

### `ArtifactAmbiguityReport`

```ts
type ArtifactAmbiguityReport =
  | { readonly status: 'indexed';
      readonly collisions: readonly ArtifactNameCollision[];
      readonly indexedFrom: readonly AbsolutePath[] }
  | { readonly status: 'indeterminate';
      readonly reason: IndeterminateReason };
```

`status: 'indexed'` asserts that **every** output file under `buildInfoDirectory` was read
and contributed (INV-36). The first unusable entry aborts into `indeterminate` naming that
file — there is no partially-indexed report and no per-file skip, because a partial union
under an `indexed` label is a false negative in the collision check, and false negatives
are the failure this index exists to prevent. False positives are the accepted direction:
they are visible, since each candidate names its source path and originating build-info
file.

Ordering is fully determined (INV-21) — candidates by source path, then contract name, then
build-info file; collisions by name — so two calls over the same inputs produce deep-equal
reports.

### `IndeterminateReason`

```ts
type IndeterminateReason =
  | { readonly kind: 'build-info-absent';
      readonly buildInfoDirectory: AbsolutePath;
      readonly artifactTreeIsExternal: boolean }
  | { readonly kind: 'build-info-unreadable';
      readonly file: AbsolutePath;
      readonly cause: string }
  | { readonly kind: 'build-info-lacks-contract-map';
      readonly file: AbsolutePath };
```

A closed union of three mechanisms (INV-34), carrying **paths and a cause string only** —
never file bytes and never a parsed fragment (INV-42).

`cause` is deliberately not `error.message`. Node's `JSON.parse` embeds a snippet of the
offending source in its message, so forwarding it would put contract source — in a
monorepo, source paths disclosing unreleased product names — into CI logs. `cause` is the
error's `code`, else its `name` if not the bare `Error`, else a fixed fallback; for invalid
JSON it is the fixed string `'the file is not valid JSON'`.

`artifactTreeIsExternal` mirrors `ProjectPaths.contractsBuildDirectoryIsExternal`. When
`true`, this resolution is in the column where build info is never written **and** every
migration is replayed from zero on every run.

> **`indeterminate` is a routine state, not a rare fallback.** Build info is never written
> under `tronbox test`, which is the same context that forces a full migration replay. Any
> consumer of `resolve()` must handle all three statuses.

---

## The build-info reader

### `BuildInfoReader`

```ts
interface BuildInfoReader {
  read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult;
  exists(file: AbsolutePath): boolean;
}
```

The seam's **one** injected dependency (INV-43). Two methods, each a separately confined
capability (INV-31):

- `read` returns file *content* and is asked only for paths under `buildInfoDirectory`.
- `exists` returns a `boolean` and is asked only for the one packaged-artifact path
  `resolvePackaged` computes. **Existence, never content.**

The count INV-43 fixes is dependencies, not methods: nothing new is constructed, defaulted,
threaded through the entry point, or mocked separately, and the method admitted is strictly
*weaker* than the one already present.

`exists` is **required, not optional**, deliberately: an optional probe would force
`resolvePackaged` to keep a fallback path for readers that decline it, which is precisely
where the missing-versus-malformed split would quietly regress back to one combined
message.

If you implement this interface, implement `exists` as a **stat-class** probe. The obvious
shortcut — `try { fs.readFileSync(file); return true } catch { return false }` — satisfies
the signature and silently converts the weaker capability back into the stronger one: it
puts the packaged artifact's bytes inside the seam, one careless interpolation away from a
leak, and makes a large corrupt file cost a full read to answer a boolean.

### `BuildInfoReadResult` / `BuildInfoFile`

```ts
type BuildInfoReadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly file: AbsolutePath; readonly cause: string }
  | { readonly status: 'files'; readonly files: readonly BuildInfoFile[] };

interface BuildInfoFile {
  readonly file: AbsolutePath;
  readonly output: unknown;
}
```

`output` is parsed solc standard-JSON output, **never retained beyond index
construction**. It is typed `unknown` because it comes from outside; the index checks
`output.contracts` is an object record and treats anything else as
`build-info-lacks-contract-map`.

A path your reader returns is trusted only after the index shows it to be absolute and
contained in `buildInfoDirectory`. A file named outside that directory yields
`build-info-unreadable` with the cause *"the build-info reader named a file outside
buildInfoDirectory"*, anchored on the directory rather than on your path.

### `fileSystemBuildInfoReader`

```ts
const fileSystemBuildInfoReader: BuildInfoReader;
```

The default. Exactly one directory listing plus at most one read-and-parse per
`*.output.json` entry directly within it (INV-37). The paired `<hash>.json` compiler
*input* file is never read — it is typically the larger of the pair, and the index does not
need it because `<hash>.output.json` already retains
`contracts[sourcePath][contractName]`. `isFile()` also excludes symlinks, so there is no
traversal out of the directory. Entries are sorted by name before reading, so the result is
order-stable.

`ENOENT` on the listing yields `status: 'absent'`. `exists` is `fs.existsSync`.

### `buildArtifactAmbiguityIndex(paths, reader?)`

```ts
function buildArtifactAmbiguityIndex(
  paths: ProjectPaths,
  reader: BuildInfoReader = fileSystemBuildInfoReader,
): ArtifactAmbiguityIndex;
```

```ts
interface ArtifactAmbiguityIndex {
  readonly report: ArtifactAmbiguityReport;
  candidates(name: string): readonly ArtifactCandidate[];
}
```

Unions every build-info output file into a bare-name index, and **never ranks candidates**.
`candidates(name)` normalizes the name and returns a frozen empty array for an unknown one.
A reader that *throws* from `read` is translated into `build-info-unreadable` anchored on
`buildInfoDirectory` — no host failure escapes (INV-15).

Exported for direct use; the `artifacts` slot calls it lazily on your behalf.

### `normalizeArtifactName(name)`

```ts
function normalizeArtifactName(name: string): string;
```

Reproduces `build/components/Resolver/intercept.js:ResolverIntercept.prototype.require`'s
own normalization exactly — `name.replace(/^\.\//, '').replace(/\.sol$/i, '')`, in that
order, with no separator rewriting, no case folding of the name, and no trimming (INV-8).
One function, used by both the resolve path and the index, so the two key spaces cannot
drift apart.

---

## Errors

### `TronBoxEnvironmentError`

```ts
abstract class TronBoxEnvironmentError extends Error {
  abstract readonly diagnosis: EnvironmentDiagnosis;
  abstract readonly code: `TRONBOX_ENV_${Uppercase<EnvironmentDiagnosis>}`;
}

type EnvironmentDiagnosis = 'absent' | 'incomplete' | 'inconsistent';
```

Exactly three subclasses, each with a `code` derived from its `diagnosis` by the
template-literal type (INV-10). Switch on `code` or `diagnosis`, never on `message`.

Every `EnvironmentIncompleteError` message ends with `Declared TronBox peer range: <range>.`
The declared range has exactly one home — `peerDependencies.tronbox` in this package's own
manifest — and is read rather than restated, and is never a comparison operand (INV-19). A
TronBox *version* string is unavailable in principle: `require('tronbox')` never resolves,
because the package declares no `main` and has no root `index.js`. The structural
`handle-malformed` diagnosis **is** the version check.

### `EnvironmentAbsentError`

```ts
class EnvironmentAbsentError extends TronBoxEnvironmentError {
  readonly diagnosis: 'absent';
  readonly code: 'TRONBOX_ENV_ABSENT';
  readonly requested: readonly SlotName[];
  constructor(requested: readonly SlotName[]);
}
```

The only diagnosis that says "outside a TronBox migration context".

### `EnvironmentIncompleteError`

```ts
class EnvironmentIncompleteError extends TronBoxEnvironmentError {
  readonly diagnosis: 'incomplete';
  readonly code: 'TRONBOX_ENV_INCOMPLETE';
  readonly unsatisfied: readonly UnsatisfiedSlot[];
  constructor(unsatisfied: readonly UnsatisfiedSlot[]);
}
```

```ts
interface UnsatisfiedSlot {
  readonly slot: SlotName;
  readonly cause:
    | { readonly kind: 'handle-missing'; readonly handle: HandleName }
    | { readonly kind: 'handle-malformed';
        readonly handle: HandleName;
        readonly expectedPath: string;
        readonly because: 'missing' | 'threw' }
    | { readonly kind: 'invariant-violated'; readonly detail: string };
  readonly providedIn: readonly InvocationContextName[];
  readonly absentIn: readonly InvocationContextName[];
}
```

Read `unsatisfied` rather than parsing the message. `providedIn` and `absentIn` are read
from the slot table, never authored at a throw site (INV-14), so they always agree with
`slotRequirements`.

`because` distinguishes a host **getter that raised** (`'threw'`) from an **absent own
property** (`'missing'`). INV-17 turns on those being different states —
`Config.prototype.addProp`'s getter is a truthiness test, so a key explicitly set to `''`
falls through to its default and reports a value the user did not configure. Testing
own-property presence instead of truthiness is what keeps them apart.

### `EnvironmentInconsistentError`

```ts
class EnvironmentInconsistentError extends TronBoxEnvironmentError {
  readonly diagnosis: 'inconsistent';
  readonly code: 'TRONBOX_ENV_INCONSISTENT';
  readonly inconsistencies: readonly Inconsistency[];
  constructor(inconsistencies: readonly Inconsistency[]);
}
```

```ts
type Inconsistency =
  | { readonly kind: 'config-lineage-field';
      readonly field: ConfigScalarField;
      readonly viaDeployer: unknown;
      readonly viaArtifacts: unknown }
  | { readonly kind: 'artifacts-not-wrapping-deployer-resolver' }
  | { readonly kind: 'chain-handle-conflict' };
```

`config-lineage-field` renders both values verbatim, which is why `field` is constrained to
the `ConfigScalarField` allow-list (INV-41) — only strings, numbers, booleans and `null`
reach the formatter.

`artifacts-not-wrapping-deployer-resolver` means the supplied intercept does not wrap the
resolver owned by the supplied deployer's Config, so configuration and artifact write-back
would come from different migrations. TronBox's own flow never mispairs them —
`build/components/Migrate/index.js:Migration` creates both together — but a hand-built
harness, or a memoization keyed on only one handle, can.

Comparison uses `Object.is`, so `NaN` compares equal to itself and `-0` does not compare
equal to `0`.

### `ArtifactNameAmbiguousError`

```ts
class ArtifactNameAmbiguousError extends Error {
  readonly contractName: string;
  readonly candidates: readonly ArtifactCandidate[];
  constructor(contractName: string, candidates: readonly ArtifactCandidate[]);
}
```

**SF-0 never throws this.** It owns the diagnosis text because it holds the candidates, and
exports the class for SF-5 to throw if refusal is the policy SF-5 chooses. Deliberately
**not** a `TronBoxEnvironmentError` subclass — INV-10 fixes that family at three.

---

## The slot table

### `slotNames`

```ts
const slotNames: readonly ['paths','network','artifacts','chain','receipts','scheduling','output'];
```

Frozen, and typed as a tuple, so `{ require: slotNames }` requests all seven with full type
narrowing.

### `slotRequirements`

```ts
const slotRequirements: Readonly<Record<SlotName, SlotRequirement>>;

interface SlotRequirement {
  readonly handles: readonly HandleName[];
  readonly providedIn: readonly InvocationContextName[];
  readonly absentIn: readonly InvocationContextName[];
}

type InvocationContextName =
  | 'tronbox migrate'
  | 'tronbox test migration phase'
  | 'tronbox test mocha files'
  | 'tronbox console'
  | 'plain node';
```

The invocation-context matrix **as data**, so tests and error messages read the matrix
rather than restating it. `absentIn` is computed as the complement of `providedIn` over all
five contexts, so the two can never disagree.

Read this table instead of hardcoding a context list. If you need to tell a user where a
capability exists, render from `slotRequirements[slot]`.

---

## Cross-check field lists

```ts
const pathConfigLineageFields: readonly ['working_directory','contracts_directory',
  'contracts_build_directory','build_info_directory'];

const networkConfigLineageFields: readonly ['network','network_id',
  'networks[network].network_id','from','feeLimit','userFeePercentage',
  'originEnergyLimit','callValue','tokenValue','tokenId','signingKeyConfigured'];

const configLineageFields: readonly [...pathFields, ...networkFields];
```

The compared field set as explicit groups, iterated rather than derived from `Object.keys`.
A resolution compares exactly the groups whose slots it exposes, which is what keeps the
cost linear in the number of declared slots plus a fixed field list (INV-45), and keeps
`internalPathsRead` free of fields nothing needed.

### `ConfigScalarField`

```ts
type ConfigScalarField =
  | 'working_directory' | 'contracts_directory' | 'contracts_build_directory'
  | 'build_info_directory' | 'network' | 'network_id'
  | 'networks[network].network_id' | 'from' | 'feeLimit' | 'userFeePercentage'
  | 'originEnergyLimit' | 'callValue' | 'tokenValue' | 'tokenId'
  | 'signingKeyConfigured';
```

Every scalar the seam exposes from a lineage appears here. The union of the groups must
equal this type exactly — that correspondence is a **compile error** rather than a comment
(`src/environment/config-lineage.ts:ConfigLineageFieldCoverage`, and the network group's
`src/environment/network.ts:NetworkScalarValuesCoverage`). Adding an exposed scalar to the
type without adding it to a group, or the reverse, fails to compile.

`OutputChannelSlot.hostQuietRequested` is the one exposed lineage-derived scalar
deliberately **excluded** — see [`OutputChannelSlot`](#outputchannelslot).

> **`network_id` is normalized; nothing else is.** A `number` is accepted for either
> `network_id` field and coerced with `String(value)`, because that is the host's own
> canonical form — `build/components/Contract/contract.js:setNetwork` does
> `this.network_id = network_id + ""`. Two asymmetries follow, and both are deliberate:
> **falsy numerics are refused** (the host's gate is truthiness, so it refuses numeric `0`
> while accepting `'0'`; the seam reproduces that rather than blessing a config the host
> then refuses), and **`'*'` is never produced by coercion**, since no number is `'*'`.
> `bigint`, `boolean` and `toString` carriers keep their named refusal. This is the seam's
> only value normalization and `src/environment/network.ts:normalizeNetworkId` **is** the
> closed list — exactly two call sites, both `network_id` (INV-48).

---

## Constants and helpers

### `REDACTED_HOST_HANDLE`

```ts
const REDACTED_HOST_HANDLE: '[TronBox host handle — redacted, not serialized]';
```

What a redacted host handle serializes to. Read
[`safety.md`](./safety.md#handles-are-safe-in-serialization-only) for what this does and
does not protect — it is a **serialization-only backstop**, not the mechanism.

### `getDeclaredTronBoxRange()`

```ts
function getDeclaredTronBoxRange(): string;
```

Returns `peerDependencies.tronbox` from this package's manifest. Read rather than restated,
and never a comparison operand.

---

## Handle types

Structural minimums for the host objects, asserted before a handle reaches a slot (INV-25).
They model the property paths the seam depends on and nothing else — in particular, **no
operation-specific methods on `ContractAbstraction`**, whose identity SF-0 preserves and
whose surface it never describes.

```ts
type ContractAbstraction = object & {
  readonly contract_name?: string;
  readonly contractName?: string;
  readonly sourcePath?: string;
};

interface ResolverInterceptHandle {
  require(importPath: string): ContractAbstraction;
  contracts(): ContractAbstraction[];
  readonly resolver: object;
}

interface TronWrapHandle { readonly trx: object }
interface DeployerHandle { then(step: (...args: unknown[]) => unknown): unknown }
type WaitForTransactionReceipt = (...args: unknown[]) => unknown;
interface TronBoxLogger { log(...args: unknown[]): void }

type HandleName = 'deployer' | 'artifacts' | 'tronWrap' | 'tronWeb'
  | 'waitForTransactionReceipt';
```

---

## Branded types

### `AbsolutePath`

```ts
type AbsolutePath = string & { readonly [AbsolutePathBrand]: true };
```

A path asserted absolute at the TronBox environment boundary. **The brand is mintable only
by `src/environment/paths.ts:assertAbsolutePath`, which refuses a non-absolute input rather
than resolving it** (INV-2).

Resolving would anchor on a cwd that is wrong in principle:
`build/components/Require.js:Require.file` chdirs to the migration's directory for the
file's top-level evaluation and restores it before the exported function runs. The cwd
therefore differs between plugin-require time and operation-call time, and equals the
project root in neither.

`assertAbsolutePath` is not re-exported from `src/environment/index.ts`. If you hold a
string that must become an `AbsolutePath`, you are almost certainly outside the seam's
boundary and should be receiving a path from `ProjectPaths` instead.
