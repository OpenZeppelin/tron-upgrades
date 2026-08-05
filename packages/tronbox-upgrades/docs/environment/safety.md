# Safety — what you must know before consuming the seam

Five things in this document will cause a real defect if you assume otherwise. They are
ordered by how easy they are to get wrong.

1. [Handles are safe in serialization only](#handles-are-safe-in-serialization-only)
2. [The logger declares `log` only](#the-logger-declares-log-only)
3. [Nothing here tells you whether output is visible](#nothing-here-tells-you-whether-output-is-visible)
4. [Degraded modes are routine, not exceptional](#degraded-modes-are-routine-not-exceptional)
5. [What the seam deliberately does not promise](#what-the-seam-deliberately-does-not-promise)

---

## Handles are safe in serialization only

**The rule:** `JSON.stringify(env)` and `JSON.stringify(env.scheduling)` are safe. Nothing
else about a handle is.

### What is actually protected, and by what

There are **two mechanisms, and they are not interchangeable**.

**1. The mechanism is structural.** A host handle never reaches a formatter at all. Every
message the seam renders is composed from the seam's own projected slots, through the
table-driven rendering in `src/environment/errors.ts`. Values that could carry a credential
are tested in place and never bound to anything that outlives the test —
`src/environment/network.ts:projectNetworkValues` is the reference pattern: the configured
`privateKey` is read, tested, and the only thing that leaves is the boolean
`signingKeyConfigured`. This is what makes the seam's *own output* safe in every channel:
`JSON.stringify`, `util.inspect`, `console.log`, template interpolation and own-enumerable
traversal alike, because none of them is ever handed a handle.

**2. Redaction is a backstop, and covers serialization only.** `src/environment/handles.ts:sealSlot`
installs a **non-enumerable `toJSON`** on each handle-bearing slot, replacing the handle with
`REDACTED_HOST_HANDLE`. That closes `JSON.stringify` — the channel a user actually pastes
into a GitHub issue — and **it closes nothing else.** `toJSON` is invisible to
`util.inspect`. It is invisible to `console.log`. It is invisible to template
interpolation. It is invisible to `Object.keys` and to spread.

> If you take away one sentence: **`toJSON` is not the mechanism. It is a serialization-only
> backstop, and treating it as the protection is the documented way to leak a credential.**

That last point is not hypothetical. If redaction is understood as *the* protection, then the
next slot added with a host handle is protected exactly until someone writes

```ts
logger.log(`resolved: ${env.output}`);   // toJSON never consulted
console.log(env.scheduling);             // toJSON never consulted
```

and the credential is on a terminal and in a CI log.

### Why the handles are exposed at all

Because a slot that hid them would not be a usable capability. `scheduling.deployer` is the
one deliberate exception to handles being named rather than modelled — the deploy seam needs
the deployer's queue. `artifacts.intercept`
is the artifact write-back path, and substituting `config.resolver` for it is the quietest
failure in this surface (see [`api-reference.md`](./api-reference.md#intercept)).

The credential's proximity is a **discovered necessity, not a choice the seam made**.
`build/components/Config.js:Config`'s top-level `privateKey` getter always returns `null` —
safe, and useless as a presence check — while the real key lives on the network entry, and
the `network_config` getter mints a fresh merged object carrying `privateKey` on **every
access**. Hiding `networks` would not close it. Neither would hiding `_values`.

TronBox itself shields the key on the one handle it wraps —
`build/components/TronWrap/TronWebProxy.js` masks `defaultPrivateKey` through
`HIDDEN_PROPS` — and applies no equivalent shield to `Config`, `Deployer` or `Resolver`. So
the seam applies its backstop at its own boundary.

### The five redacted handles, and which are credential-reachable

`sealSlot` is called at five sites, so **five** handles are redacted on serialization:

| Slot member | Redacted | Configured `privateKey` reachable by own-enumerable traversal? |
|---|---|---|
| `scheduling.deployer` | yes | **Yes — 3 routes, shortest at depth 4** |
| `artifacts.intercept` | yes | **Yes — 3 routes, shortest at depth 4** |
| `chain.tronWrap` | yes | The host applies its own `HIDDEN_PROPS` mask here; the seam does not rely on it |
| `output.logger` | yes | Not reachable in any of TronBox's logger shapes |
| `receipts.waitForTransactionReceipt` | yes | Not reachable (a bare function) |

The two reachable routes, verified on **4.9.0 and 4.8.0**:

```
scheduling.deployer  →  options.options.network_config.privateKey            (depth 4)
                        options.options.networks.<name>.privateKey           (depth 5)
                        options.options._values.networks.<name>.privateKey   (depth 6)

artifacts.intercept  →  resolver.options.network_config.privateKey           (depth 4)
                        resolver.options.networks.<name>.privateKey          (depth 5)
                        resolver.options._values.networks.<name>.privateKey  (depth 6)
```

Routes 2 and 3 reach the same object by two property paths — the public `networks` accessor
and the private `_values` backing store — which is why closing any single route closes
nothing.

> `test/real-tronbox.test.ts:257` pins the load-bearing form of this against the real tool on
> both minors: at least two routes, minimum depth 4, and `JSON.stringify(deployer)` throwing
> `TypeError` without the seal. It asserts a route *count* rather than the full route list,
> because its `reachableAt` helper dedupes by object identity — so it reports two where a
> path-based enumeration reports three.

### What to do

**Safe:**

```ts
JSON.stringify(env);                     // every handle → REDACTED_HOST_HANDLE
JSON.stringify(env.scheduling);          // same
util.inspect(env.paths, { depth: null }); // no handle in this slot at all
util.inspect(env.network, { depth: null });
util.inspect(env.provenance, { depth: null });
env.network.signingKeyConfigured;        // a boolean, by construction
```

**Unsafe — do not do these:**

```ts
console.log(env.scheduling);                        // toJSON not consulted
console.log(env.scheduling.deployer);               // ditto
util.inspect(env.artifacts, { depth: null });       // ditto
logger.log(`env: ${JSON.stringify(env)}`);          // safe, but see below
logger.log(`deployer: ${env.scheduling.deployer}`); // template interpolation of a handle
throw new Error(`bad handle: ${env.artifacts.intercept}`);
```

**The rule to hold:** log the composite, never the raw handle. And prefer building your
diagnostic from named projected fields rather than from the composite at all:

```ts
// Best: name what you need.
logger.log(`network=${env.network.name} root=${env.paths.root}`);

// Acceptable: the whole composite through serialization, which is redacted.
logger.log(JSON.stringify(env));

// Never: any expression whose value is a host handle.
```

Three slots carry no handle whatsoever — `paths`, `network`, and `provenance` — so they are
safe in every channel with no projection step. If your diagnostic can be built from those
alone, build it from those alone.

---

## The logger declares `log` only

```ts
interface TronBoxLogger {
  log(...args: unknown[]): void;
}
```

`logger.warn` does not compile. That is the enforcement — the unsound call is
unwritable — and it is deliberate, because **four of TronBox's five logger-injection paths
supply a single-method object**, verified:

| Path | Logger supplied |
|---|---|
| `build/components/Deployer/index.js:Deployer` | `options.logger \|\| { log(){} }` |
| `build/components/Migrate/index.js:Migration` | `{ log: msg => logger.log("  " + msg) }` — so even the happy path's `deployer.logger` has only `log`, and silently indents by two spaces |
| `build/lib/commands/migrate.js:command.run` | `{ log(){} }` under `--quiet` or `--silent` |
| `build/lib/test.js` | `{ log(){} }` |
| `build/components/Config.js:Config` | `{ log(){} }` (its own default) |
| `build/index.js` | `console` — **the only path carrying `warn`/`error`** |

So a warning emitted through `logger.warn` works in every ordinary developer run and throws
`TypeError: logger.warn is not a function` under `--quiet`, under `tronbox test`, and through
the deployer's own wrapper. That crash lands *inside* a validating operation's warning path
— which turns a required degraded-mode message into a crash, and does so **only for users
who asked for less output.**

### The capability probe

If you need richer output, probe for it. Never assume it from the type.

```ts
import type { TronBoxLogger } from '../environment';

/** Emits at `warn` when the host logger has it, else falls back to `log`. */
function warn(logger: TronBoxLogger, message: string): void {
  const candidate = (logger as TronBoxLogger & { warn?: unknown }).warn;
  if (typeof candidate === 'function') {
    (candidate as (...args: unknown[]) => void).call(logger, message);
    return;
  }
  logger.log(message);
}
```

Note the `.call(logger, …)` — `console.warn` does not need a receiver but a closure-built
wrapper may, and getting that wrong reintroduces the same `TypeError` on the path you were
trying to protect.

**The environment seam never calls the logger itself.** It never touches `console` either —
not `console.warn`, not `console.error`, not in an error path. `output` is a capability handed
to the option/result surface, and the option/result surface owns the warning channel.

---

## Nothing here tells you whether output is visible

**`OutputChannelSlot.origin` is not a visibility signal, in either value.** Do not build a
decision on it.

- `origin: 'config-lineage'` may be TronBox's own `{ log(){} }` default — a channel that
  discards everything.
- `origin: 'deployer'` is no better. `build/lib/commands/migrate.js:command.run` replaces the
  logger **before** `Config.detect`, and `build/lib/test.js:Test.performInitialDeploy` passes
  `{ log(){} }`.

A discarding channel is therefore the **normal case in two of the five invocation
contexts**, with no flag involved. `origin` reports which *mechanism* supplied the channel,
so the seam's choice is a statement rather than a silent preference. It reports nothing about
liveness.

`hostQuietRequested` is not a visibility signal either. It is read exactly — from a plain own
property that `Config.prototype.merge` lands on the Config when `migrate` merges its options
— and absence means `false`. But `false` does not imply output is visible: under
`tronbox test` the injected logger is a noop that no `--quiet` flag produced.

It is also deliberately **not** cross-checked between lineages, and that is not an oversight.
Under `tronbox test` the two lineages genuinely disagree — `performInitialDeploy` calls
`config.with({ reset: true, quiet: true, logger: { log(){} } })`, so the deployer's snapshot
carries `quiet: true` while the live Config the resolver holds carries no `quiet` key at all.
Comparing it would throw `EnvironmentInconsistentError` on **every** `tronbox test` run.

### What to do instead

**Do not make degraded-mode reporting depend on the log channel.** The option/result surface
owns the output and warning channel outright and resolved this: degraded-mode statements ride
the **returned result** as enumerated values, and failures ride **typed errors**. Logging is
advisory only.

If a statement matters, it must survive a discarding channel. Put it in the return value or
in a thrown error.

> The `output` slot is documented here as making **no** visibility claim. Its contract beyond
> that — the shape of degraded-mode notes, the warning channel's construction, the plugin's
> own quiet control — belongs to the option/result surface and is not described in this
> document.

---

## Degraded modes are routine, not exceptional

There are exactly **two** reduced-verification modes, and each is reported as data rather
than as a failure or a silence. Both are ordinary states you will hit in normal
use.

### 1. Only one Config lineage was reachable

`provenance.configLineages.crossChecked === false`, with `crossCheckSkippedBecause` naming
which lineage was available. The composite is still complete; it simply was not
cross-checked. Neither field is inferable from the other, which is why both are reported.

One conflation worth knowing: `ConfigLineageBinding` and `crossCheckSkippedBecause` are
closed unions with **no member for "supplied but unreachable"**, so a handle that *was*
supplied and whose lineage was malformed is reported as `'absent'`. This is only observable
when no lineage-derived slot is required — otherwise the resolution has already failed with a
named diagnosis.

### 2. The ambiguity index was unavailable

`ambiguities()` returns `status: 'indeterminate'`, and `resolve()` returns
`status: 'indeterminate'` with the same reason. **This is the normal case under
`tronbox test`**, because build info is never written there — which is the same context that
forces a full migration replay from zero on every run.

Any consumer of `resolve()` must handle all three statuses. Treating `indeterminate` as an
error will break `tronbox test` for every user.

```ts
const resolution = env.artifacts.resolve('Box');
switch (resolution.status) {
  case 'unique':
    return resolution.contract;
  case 'ambiguous':
    // Policy belongs to the proxy operations.
    // `ArtifactNameAmbiguousError` exists for that decision.
    return decideAmbiguity(resolution.candidates, resolution.unverifiedContract);
  case 'indeterminate':
    // Routine. Proceed with reduced verification, and say so in the result.
    return proceedUnverified(resolution.reason, resolution.unverifiedContract);
}
```

Note the field names: only the `unique` branch has `contract`. The other two carry
`unverifiedContract`, and the asymmetry is the enforcement — storing an unverified
abstraction into a `contract`-typed position is impossible without renaming it.

---

## What the seam deliberately does not promise

### It reads nothing from the chain

No network request of any kind, no chain read, no dev-node detection. It does not
resolve `'*'` to a concrete network id — TronBox never does either. It reads no
implementation, admin or beacon slot.

`network.artifactNetworkId` is **compatibility metadata about the tool**, never evidence
about the chain. If you need to know which chain you are talking to, ask the chain.

### The configured sender is not the effective sender

`network.sender.kind` is the literal `'configured-not-authoritative'`, and it is wrapped in
an object precisely so a call site cannot skip the caveat. The effective sender is
chosen at send time — `TronWrap._getAccounts` replaces `_accounts` wholesale on a TRE node
while resetting `privateKeyByAccount` — so **an authority preflight against
`sender.address` can pass while the transaction sends from a different account.**

`signingKeyConfigured` reports that a key is configured. It does not report that the key
controls anything.

### `txDefaults` are the tool's resolved values, and the snake_case fallback is nearly unreachable

`txDefaults` comes from TronBox's own getters, because those are what the tool *resolved*.
Two consequences that look like bugs and are not:

- **A configured `0` reads as absent.** The getters are `||` chains, so with
  `callValue: 0` merged in from `build/components/TronWrap/constants.js:deployParameters`,
  `config.callValue` reads `undefined` and `txDefaults.callValue` is `null` — for
  essentially every project.
- **The `fee_limit` snake_case fallback effectively never fires.** `config.feeLimit` is
  `network_config.feeLimit || network_config.fee_limit`, and `deployParameters` injects a
  truthy `feeLimit: 1e9` that short-circuits the `||` before `fee_limit` is consulted. With
  only `fee_limit: 456` configured, `config.feeLimit` reads `1e9`. The same shadowing
  applies to `userFeePercentage`/`consume_user_resource_percent` and
  `callValue`/`call_value`.

So a project that configures only snake_case keys will see the host's defaults here, not its
own values. That is TronBox's behaviour faithfully reported, not a seam bug — but any parity
work that assumes the documented camelCase-to-snake_case fallback needs to know it.

### A misspelled network is refused, not defaulted

This is the one place the seam is deliberately **stricter** than TronBox. A network name
absent from `networks` yields, from TronBox's own getters, a complete and plausible and
entirely fictional configuration — `feeLimit: 1000000000`, `userFeePercentage: 100`,
`originEnergyLimit: 10000000` from `deployParameters`, with no error at all. `Config`'s own
defaults are `network: "development"` with `networks: {}`, so an empty config reaches that
state with no user error whatsoever.

Reading the getters cannot distinguish that from a real configuration. So the check runs
against the `networks` map itself, before any derived getter is read, and an absent entry is
an `EnvironmentIncompleteError` naming the selected network and every configured one.

### `EACCES` on a packaged artifact diagnoses as missing

The `exists` probe is `fs.existsSync`, chosen because it is stat-class **and** cannot throw,
so an unreadable parent directory answers "not there" rather than escaping as an untranslated
host failure. The recorded cost: a permission-denied path is reported as absent. This is the
same direction TronBox's own resolver collapses it in, and splitting it would require a third
reader method, and the design caps that count at exactly two.

### A packaged artifact you load gets written back into your build directory

Because everything routes through the intercept, an artifact loaded via
`resolvePackaged` **enters the intercept cache and is written back by `artifactor.saveAll`**.
Proxy bytecode loaded from `node_modules` will land in the project's build directory at the
end of the migration. This is a consequence of using the write-back path correctly, not a
defect — but it is a visible side effect on the user's tree, and the policy for it belongs to
the proxy operations.

Relatedly, `resolvePackaged` **refuses a `./`-prefixed path as a matter of contract**,
because `ResolverIntercept.prototype.require` strips a leading `./` before delegating.

### Containment is path arithmetic, and is exercised on POSIX only

`isContainedIn` uses `path.relative` with no `fs` call and no symlink resolution. That is
deliberate — it is what lets containment be decided with zero I/O — but it means a symlink
out of the project is not detected as an escape. The `ProjectPaths` containment checks are
tested on POSIX only; no Windows CI matrix entry exists yet.

### The declared TronBox range is quoted, never validated

`getDeclaredTronBoxRange()` returns `peerDependencies.tronbox` verbatim and the seam never
compares against it. A TronBox *version* string is unavailable in principle —
`require('tronbox')` never resolves, because the package declares no `main` and has no root
`index.js`. The structural `handle-malformed` diagnosis **is** the version check.

> The manifest's current value is not yet a validated support range — setting it belongs to
> the validation ladder.
> The seam quotes whatever it finds, so do not treat the string in an error message as a
> tested compatibility claim. The seam itself is verified against **4.9.0 and 4.8.0**.

### It never retries, schedules, or grows

No retry, no timer, no unbounded cache. The only cache is the per-composite
ambiguity-index memo, holding one report. There is no module-scope mutable state anywhere in
`src/environment/**`, so a stale composite carried across migrations is not a rule
to remember but a state that cannot be represented.

**If you memoize a composite yourself, key it on `deployer` or `artifacts` — never on the
`Config`.** The `Config` is shared across migrations while `deployer` and
`artifacts` are fresh per migration, so a `Config`-keyed memo serves migration *N*'s
composite to migration *N+1*. When you key on one handle, `resolveEnvironment`'s
resolver-pairing check covers the other.
