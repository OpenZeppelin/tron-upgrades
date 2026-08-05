# Integration guide

Four patterns, in the order a consumer meets them. Each is backed by a type-checked module in
[`examples/`](./examples) — read the example for the whole compiling file, and this document for
the decisions the example encodes.

- [Pattern 1: build one `ChainAccess`, hand `provider` to the engine](#pattern-1-build-one-chainaccess-hand-provider-to-the-engine)
- [Pattern 2: read proxy state without deciding proxy kind](#pattern-2-read-proxy-state-without-deciding-proxy-kind)
- [Pattern 3: check instance identity before trusting a manifest](#pattern-3-check-instance-identity-before-trusting-a-manifest)
- [Pattern 4: supply your own transport](#pattern-4-supply-your-own-transport)
- [Common mistakes](#common-mistakes)

---

## Pattern 1: build one `ChainAccess`, hand `provider` to the engine

→ [`examples/01-access-in-an-operation.ts`](./examples/01-access-in-an-operation.ts)

```ts
import { Manifest } from '@openzeppelin/upgrades-core';
import { resolveEnvironment } from '../environment';
import { createChainAccess } from '../chain';

const env = resolveEnvironment(handles, { require: ['chain'] });
const access = await createChainAccess(env.chain);

const manifest = await Manifest.forNetwork(access.provider);
```

### Ask for `chain` and nothing else

`chain` is the only slot this surface needs, and it is the **only** one of the seam's seven that is
provided in `tronbox console` as well as under `migrate` and `test`. An operation that asks for
`output` or `scheduling` alongside it fails in `console` for a reason that has nothing to do with
chain state.

### The engine gets `access.provider` — and that is checked by the compiler

`Manifest.forNetwork(env.chain.tronWrap)` does not compile, and the reason is worth understanding
before someone "helpfully" widens a type to make it. The seam's `TronWrapHandle` is `{ trx: object }`
and stays that way; `tronWrap.send` POSTs to `networkConfig.fullNode + '/tre'`, which answers on a
local TRE and returns HTTP 405 on every public network — surfacing as
`TRE RPC 'eth_chainId': Request failed with status code 405`, an error naming the wrong capability
and working on one machine while failing on another.

That is one of four defences against the same trap. The other three are runtime: this surface
reaches the handle along exactly two property paths, its typed view of the handle is module-private,
and an endpoint whose path ends in `/tre` is refused outright.

### Narrow both construction failures structurally

Two typed failures, and neither should be matched on its message:

```ts
try {
  return { access: await createChainAccess(env.chain) };
} catch (cause) {
  if (cause instanceof EnvironmentIncompleteError) {
    // `cause.unsatisfied` is the structured form of the same facts the message renders.
    return { problem: `${cause.code}: ${cause.message}` };
  }
  if (cause instanceof ChainEndpointRefusedError) {
    return { problem: `${cause.code}: ${cause.source} — ${cause.because}` };
  }
  throw cause;   // a defect in this plugin, not a fact about the node
}
```

`EnvironmentIncompleteError` is the common one, and its `detail` is written to be actionable: on a
stock self-hosted java-tron the eth-compat service is disabled by default
(`node.jsonrpc.httpFullNodeEnable`) and, when enabled, listens on **8545** while the wallet API a
`fullHost` names listens on **8090**. So the derived endpoint is wrong for a *supported*
configuration, the symptom is `ECONNREFUSED` rather than a per-method `-32601`, and the message
names the service, the config key, the port pair, and `TRONBOX_UPGRADES_RPC_URL` as the remedy.

### Per-operation or per-migration — pick deliberately

`createChainAccess` is not a singleton, and both lifetimes are supported:

| Lifetime | Cost | When |
|---|---|---|
| One per operation | one `eth_chainId` probe each | The simple default. Correct, and cheap enough that "reuse it" is an optimization rather than a requirement. |
| One per migration, memoized on the handle | one probe, and the instance fingerprint paid once | When an operation reads identity, or when several operations run in sequence. |

Memoize on the **handle object**, in a `WeakMap`, never in a module-scope variable — module-scope
state is exactly what makes a stale composite survive into the next migration, and a `tronbox
console` session can switch network under it.

The obligation you must honour either way: a deployment record and the engine's manifest write must
go through the **same instance**. See
[`safety.md`](./safety.md#the-shared-instance-obligation-is-the-callers).

---

## Pattern 2: read proxy state without deciding proxy kind

→ [`examples/03-read-proxy-state.ts`](./examples/03-read-proxy-state.ts)

```ts
const read = await access.read.readProxySlots(address);
switch (read.kind) {
  case 'no-code':
    return `${address}: nothing is deployed at this address`;
  case 'code':
    return { impl: read.implementation, admin: read.admin, beacon: read.beacon };
}
```

### Handle every union member — the compiler will make you, and that is the feature

Every no-answer reason on this surface is a **named union member**, never `undefined`. The reason is
a measured user-facing failure: upstream's `beacon.ts:assertIsBeacon` tells a user their address "is
not an upgradeable beacon: its `implementation()` getter did not return an address" when in fact
nothing is deployed there at all — so the correct action, *check the address*, is not among the ones
the message suggests.

Three unions carry that distinction, and each one's members map to a different sentence you owe the
user:

| Union | Member | What to tell the user |
|---|---|---|
| `ProxySlotsRead` | `no-code` | Nothing is deployed here — check the address |
| | `code` + all three `null` | A contract is deployed, but it is not an ERC-1967 proxy |
| `OptionalCallOutcome` | `no-answer` / `no-contract-at-address` | Nothing is deployed here |
| | `no-answer` / `reverted` | A contract is here, and it has no such getter or refused the call |
| `BeaconRead` | `no-code-at-beacon` | Nothing is deployed here |
| | `not-a-beacon` / `call-did-not-answer` | Deployed, but `implementation()` did not answer |
| | `not-a-beacon` / `answer-is-not-an-address` | `implementation()` answered with something that is not an address |

### Do not tidy the admin/implementation asymmetry

`readImplementationAddress` and `readBeaconAddress` **throw** for an empty slot; `readAdminAddress`
returns the **zero address**. That is the engine's asymmetry, mirrored deliberately:
`eip-1967-type.js:isTransparentProxy` is `!isEmptySlot(adminAddress)`, so a reader that threw for an
empty admin slot would make that predicate throw instead of returning `false`, and the plugin would
disagree with the engine about whether an address is a proxy.

### Compare addresses with `sameAddress`, never `===`

`ChainAddress` is branded lowercase hex, exactly as derived from a storage word — **not
checksummed**. upgrades-core compares addresses with `===` while reading its own manifest, so a
casing mismatch silently drops a recorded proxy kind and layout. Canonicalization for persistence
belongs at the record layer's boundary, which is expected to define its own brand so assignment
fails in both directions.

`sameAddress` is also length-checked: `sameAddress('0x', '0x')` is `false`, or else "no
implementation" would match "no implementation".

### Judgment stays with you

These readers return what the slots say, never what it means. Deciding that an address is a
transparent proxy, a UUPS proxy or a beacon proxy is the operations layer's call, and this surface
deliberately supplies no `proxyKind` — that keeps one classification site rather than two that can
drift.

---

## Pattern 3: check instance identity before trusting a manifest

→ [`examples/04-instance-change-and-the-manifest.ts`](./examples/04-instance-change-and-the-manifest.ts)

```ts
const observed = await access.identity();
const result = compareChainInstance(recorded, observed);

if (result.kind === 'changed') {
  throw new ChainInstanceChangedError(result, {
    manifestFile: manifestPathFor(observed.chainId),
    recordCount: records.length,
    endpoint: access.endpoint.describe,
  });
}
```

### Why any of this is necessary

Both of upgrades-core's dev-network accommodations are **off** for TRON, verified at `1.46.0`:

- `dist/provider.js:104-116` — `isDevelopmentNetwork` short-circuits `true` only on chain id `1337`
  or `31337`, then requires a `HardhatNetwork` / `EthereumJS TestRPC` / `anvil` client-version
  prefix. TRON reports `TRON` (`TRON/v4.8.2/Linux/Java17` on a TRE,
  `TRON/v4.8.2/Linux/Java1.8` on mainnet — so the client version identifies TRON but **not** dev
  versus production).
- `dist/manifest.js:30-53` — `getDevInstanceMetadata` returns `undefined` only by **catching** both
  metadata probes, and no TRON node supplies an `instanceId`.

So `dist/manifest.js:63-72` takes the non-dev branch and the manifest lands at the **persistent**
`.openzeppelin/unknown-<chainId>.json` (`dist/manifest.js:78`) rather than an instance-keyed file
under `os.tmpdir()`. It accumulates entries across instances, and the two accommodations that would
have absorbed that are skipped: `dist/impl-store.js:159` never deletes a clashing prior deployment,
and `dist/deployment.js:54` never ignores a stale `InvalidDeployment` and redeploys.

**What the user experiences today, with no plugin-side check:** they wipe their TRE, run a
deployment, and get a hard failure from `checkForAddressClash` with a misleading diagnosis and no
named remedy. The records from the previous boot are still in the file, describing proxies that no
longer exist.

The mechanism that fixes it is chain-observed, not a classification: chain id and genesis hash
**survive** a TRE wipe while **block 1's hash does not** — measured across four boots and two TRE
image versions. So the *same* comparison is a no-op on mainnet and a refusal on a wiped local node,
and nothing in this surface decides whether a chain is a dev node.

### Refuse, name the remedy, discard nothing

When the instance has changed and the manifest still holds prior-instance entries, the policy is to
**refuse**. Not to silently reuse — that is the failure that exists today — and not to silently
discard, because a discarded manifest entry is a lost record of a live proxy if the detection is
ever wrong, and detection *can* be wrong in one direction: a node behind a load balancer serving two
forks reports a change that is true about what it observed but not about the user's intent.

`ChainInstanceChangedError`'s text is owned here and **thrown by you**. Its wording differs by
signal:

- **`chain-id`** — leads with "a different network than the records were written against", the
  strongest claim on this surface, and says the records for the new network belong in that network's
  own manifest file rather than suggesting a deletion.
- **`genesis-hash` / `first-block-hash`** — "a different instance of the same chain", and names
  deleting the manifest file as the remedy *for a disposable local node that has been restarted*,
  with a caution to check the endpoint first if a restart was not expected.

Both begin from "Nothing has been changed or removed", which is structurally true: this directory
has no filesystem access at all.

### `indeterminate` is not a refusal, and must not become one

`compareChainInstance` returns `indeterminate` for a missing record and for an incomplete one. That
is the state **every existing project is in on the first run** after this ships. Treating it as a
refusal would make the feature a breaking change for a condition it cannot tell apart from a first
run.

### Never compare a prefix

Every comparison must be over the whole canonicalized value. TRON block hashes lead with the 8-byte
block height, so *every* chain's block-1 hash begins with the same eight bytes — a prefix comparison
at any width up to 18 characters reports `same` on every wiped node, silently restoring the exact
behaviour the mechanism exists to prevent. If a record format ever stores a truncated fingerprint to
keep records small, it stores something that cannot detect a wipe.

### Name the manifest file from the chain id, not from the comparison

`ChainInstanceChange.observed` is the **disagreeing signal's** value, so for a `genesis-hash` or
`first-block-hash` change it is a block hash. Use `ChainInstanceIdentity.chainId`.

---

## Pattern 4: supply your own transport

→ [`examples/02-supply-your-own-transport.ts`](./examples/02-supply-your-own-transport.ts)

```ts
const access = await createChainAccess(env.chain, {
  endpointOverride: 'https://api.trongrid.io/jsonrpc',
  post: myPoster,
});
```

### When you must

Endpoint precedence is fixed, resolved once, with **no fallback between sources**: a present but
unusable value is refused rather than skipped. When the endpoint you land on names a **different
origin** than the network's own node, the transport question becomes forced:

    deps.post  →  globalThis.fetch (read at factory time)  →  refuse

The refusal is not conservatism. Routing a different-origin request through the node's own HTTP
client would send that client's headers and auth to a host named in an environment variable, because
axios applies an instance's `headers` and `auth` to an **absolute** request URL while ignoring
`baseURL` — and `headers` is precisely where a TronGrid API key is configured. Read
[`safety.md § credentials never cross an origin`](./safety.md#credentials-never-cross-an-origin)
before configuring an override.

**The refusal names `deps.post` as its remedy, and the remedy works.** An earlier draft consulted
`globalThis.fetch` before checking whether `post` had been supplied, so the message stated a fix the
code forbade; that ordering is fixed and the precedence above is what ships. If you supply `post`,
you get it — on the same-origin path too, where the injected seam has always outranked the default.

### What a `JsonRpcPost` owes

```ts
type JsonRpcPost = (payload: unknown) => Promise<unknown>;
```

- **Reject on a non-2xx status, with the status attached** as `status` or `response.status`.
- **Resolve a non-JSON 2xx body as a `string`** — do not reject. That is what axios does, and the
  transport layer detects a reverse proxy's HTML error page on the resolved value's *type*. A poster
  that rejected instead would make the two transports disagree about what that page is.
- **One round-trip. No retry, no backoff, no timeout of your own.** A retry would make a transport
  failure look like a slow success, and would return the second attempt's outcome as if it were the
  first.

### The other three seams

| Seam | Reach for it when |
|---|---|
| `endpointOverride` | You are wiring the endpoint programmatically. It outranks `env`. It is not a user-facing config key — reading `networks[<name>].<key>` is a TronBox-internal path only the seam may read. |
| `env` | You want the `TRONBOX_UPGRADES_RPC_URL` lookup to read something other than `process.env` — a test, or a host that carries its own environment. It is read **once**, at factory time. |
| `probeNativeApi` | You can answer "is the node's native wallet API reachable?" more cheaply or more accurately. It only picks between two wordings of one message and never changes a diagnosis. |

There is **no fifth seam**, and no unprobed constructor. Substituting `post` is how a harness avoids
a live node — which is also how this surface's own test suite runs, with no TRE and no network
anywhere.

---

## Common mistakes

- **Passing `env.chain.tronWrap` to anything in `@openzeppelin/upgrades-core`.** It does not
  compile today. If you find yourself widening a type to make it compile, you are re-opening the
  `/tre` trap.
- **Treating `readAdminAddress`'s zero address as an error.** It is the engine's contract for an
  empty admin slot, and `isTransparentProxy` depends on it.
- **Comparing addresses with `===`.** Use `sameAddress`. The brand on `ChainAddress` is there to
  make an accidental checksummed comparison a compile error rather than a silent manifest miss.
- **Reading `access.provider` results for the three unvalidated methods without checking them.**
  `eth_getTransactionByHash`, `eth_getTransactionReceipt` and `eth_getBlockByNumber` are forwarded
  as the node sent them. See
  [`safety.md`](./safety.md#asengineprovider-bridges-once-and-forwards-three-results-unvalidated).
- **Asking for a historical block.** Only `'latest'` is served, and a height, a named tag or an
  EIP-1898 object is refused locally with `ChainBlockTagRefusedError`. The refusal is uniform
  because the node's behaviour is not: `eth_call` silently answers an EIP-1898 object from *present*
  state, while `eth_getCode` and `eth_getStorageAt` reject the same object as a JSON parse error.
- **Matching on an error message.** Every fact in a message is a field. Matching on
  `ChainRpcError.message` for the diagnosis will not work by design — the kind is in `.diagnosis`
  and deliberately not in the text.
- **Adding a retry, a timeout or a cache.** The timeout is the user's, inherited from the network's
  own client; `send` memoizes nothing on purpose, because a memoizing `send` is a second source of
  truth about the chain inside the one object whose purpose is to be the single translation point.
  Memoization lives on `identity()`, where its scope is one object.
- **Deriving the manifest filename yourself.** Use `manifestPathFor`. It reproduces upstream's own
  `parseInt(hex, 16)` — including honouring `MANIFEST_DEFAULT_DIR` and its truthiness fallback — so
  the name matches the file upgrades-core actually writes, and it re-validates the chain id so a
  value that has crossed a persistence boundary cannot render `unknown-NaN.json`.
- **Catching broadly around a read.** Every catch inside the reader surface is predicated on
  `ChainRpcError` *and* on `isProbeOutcome`. A blanket catch at your call site re-creates the failure
  that predication exists to prevent: the sibling plugin's `slots.ts:getSlot` reroutes on
  `catch (_)` to a local dev-chain URL, so on a public network a transient failure reads ERC-1967
  slots from the wrong chain — and the answer looks plausible.
