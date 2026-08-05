# API reference — `src/chain`

Every export of `src/chain/index.ts` — **81 names** — with full TypeScript signatures. Import
from the directory, never from a module inside it:

```ts
import { createChainAccess, type ChainAccess } from '../chain';
```

Everything that touches the network is **async**. Everything in
[§ Slots, selectors and address helpers](#slots-selectors-and-address-helpers),
[§ Method policy](#method-policy) and [§ Diagnosis](#diagnosis) is synchronous and pure — those
three modules import nothing at all, not even a sibling.

Three names are exported from their own module but deliberately **not** on this face, and their
absence is intentional: `acceptedBlockTag` and `zeroTransactionHash` are probe-argument details,
and `blockHashHexChars` exists for the test that pins the hash width the comparator depends on.

---

## Contents

- [Entry point](#entry-point) — `createChainAccess`, `ChainAccess`, `ChainAccessDependencies`
- [Capability reporting](#capability-reporting) — `verifyCapabilities`, `CapabilityReport`, `CapabilityVerdict`, `RefusalVerdict`
- [The endpoint](#the-endpoint) — `EndpointDescriptor`, `EndpointOrigin`, `JsonRpcPost`, `RPC_URL_ENV_VAR`, `DERIVED_RPC_PATH`, `scrubEndpoint`
- [The reader surface](#the-reader-surface) — `ChainReaders` and its nine readers, `bindChainReaders`, `ProxySlotsRead`, `OptionalCallOutcome`, `BeaconRead`, `slotLabels`
- [Slots, selectors and address helpers](#slots-selectors-and-address-helpers) — `eip1967Slots`, `legacyEip1967Slots`, `selectors`, `slotToAddress`, `toRpcAddress`, `sameAddress`, `ChainAddress`
- [Instance identity](#instance-identity) — `readChainInstanceIdentity`, `compareChainInstance`, `manifestPathFor`, `ChainInstanceIdentity`, `InstanceComparison`
- [Method policy](#method-policy) — `requiredMethods`, `refusedMethods`, `policyFor`, `stringResultMethods`, `blockTagVerdict`
- [Diagnosis](#diagnosis) — `classifyNodeError`, `isProbeOutcome`, `TvmDiagnosis`, `JsonRpcErrorPayload`
- [The lower layer](#the-lower-layer) — `TronEthereumProvider`, `createProvider`, `requireResultShape`, `createRpcChannel`, `RpcChannel`, `JsonRpcOutcome`
- [Errors](#errors) — the eleven-member `TRON_CHAIN_*` family, plus `TransportFailure`

---

## Entry point

### `createChainAccess(chain, deps?)`

```ts
function createChainAccess(
  chain: ChainHandleSlot,
  deps?: ChainAccessDependencies,
): Promise<ChainAccess>;
```

Builds the composite from the seam's `chain` slot (`src/chain/index.ts:203`).

Async because it performs **exactly one** capability probe — `eth_chainId` — so a target network
without the eth-compat JSON-RPC service fails once, up front, naming the capability, rather than
at an arbitrary point inside an operation. One method and not eight, because java-tron registers
the eth-compat methods together at the service level.

The probe's catch is a **discriminating predicate, not a blanket catch**
(`src/chain/index.ts:253-259`): only `ChainTransportError`, `ChainRpcError` and
`ChainResultShapeError` become the capability diagnosis. A defect inside the plugin propagates as
itself rather than being reported to the user as a problem with their node.

There is deliberately **no unprobed variant** — no `createChainAccessUnchecked`, no `skipProbe`,
no lazy mode. Tests substitute `deps.post` instead.

**Throws:**

- `EnvironmentIncompleteError` (`TRONBOX_ENV_INCOMPLETE`) — the `chain` handle does not expose
  `fullNode.host` / `fullNode.request` (`handle-malformed`, preserving the seam's
  `'missing'`/`'threw'` distinction); exposes them with the wrong type (`invariant-violated`); or
  is sound and the endpoint cannot serve eth-compat JSON-RPC (`invariant-violated`, naming the
  capability, the config key, the port pair and the remedy).
- `ChainEndpointRefusedError` (`TRON_CHAIN_ENDPOINT_REFUSED`) — the resolved endpoint is not an
  absolute http(s) URL, points at the host's `/tre` cheatcode path, or is a different-origin
  override on a runtime with no transport that can carry it safely.

### `ChainAccess`

```ts
interface ChainAccess {
  readonly provider: EthereumProvider;      // the engine's own type
  readonly endpoint: EndpointDescriptor;
  identity(): Promise<ChainInstanceIdentity>;
  readonly read: ChainReaders;
}
```

Four members, frozen (`src/chain/index.ts:94`). **No field holds the host handle, anything
reachable from it, or the raw endpoint URL** — both live in closures — so `JSON.stringify(access)`
cannot leak either and does not throw.

- `provider` — the only thing that goes to `@openzeppelin/upgrades-core`. Declared as the engine's
  own `EthereumProvider` so no consumer writes a cast; what that declaration asserts is in
  [`safety.md`](./safety.md#asengineprovider-bridges-once-and-forwards-three-results-unvalidated).
- `endpoint` — see [`EndpointDescriptor`](#endpointdescriptor).
- `identity()` — read once per instance and **memoized as a promise**, so a second call while the
  first is in flight awaits the first rather than issuing a second set of three reads. A rejection
  is memoized too, which is what "at most once per instance" means. `send` itself memoizes
  nothing.
- `read` — see [§ The reader surface](#the-reader-surface).

### `ChainAccessDependencies`

```ts
interface ChainAccessDependencies {
  readonly endpointOverride?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly post?: JsonRpcPost;
  readonly probeNativeApi?: () => Promise<boolean>;
}
```

The complete set of things this surface takes from its environment, each with a stated default
(`src/chain/index.ts:117`). A consumer embedding it in a different host changes configuration, not
source. There is no fifth seam.

| Seam | Default | Why you would supply it |
|---|---|---|
| `endpointOverride` | none — falls through to `env`, then derived | Highest-precedence endpoint source. **Not a user-facing option**: a per-network key in `tronbox-config.js` was rejected because reading `networks[<name>].<key>` is a TronBox-internal property path, permitted only inside `src/environment/**`. |
| `env` | `process.env`, read **once, at factory time** | A module-load read would bake the endpoint into the process, so under `tronbox console` — where switching network mid-session is legitimate — the override would silently keep pointing at the first network. |
| `post` | the handle's own `fullNode.request` same-origin, else `globalThis.fetch` | **Required** for a different-origin endpoint on a runtime with no global `fetch`. Also how tests drive the surface with no node. See [`safety.md`](./safety.md#credentials-never-cross-an-origin). |
| `probeNativeApi` | a GET of `wallet/getnowblock` through the handle | Best-effort. Used **only** to choose between two wordings of the unavailable-capability message; its own failure never changes the diagnosis. |

---

## Capability reporting

### `verifyCapabilities(access)`

```ts
function verifyCapabilities(access: ChainAccess): Promise<CapabilityReport>;
```

Probes all eight required methods and reports each verdict, plus both refusals
(`src/chain/index.ts:379`).

**Not on the hot path** — `createChainAccess` probes one method. This costs eight round-trips and
exists for an end-to-end harness or a diagnostics command. It performs no writes, changes nothing
on the `ChainAccess` it is given, and leaves `identity()`'s memo untouched.

`ok` means **the node served the method**, not "the probe succeeded": a node error about the probe
arguments is evidence the method exists — `eth_call` against the zero address returns
`-32600 "Smart contract is not exist."` on every TRON network — and only `-32601` is evidence it
does not.

The two refusals are **measured rather than restated from the table**: the refusal is driven
through `send` and the resulting `ChainMethodRefusedError` is what sets `refusedLocally`, so a
report claiming a local refusal cannot be produced by a build in which the refusal was softened.

### `CapabilityReport` / `CapabilityVerdict` / `RefusalVerdict`

```ts
interface CapabilityReport {
  readonly endpoint: EndpointDescriptor;
  readonly resolved: readonly CapabilityVerdict[];
  readonly refused: readonly RefusalVerdict[];
}

interface CapabilityVerdict {
  readonly method: string;
  readonly ok: boolean;      // the node served it
  readonly detail?: string;
}

interface RefusalVerdict {
  readonly method: string;
  readonly refusedLocally: boolean;   // true when *this plugin* refused, before any request
}
```

`refusedLocally` exists because a report saying only "`anvil_metadata`: unavailable" is
indistinguishable between "this plugin refuses it by policy" and "this node happens not to serve
it" — and those have opposite implications. The first is a guarantee; the second is a coincidence
the plugin explicitly refuses to depend on (`src/chain/index.ts:151-161`).

---

## The endpoint

### `EndpointDescriptor`

```ts
interface EndpointDescriptor {
  /** `<scheme>://<host>[:<port>]<path>` — userinfo stripped, query and fragment dropped. */
  readonly describe: string;
  readonly origin: EndpointOrigin;
}
```

Exactly two members. There is deliberately **no `url` field**, no `host` field, and no field from
which the raw endpoint can be reconstructed (`src/chain/endpoint.ts:84`). The raw URL exists only
in the transport's closure.

### `EndpointOrigin`

```ts
type EndpointOrigin = 'argument' | 'environment' | 'derived';
```

Which of the three sources supplied the endpoint — reported, never inferred.

### `JsonRpcPost`

```ts
type JsonRpcPost = (payload: unknown) => Promise<unknown>;
```

One JSON-RPC round-trip. Two behavioural obligations, both of which the built-in transports meet:

- **Reject on a non-2xx status with the status attached** as `status` or `response.status` —
  `transport.ts` reads either structurally (`src/chain/transport.ts:108`).
- **Resolve a non-JSON 2xx body as a `string`**, do not reject. That is what axios does, and
  `transport.ts` detects `non-json-body` on the resolved value's *type*
  (`src/chain/transport.ts:153-165`). A poster that rejected instead would make the two transports
  disagree about what a reverse proxy's error page is.

Do not retry and do not set a timeout. See
[`safety.md § the timeout is the user's`](./safety.md#the-timeout-is-the-users-and-nothing-accumulates).

### `RPC_URL_ENV_VAR` / `DERIVED_RPC_PATH`

```ts
const RPC_URL_ENV_VAR = 'TRONBOX_UPGRADES_RPC_URL';
const DERIVED_RPC_PATH = 'jsonrpc';
```

The environment variable that overrides the derived endpoint, and the path appended to
`fullNode.host` to derive it (`src/chain/endpoint.ts:105`, `:108`).

### `scrubEndpoint(url)`

```ts
function scrubEndpoint(url: URL): string;
```

Strips **userinfo**, drops the **query** and the **fragment**, keeps scheme, host, port and path
(`src/chain/endpoint.ts:233`). Idempotent — scrubbing its own output re-parses to the same value —
and total: it cannot throw for an input that reached it, because only an already-parsed `URL` does.

---

## The reader surface

### `ChainReaders`

```ts
interface ChainReaders {
  hasCode(address: string): Promise<boolean>;
  readImplementationAddress(proxy: string): Promise<ChainAddress>;
  readAdminAddress(proxy: string): Promise<ChainAddress>;
  readBeaconAddress(proxy: string): Promise<ChainAddress>;
  readProxySlots(address: string, slots?: readonly SlotLabel[]): Promise<ProxySlotsRead>;
  tvmCallOptional(address: string, selector: string): Promise<OptionalCallOutcome>;
  readUpgradeInterfaceVersion(address: string): Promise<string | undefined>;
  looksLikeProxyAdmin(address: string): Promise<boolean>;
  readBeaconImplementation(beacon: string): Promise<BeaconRead>;
}
```

**Every one of these is also a free function taking a `TronEthereumProvider` as its first
parameter** (`src/chain/read.ts:1-28`), and `bindChainReaders` is a thin binding, so
`access.read.readProxySlots(a)` and `readProxySlots(provider, a)` produce identical results and
identical request sequences.

That shape is why "exactly one translation point" is structural rather than a rule: free functions
that each construct their own transport are how the sibling plugin ended up with two — reading the
implementation slot through one and *verifying* it through the other, so its post-upgrade check can
compare answers about two different addresses. Taking `send` as a parameter means a second
transport has to be passed in explicitly, at a call site someone reviews.

**No catch in this module is unpredicated.** Every one is gated on `ChainRpcError` *and* on
`isProbeOutcome(diagnosis)`. A transport failure is never converted into a no-answer, a `false`, a
zero address, an empty slot or `undefined`.

### `bindChainReaders(send)`

```ts
function bindChainReaders(send: TronEthereumProvider): ChainReaders;
```

`src/chain/read.ts:469`.

### `hasCode(send, address)`

```ts
function hasCode(send: TronEthereumProvider, address: string): Promise<boolean>;
```

One round-trip (`src/chain/read.ts:171`). Mirrors `provider.js:isEmpty` —
`code.replace(/^0x/, '') === ''`.

### `readImplementationAddress(send, proxy)`

```ts
function readImplementationAddress(
  send: TronEthereumProvider,
  proxy: string,
): Promise<ChainAddress>;
```

Modern slot, then the legacy (`org.zeppelinos.*`) fallback, stopping at the first non-empty — so
a lookup can cost **two** storage reads (`src/chain/read.ts:182`).

**Throws** `ChainImplementationNotFoundError` when both slots are empty, mirroring the engine's
`EIP1967ImplementationNotFound`, which also throws.

### `readAdminAddress(send, proxy)`

```ts
function readAdminAddress(
  send: TronEthereumProvider,
  proxy: string,
): Promise<ChainAddress>;
```

Returns the **zero address** for an empty slot rather than throwing (`src/chain/read.ts:204`).

This asymmetry is the engine's and is mirrored rather than smoothed:
`eip-1967-type.js:isTransparentProxy` is `!isEmptySlot(adminAddress)`, so a reader that threw here
would make that predicate throw instead of returning `false` — and the plugin would disagree with
the engine about whether an address is a proxy. There is deliberately **no
`ChainAdminNotFoundError`**, and its absence is the design.

### `readBeaconAddress(send, proxy)`

```ts
function readBeaconAddress(
  send: TronEthereumProvider,
  proxy: string,
): Promise<ChainAddress>;
```

**Throws** `ChainBeaconNotFoundError` for an empty slot, mirroring `EIP1967BeaconNotFound`. A
beacon has **no legacy fallback slot**, so there is no second place to look — the engine passes
one slot where the other two pass two, and that asymmetry is mirrored too
(`src/chain/read.ts:161`).

### `readProxySlots(send, address, slots?)`

```ts
function readProxySlots(
  send: TronEthereumProvider,
  address: string,
  slots?: readonly SlotLabel[],   // defaults to `slotLabels` — all three
): Promise<ProxySlotsRead>;
```

The minimum that makes "nothing is deployed here" and "this is not a proxy" distinguishable,
without deciding proxy *kind* (`src/chain/read.ts:237`).

**One `eth_getCode` first**, and the slot reads happen only if there is code — so a no-code
address costs **one** round-trip rather than six, which is the observable that proves the ordering.
Bounded at 6 for all three slots, and the bound does not depend on chain data, which is why the
requested labels are de-duplicated.

Proxy-kind *judgment* stays with the operations layer. This returns what the slots say, never what
it means.

```ts
type ProxySlotsRead =
  | { readonly kind: 'no-code' }
  | {
      readonly kind: 'code';
      /** `null` means the slot is a zero word — modern *and* legacy where one exists. */
      readonly implementation: ChainAddress | null;
      readonly admin: ChainAddress | null;
      readonly beacon: ChainAddress | null;
    };
```

### `tvmCallOptional(send, address, selector)`

```ts
function tvmCallOptional(
  send: TronEthereumProvider,
  address: string,
  selector: string,
): Promise<OptionalCallOutcome>;

type OptionalCallOutcome =
  | { readonly kind: 'answered'; readonly data: string }
  | {
      readonly kind: 'no-answer';
      readonly because: 'reverted' | 'no-contract-at-address';
    };
```

The replacement for upstream's `callOptionalSignature`, and the reason no message translation is
needed (`src/chain/read.ts:292`).

Only a `ChainRpcError` whose diagnosis satisfies `isProbeOutcome` returns a `no-answer`. A
transport failure, a wrong-shaped result and an `unclassified` node error all **raise** — so "out
of energy", which arrives on the same `-32000` as a revert and has a real remedy, cannot silently
disable a safety check.

It sends `[{to, data}, 'latest']` with no `from` and no `gas`, mirroring the engine's own `call`
so the node sees the same request shape from both.

### `readUpgradeInterfaceVersion(send, address)`

```ts
function readUpgradeInterfaceVersion(
  send: TronEthereumProvider,
  address: string,
): Promise<string | undefined>;
```

Replaces `getUpgradeInterfaceVersion`. Same ABI-string decode and the same `offset !== 32` guard
as `upgrade-interface-version.js`, including its reason: a fallback function can answer this call
with something that is not a string, and upstream deliberately returns `undefined` rather than
throwing for that (`src/chain/read.ts:390`).

**This is the one permitted `| undefined` in the whole surface**, and it mirrors upstream's
documented contract for a present, answering contract with no such getter.

### `looksLikeProxyAdmin(send, address)`

```ts
function looksLikeProxyAdmin(
  send: TronEthereumProvider,
  address: string,
): Promise<boolean>;
```

Replaces `inferProxyAdmin`. Returns `false` only for a classified probe outcome or a non-address
answer, and **raises otherwise** — upstream returns `false` for a *swallowed* error, which
silently disables a safety check (`src/chain/read.ts:416`).

### `readBeaconImplementation(send, beacon)`

```ts
function readBeaconImplementation(
  send: TronEthereumProvider,
  beacon: string,
): Promise<BeaconRead>;

type BeaconRead =
  | { readonly kind: 'implementation'; readonly address: ChainAddress }
  | { readonly kind: 'no-code-at-beacon' }
  | {
      readonly kind: 'not-a-beacon';
      readonly because: 'call-did-not-answer' | 'answer-is-not-an-address';
    };
```

Replaces `getImplementationAddressFromBeacon` / `isBeacon`. Probes `eth_getCode` **first**, which
is what separates the two conditions upstream collapses into `InvalidBeacon` — a user with nothing
deployed at the address is told their contract "doesn't look like a beacon", and the correct
action, check the address, is not among the ones the message suggests (`src/chain/read.ts:435`).

One round-trip with no code, exactly two with code.

### `slotLabels`

```ts
const slotLabels: readonly ['implementation', 'admin', 'beacon'];
```

`readProxySlots`'s default (`src/chain/read.ts:104`).

---

## Slots, selectors and address helpers

Everything in this section is **pure and importless** — `src/chain/slots.ts` imports nothing, not
from the host, not from the engine, not from a Node built-in, not from a sibling.

### `eip1967Slots` / `legacyEip1967Slots`

```ts
const eip1967Slots: Readonly<Record<SlotLabel, string>>;
const legacyEip1967Slots: Readonly<Record<'implementation' | 'admin', string>>;
```

The three modern ERC-1967 slot keys and the two legacy (`org.zeppelinos.*`) fallbacks
(`src/chain/slots.ts:128`, `:144`). **Beacon has no legacy fallback**, mirroring
`eip-1967.js:getBeaconAddress`.

Published as literals because the engine hardcodes none of them — it derives all five at each call
site — but they are a **pinned** copy: a test re-runs the engine's own derivation and compares, so
a bump that changed the hashing fails a test instead of quietly asking `eth_getStorageAt` about a
different slot than the engine reads.

### `selectors`

```ts
const selectors: {
  readonly upgradeInterfaceVersion: '0xad3cb1cc';   // UPGRADE_INTERFACE_VERSION()
  readonly owner: '0x8da5cb5b';                     // owner()
  readonly implementation: '0x5c60da1b';            // implementation()
};
```

`keccak256(signature)[0:4]` of three fixed strings, as constants — computing them at runtime would
buy nothing and cost a keccak dependency the package does not have
(`src/chain/slots.ts:160`). Pinned the same way as the slot keys.

### `zeroSlotWord` / `zeroChainAddress`

```ts
const zeroSlotWord: string;              // '0x' + 64 zeros
const zeroChainAddress: ChainAddress;    // minted through slotToAddress, like every other
```

`src/chain/slots.ts:170`, `:257`.

### `ChainAddress`

```ts
type ChainAddress = string & { readonly [ChainAddressBrand]: 'lowercase-hex' };
```

A 20-byte address in **lowercase** `0x` hex, exactly as derived from a storage word
(`src/chain/slots.ts:35`).

**Not checksummed, and the brand is what stops that from being a silent bug.** upgrades-core
compares addresses with `===` while reading its own manifest, so a casing mismatch silently drops
a recorded proxy kind and layout — which is why canonicalization has exactly one home, and it is
the record layer's boundary, not this one. That layer is expected to define its own brand for the
canonical form, so assignment fails in both directions.

For comparison use [`sameAddress`](#sameaddressa-b). Never `===`.

### `SlotLabel`

```ts
type SlotLabel = 'implementation' | 'admin' | 'beacon';
```

### `isEmptySlotWord(word)`

```ts
function isEmptySlotWord(word: string): boolean;
```

Decides emptiness without assuming a fixed length and without any construction that throws on a
short input (`src/chain/slots.ts:200`). The engine's own `eip-1967.js:isEmptySlot` is
`BigInt(storage.replace(/^(0x)?/, '0x')) === 0n`, which throws `SyntaxError` on `'0x'` — TRON
always returns a full 64-character word so that hazard does not fire today, but that is a property
of java-tron, not of this function.

A value that is not hex at all is reported **not empty**, so the caller's next step is
`slotToAddress`, which refuses it by name. Reporting it empty would turn garbage into "this slot
is unset", which is a fact rather than a failure and would be believed.

### `looksLikeSlotAddressWord(word)`

```ts
function looksLikeSlotAddressWord(word: string): boolean;
```

The total counterpart of `slotToAddress` (`src/chain/slots.ts:217`). Mirrors what
`utils/address.js:parseAddress` answers with `undefined`, which is how `inferProxyAdmin` decides
whether an `owner()` answer is an address. A predicate rather than a throw is what lets
`looksLikeProxyAdmin` return `false` for a non-address answer without conflating it with a failure.

### `slotToAddress(word)`

```ts
function slotToAddress(word: string): ChainAddress;
```

The last 20 bytes of a 32-byte word, **validated** (`src/chain/slots.ts:235`). Exactly 32 bytes of
hex, top 12 bytes zero, or it throws. The `0x` prefix is optional, which is safe because the
32-byte and top-12-zero checks still apply to the digits — it matches the engine's own
`storage.replace(/^(0x)?/, '0x')` idiom.

Never produces a value by truncation alone. The sibling plugin's version is
`'0x' + slotValue.slice(-40)` with no check, so a `'0x'` result yields the string `'0x0x'` and a
`null` throws a bare `TypeError` — either way a wrong-looking address flows into a proxy-kind
decision.

**Throws** `ChainSlotMalformedError`.

### `sameAddress(a, b)`

```ts
function sameAddress(a: string, b: string): boolean;
```

The only sanctioned address comparison: case-insensitive, `0x`-optional, **length-checked**
(`src/chain/slots.ts:268`).

Length-checked because a comparison that passes for two strings which are not both addresses is
worse than useless: `sameAddress('0x', '0x')` must be `false`, or "no address" equals "no address"
and a missing implementation matches a missing implementation.

### `toRpcAddress(address)`

```ts
function toRpcAddress(address: string): string;
```

Canonicalizes an inbound address argument to `0x`-prefixed 20-byte hex
(`src/chain/slots.ts:299`). Measured tolerance on java-tron: `0x`-prefixed accepted, bare hex
accepted, `41`-prefixed TRON hex accepted, **Base58 `T…` rejected**.

Base58 is refused **here, naming Base58**, rather than forwarded — measured live, `eth_getCode`
with `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` returns
`-32602 exception decoding Hex string: invalid characters encountered in Hex string`. Forwarded,
that reaches a user who supplied the address in the form TronBox itself prints everywhere, as a
node-level hex-decoding complaint: the wrong layer, the wrong vocabulary, and no statement of what
to do.

**Throws** `ChainAddressUnusableError`.

---

## Instance identity

### `readChainInstanceIdentity(send, endpoint)`

```ts
function readChainInstanceIdentity(
  send: TronEthereumProvider,
  endpoint: EndpointDescriptor,
): Promise<ChainInstanceIdentity>;
```

Three round-trips: `eth_chainId`, then `eth_getBlockByNumber` at `0x0` and `0x1` with `false` for
full transactions (`src/chain/instance.ts:163`). Normally reached through
`ChainAccess.identity()`, which memoizes it.

`eth_getBlockByNumber` is the **eighth** method — this plugin's own, which upgrades-core never
calls. It is safe to depend on for a reason worth stating: java-tron's *block-query* methods accept
heights and named tags, while its *state* methods accept only `latest`. Do not generalize either
way.

It also performs a free internal cross-check: **the chain id is the last four bytes of the genesis
hash** (`0x…4196a1d22b6653dc` vs `0x2b6653dc`, confirmed live on mainnet). A disagreement means the
endpoint answered two questions from two different chains — a load balancer in front of two nodes,
most plausibly — and that is reported as a **transport-level inconsistency**
(`ChainTransportError` with `malformed-envelope`) rather than an instance change, because "the
chain changed" would be a claim about *a* chain, and there are two.

### `ChainInstanceIdentity`

```ts
interface ChainInstanceIdentity {
  /** `0x` + lowercase hex, reduced to its minimal form. */
  readonly chainId: string;
  /** Block 0's hash, `0x` + 64 lowercase hex, leading zeros preserved. */
  readonly genesisHash: string;
  /** Block 1's hash — the only per-boot signal. `null` when there is no block 1 yet. */
  readonly firstBlockHash: string | null;
  /** Scrubbed endpoint that answered. Diagnostic only; never a comparison operand. */
  readonly observedThrough: string;
}
```

Every field that participates in a comparison is **canonicalized before it is returned**
(`src/chain/instance.ts:36`). Hashes keep their leading zeros — a hash is a fixed-width value, so
stripping them would not normalize it, it would destroy it. TRON block hashes lead with the 8-byte
block height, so block 1's hash *begins* with fifteen zeros and a one.

`firstBlockHash === null` is a **result, not a failure**: measured live,
`eth_getBlockByNumber('0xfffffffff')` returns `{"result":null}`.

### `RecordedChainInstance`

```ts
interface RecordedChainInstance {
  readonly chainId: string;
  readonly genesisHash?: string;
  readonly firstBlockHash?: string | null;
}
```

What the record layer persists — a **subset**, so a partially written record is representable and
reads as `indeterminate` rather than as a change (`src/chain/instance.ts:56`).

### `compareChainInstance(recorded, observed)`

```ts
function compareChainInstance(
  recorded: RecordedChainInstance | undefined,
  observed: ChainInstanceIdentity,
): InstanceComparison;

type InstanceComparison =
  | { readonly kind: 'same' }
  | ChainInstanceChange
  | {
      readonly kind: 'indeterminate';
      readonly because: 'no-recorded-identity' | 'recorded-identity-incomplete';
    };

interface ChainInstanceChange {
  readonly kind: 'changed';
  readonly signal: 'chain-id' | 'genesis-hash' | 'first-block-hash';
  readonly recorded: string | null;
  readonly observed: string | null;
}
```

**Pure and total** — no I/O, no ambient state, a defined answer for every input
(`src/chain/instance.ts:252`). Signals are compared chain-id → genesis-hash → first-block-hash, and
the disagreeing one is reported so the message can differ: a chain-id change means a *different
network*, which is a stronger statement than a wipe.

Both sides are canonicalized here rather than trusted, so a record written by an older writer in a
different casing does not read as a different chain.

**Every comparison is over the entire canonicalized value** — no prefix, no suffix, no truncation,
no fixed-width slice. Because a TRON block hash leads with the block height, *every* chain's
block-1 hash begins with the same eight bytes, and a prefix comparison at any width up to 18
characters reports `same` on every wiped node. The discriminating material is only the trailing 24
bytes.

**`indeterminate` never produces a refusal**, and that clause is load-bearing: it is the state
every existing project is in on the first run after this ships.

> Note on `ChainInstanceChange.observed`: it is the **disagreeing signal's** value, so for a
> `genesis-hash` or `first-block-hash` change it is a block hash, not a chain id. Name a manifest
> file from `ChainInstanceIdentity.chainId`, never from this member.

### `manifestPathFor(chainId, env?)`

```ts
function manifestPathFor(
  chainId: string,
  env?: Readonly<Record<string, string | undefined>>,
): string;
```

The file the refusal message has to be able to name (`src/chain/instance.ts:327`).

`provider.js:networkNames` has 26 entries and **no TRON chain id**, so every TRON network resolves
to `unknown-<decimal>` — a name no user would guess unaided, which is exactly why the refusal has
to cite it:

| network | `eth_chainId` | resolves to |
|---|---|---|
| Mainnet | `0x2b6653dc` | `.openzeppelin/unknown-728126428.json` |
| Nile | `0xcd8690dc` | `.openzeppelin/unknown-3448148188.json` |
| Shasta | `0x94a9059e` | `.openzeppelin/unknown-2494104990.json` |
| TRE (local) | `0xc845df2f` | `.openzeppelin/unknown-3360022319.json` |

The decimal is computed with the **same** `parseInt(hex, 16)` upstream uses in `getChainId`,
because the name has to match the file upgrades-core actually writes — not because that parse is a
good one. `stringResultMethods.eth_chainId`'s guard is what makes it safe, and the guard is
re-applied here rather than assumed, since a caller may pass a value that has crossed a persistence
boundary.

Honours `MANIFEST_DEFAULT_DIR` through `env`, including upstream's truthiness fallback
(`process.env.MANIFEST_DEFAULT_DIR || '.openzeppelin'`), so an empty value behaves the same way
here as it does there.

**Throws** `ChainResultShapeError` when the chain id is not a hex quantity that parses to a
positive integer — the condition that otherwise renders `.openzeppelin/unknown-NaN.json`, a file no
later run consults.

---

## Method policy

Four tables as **data**, not `switch` statements (`src/chain/policy.ts:1-20`). A test can read a
table; it can only restate a `switch`. `src/chain/policy.ts` imports nothing.

### `requiredMethods`

```ts
const requiredMethods: readonly [
  'eth_chainId',
  'web3_clientVersion',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_call',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
];
```

The engine's seven, plus `eth_getBlockByNumber` — the eighth, which is this plugin's own and which
upgrades-core never calls (`src/chain/policy.ts:58`). That is exactly why removing it as "unused"
would silently disable the instance fingerprint while every engine-facing test still passed.

### `refusedMethods`

```ts
const refusedMethods: readonly ['anvil_metadata', 'hardhat_metadata'];
```

`src/chain/policy.ts:44`. See
[`safety.md § the two refusals`](./safety.md#the-two-refusals-are-an-obligation-not-a-gap).

### `methodPolicies` / `policyFor(method)` / `MethodPolicy`

```ts
type MethodPolicy =
  | { readonly kind: 'forward' }
  | { readonly kind: 'refuse'; readonly because: string };

const methodPolicies: Readonly<Record<string, MethodPolicy>>;
function policyFor(method: string): MethodPolicy;   // defaults to 'forward'
```

`src/chain/policy.ts:74`, `:90`.

### `stringResultMethods` / `ResultShapeRule`

```ts
interface ResultShapeRule {
  readonly describe: string;                          // rendered in the refusal
  accepts(value: unknown): value is string;
}

const stringResultMethods: Readonly<Record<string, ResultShapeRule>>;
```

The five methods whose result upgrades-core reads **unguarded**, each with *that method's* required
shape (`src/chain/policy.ts:152`), cited per method and verified at `1.46.0`:

| Method | Upstream read | Required shape |
|---|---|---|
| `eth_chainId` | `provider.js:getChainId` — `id.replace(/^0x/, '')` | a `0x` hex quantity parsing to a **positive** integer |
| `web3_clientVersion` | `provider.js:113` — `clientVersion.split('/', 1)` | a non-empty string |
| `eth_getStorageAt` | `provider.js:getStorageAt` | a `0x`-prefixed hex storage word |
| `eth_getCode` | `provider.js:isEmpty` | `0x`-prefixed hex, or exactly `'0x'` |
| `eth_call` | `upgrade-interface-version.js:13` | `0x`-prefixed hex return data |

`typeof value === 'string'` is the floor, not the check, and measurably insufficient for the one
method whose value becomes the manifest key. `getChainId` is
`parseInt(id.replace(/^0x/, ''), 16)`, and `parseInt` is not a validator:

- `'728126428'` — a **decimal** chain id, which is what java-tron itself returns from `net_version`
  — parses as hex to `30737065000`, and the manifest becomes
  `.openzeppelin/unknown-30737065000.json`.
- `'0x'`, `''`, `'0xzz'` and `'TRON/v4.8.2/Linux/Java1.8'` all parse to **`NaN`**, rendering
  `.openzeppelin/unknown-NaN.json`.

Either way every deployment record for that network lands in a file no later run consults, with no
error at any layer and no symptom until the next upgrade reports the proxy as unregistered.

The three methods **deliberately absent** from this table are
`eth_getTransactionByHash`, `eth_getTransactionReceipt` and `eth_getBlockByNumber` — see
[`safety.md`](./safety.md#asengineprovider-bridges-once-and-forwards-three-results-unvalidated).

### `blockTagIndex` / `blockTagVerdict(method, params)` / `BlockTagVerdict`

```ts
const blockTagIndex: Readonly<Record<string, number>>;   // getStorageAt: 2, getCode: 1, call: 1

type BlockTagVerdict =
  | { readonly kind: 'accept' }
  | { readonly kind: 'refuse'; readonly because: string };

function blockTagVerdict(method: string, params: readonly unknown[]): BlockTagVerdict;
```

The index differs per method, which is why it is a table and not a constant: `call` sends
`[{to, data}, block]` with no `from` and no `gas` (`src/chain/policy.ts:182`).

`blockTagVerdict` refuses `pending | earliest | finalized | safe`, a numeric height, and an
**EIP-1898 block object** — for **every** method carrying a block parameter, uniformly, even though
the node's own handling is not uniform (`src/chain/policy.ts:237`). The non-uniformity is exactly
why the refusal must be uniform; measured live:

- `eth_call` with `{"blockNumber":"0x1"}` is validated and then **silently answered from present
  state** — present-day data for a historical question, with no error at all.
- The same object on `eth_getCode` and `eth_getStorageAt` returns `-32700 "JSON parse error"` — a
  message naming JSON parsing rather than the block tag.
- A numeric height returns `-32602 "QUANTITY not supported, just support TAG as latest"`;
  `pending` returns `-32602 "TAG [earliest | pending | finalized | safe] not supported"`.

One method answers a question it was not asked and two refuse for the wrong stated reason. Every
`provider.js` reader defaults to `'latest'`, so this refuses nothing upstream sends today — it
refuses what a later caller might, including a third party who reads the catch-all overload and
reasonably assumes historical reads work.

---

## Diagnosis

`src/chain/classify.ts` imports nothing.

### `JsonRpcErrorPayload`

```ts
interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}
```

A **validated** node error: `code` is a number and `message` is a string *by the time this type
exists*, because `transport.ts` refuses anything else as `malformed-envelope`
(`src/chain/classify.ts:22`). That single validation is why classification never needs to walk a
nested `error.error.message`.

java-tron carries revert data in `data` only from v4.8.1; below that there is a message and no
payload, and when there is no payload it is the **literal string `"{}"`**, not absent — confirmed
live on 4.8.2, where *non-revert* errors carry `"{}"` too. So `data`'s presence proves nothing and
any decoding is gated on a `0x` prefix.

### `TvmDiagnosis` / `ProbeDiagnosis`

```ts
type TvmDiagnosis =
  | { readonly kind: 'no-contract-at-address' }                              // -32600 + "not exist"
  | { readonly kind: 'reverted'; readonly revertData?: string }              // -32000 + names REVERT
  | { readonly kind: 'method-unsupported' }                                  // -32601
  | { readonly kind: 'argument-rejected' }                                   // -32602
  | { readonly kind: 'unclassified' };                                       // anything else

type ProbeDiagnosis = Extract<
  TvmDiagnosis,
  { readonly kind: 'no-contract-at-address' | 'reverted' }
>;
```

Two of the five members are normal control flow for a probe; three are failures
(`src/chain/classify.ts:44`).

Keeping `no-contract-at-address` distinct from `reverted` is the whole point: the sibling plugin
tells a user their address "is not an upgradeable beacon: its `implementation()` getter did not
return an address" when in fact nothing is deployed there at all.

### `classifyNodeError(error)`

```ts
function classifyNodeError(error: JsonRpcErrorPayload): TvmDiagnosis;
```

Keys on JSON-RPC `code` **first** and on the message only to disambiguate within a code — never
message alone (`src/chain/classify.ts:127`). Performs no nested traversal of `error.error`,
`error.cause` or `error.data`.

The sibling's predicate matches a bare `revert` case-insensitively anywhere in any message, which
also matches a contract-authored or node-authored string containing the word — and its riskiest
consumer turns a false positive into a **silently disabled safety check**.

### `isProbeOutcome(diagnosis)`

```ts
function isProbeOutcome(diagnosis: TvmDiagnosis): diagnosis is ProbeDiagnosis;
```

`true` iff the diagnosis is a normal outcome of a probe — exactly two members
(`src/chain/classify.ts:166`). Written as an exhaustive `switch` so a sixth `TvmDiagnosis` member
forces a decision at compile time rather than falling into a permissive default. The
`default: return true` arm is the natural way to write this function, and is the reason the
two-member rule is stated rather than implied.

`unclassified` is **not** a probe outcome: "out of energy" arrives on the same `-32000` as a revert
and is a real failure with a real remedy — raise the fee limit, or fund the account.

---

## The lower layer

Normally reached only through `createChainAccess`. Exported because the readers and the instance
functions must be callable with a bare `{ send }` object, and because a consumer with its own HTTP
stack composes the two layers directly.

### `TronEthereumProvider`

```ts
interface TronEthereumProvider {
  send(method: string, params: readonly unknown[]): Promise<unknown>;
}
```

The internal seam — deliberately loose (`src/chain/provider.ts:27`). This is **web3-style `send`,
not EIP-1193**, and the shape is not a choice: at upgrades-core `1.46.0`,
`node_modules/@openzeppelin/upgrades-core/dist/provider.d.ts:2-13` declares twelve `send`
signatures — eleven method-specific plus one catch-all — and **no `request`**.

`ChainAccess.provider` is the engine's own `EthereumProvider` instead, so consumers need no cast.
The bridge between the two happens exactly once, at `src/chain/index.ts:76`.

### `createProvider(channel)`

```ts
function createProvider(channel: RpcChannel): TronEthereumProvider;
```

`src/chain/provider.ts:79`. The returned `send`:

1. looks up the method policy and **throws before touching the channel** for a refused method, so a
   refusal issues **zero** network requests;
2. checks the block tag and refuses locally;
3. resolves a validated `string` for the five gated methods, and the node's value **unwrapped and
   untouched** for everything else;
4. throws `ChainRpcError` for a node error and `ChainTransportError` for a transport failure.

**`send` memoizes nothing** (`src/chain/provider.ts:64-78`). N calls with the same arguments produce
N round-trips. `eth_chainId` is immutable per instance and the engine calls it on every
`Manifest.forNetwork`, so memoizing here is the obvious optimization — and it would put a second
source of truth about the chain inside the one object whose entire purpose is to be the single
translation point, with an unbounded staleness window, because a `tronbox console` session can
switch network under it. Memoization lives on `ChainAccess.identity()`, where its scope is one
object.

It also **freezes nothing it returns**, and that is deliberate rather than lax:
`provider.js:getTransactionReceipt` does `receipt.status = …` in a `"use strict"` module, guarded by
`if (receipt?.status)`. A frozen result would pass every test that polls a not-yet-mined
transaction (`result: null`) and throw `TypeError: Cannot assign to read only property 'status'`
only when the receipt finally arrives — i.e. on the **success** path of every deploy, after the
transaction is already on chain.

### `requireResultShape(method, value)`

```ts
function requireResultShape(method: string, value: unknown): string;
```

Narrows a resolved result to the shape *that method's* consumer requires
(`src/chain/provider.ts:46`). Exported because the readers and instance functions are reachable with
a bare `{ send }` object that never went through this module, and one predicate table is what keeps
the two boundaries from disagreeing.

**Throws** `ChainResultShapeError`, including for a method the table does not describe — which is a
defect in this plugin rather than a fact about the node, and is named as such instead of being waved
through.

### `createRpcChannel(endpoint, post)`

```ts
function createRpcChannel(endpoint: EndpointDescriptor, post: JsonRpcPost): RpcChannel;

interface RpcChannel {
  readonly endpoint: EndpointDescriptor;
  post(request: JsonRpcRequest): Promise<JsonRpcOutcome>;
}

interface JsonRpcRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}
```

One channel per `ChainAccess` (`src/chain/transport.ts:245`). The request-id counter lives on the
**instance**, in the closure, never at module scope — a shared counter would make one channel's ids
depend on another's traffic, turning a diagnostic into noise.

**Exactly one HTTP round-trip per `post`.** No retry, no backoff, no timer, no queue, no rate
limiter. The only retained state is a number.

### `JsonRpcOutcome`

```ts
type JsonRpcOutcome =
  | { readonly kind: 'result'; readonly result: unknown }
  | { readonly kind: 'node-error'; readonly error: JsonRpcErrorPayload }
  | { readonly kind: 'transport-failure'; readonly cause: TransportFailure };
```

**No member carries both a result and an error** (`src/chain/transport.ts:44`). `outcome.result` is
only reachable inside the `'result'` branch, so a passthrough returning the envelope instead of
`envelope.result`, or one that resolves `{error}` instead of raising, cannot be written without
changing this type.

That split — the function that returns a result is a different function from the one that inspects
the envelope — is what makes upstream's `Broken invariant` abort **structurally unreachable** rather
than avoided by convention. A `try/catch` inside a single `send` cannot express this union, so the
trap cannot be reached by "simplifying" the transport.

Two envelope-reading decisions worth knowing:

- **The `id` is diagnostic only and never a discriminator** (`src/chain/transport.ts:153`). A
  response whose id does not match is classified on its `result`/`error` content alone. Measured
  live: java-tron answers a request carrying `"id": 7` with `"id": "null"` — the JSON **string** —
  whenever it returns `-32700`, which is exactly what an EIP-1898 block object on a state method
  produces. Treating a mismatched id as malformed would discard a real, well-formed node error's
  code and message. Correlation buys nothing to offset it: one request per round-trip, never
  batched.
- **`result: null` is a legitimate result**, not a failure. `eth_getBlockByNumber('0xfffffffff')`
  returns `{"result":null}`, so "there is no such block" is an answer.

---

## Errors

Eleven classes, one closed `TRON_CHAIN_*` namespace, no two sharing a code, each with one condition
and one remedy. Every one is an `Error` with a non-empty string `message`, and that is
load-bearing rather than tidy: upstream's `call-optional-signature.js:12` reads `e.message`
**unguarded** inside its catch, so a thrown string or a message-less object would raise a secondary
`TypeError` *inside upstream's error handler*, replacing the diagnosis with a stack trace from a
module the user has never heard of.

**Narrow on the class or on `code`, never on the message.** Every fact in a message is also
reachable as a field, and no message and no enumerable property carries the raw endpoint URL —
every `endpoint` below is the **scrubbed** form.

Any node- or network-supplied text in a message is bounded at 200 characters with the total length
stated. The bound is not hygiene: the measured transport failure a reverse proxy produces is an
HTML error page, and axios resolves a non-JSON 2xx body as a **string** rather than rejecting, so
the whole page is in hand at the moment the failure is described — and if the proxy echoes request
headers, which error pages do, embedding it is also a leak.

> **Two of the eleven are declared in `src/chain/slots.ts` and re-exported** —
> `ChainSlotMalformedError` and `ChainAddressUnusableError` — because that module must import
> nothing and an `Error` subclass needs no import. **Depend on the behaviour, not the layout:**
> class identity is the same object on both import routes, so `instanceof` does not depend on which
> one you used, and both are constructible through the error module. The arrangement is deliberate
> and cheap to reverse — it is a file move — so depend on the behaviour, not the layout.

| Class | `code` | Condition | Fields beyond `message` |
|---|---|---|---|
| `ChainMethodRefusedError` | `TRON_CHAIN_METHOD_REFUSED` | `anvil_metadata` or `hardhat_metadata`, refused from a table before any request | `method`, `because` |
| `ChainBlockTagRefusedError` | `TRON_CHAIN_BLOCK_TAG_REFUSED` | A block tag or EIP-1898 object the node cannot honour | `method`, `because` |
| `ChainEndpointRefusedError` | `TRON_CHAIN_ENDPOINT_REFUSED` | Endpoint not http(s) / not absolute; path ends in `/tre`; different-origin with no usable transport | `source`, `because` |
| `ChainRpcError` | `TRON_CHAIN_RPC_ERROR` | A node error that is not a probe outcome | `method`, `rpcCode`, `rpcMessage`, `rpcData`, `diagnosis`, `endpoint` |
| `ChainTransportError` | `TRON_CHAIN_TRANSPORT` | No JSON-RPC answer at all | `method`, `cause: TransportFailure`, `endpoint` |
| `ChainResultShapeError` | `TRON_CHAIN_RESULT_SHAPE` | A gated method resolved a value of the wrong shape | `method`, `expected`, `observed` |
| `ChainImplementationNotFoundError` | `TRON_CHAIN_IMPLEMENTATION_NOT_FOUND` | Both implementation slots empty | `address` |
| `ChainBeaconNotFoundError` | `TRON_CHAIN_BEACON_NOT_FOUND` | The beacon slot is empty (no legacy fallback exists) | `address` |
| `ChainInstanceChangedError` | `TRON_CHAIN_INSTANCE_CHANGED` | The chain reports a different instance than the records were written against | `comparison`, `context: { manifestFile, recordCount, endpoint }` |
| `ChainSlotMalformedError` | `TRON_CHAIN_SLOT_MALFORMED` | A storage word is not 32 bytes carrying a 20-byte address | `because` |
| `ChainAddressUnusableError` | `TRON_CHAIN_ADDRESS_UNUSABLE` | An inbound address is Base58, or not a 20-byte address in any accepted encoding | `because` |

### `ChainRpcError` — the diagnosis is a field, not part of the message

```ts
class ChainRpcError extends Error {
  readonly code: 'TRON_CHAIN_RPC_ERROR';
  readonly method: string;
  readonly rpcCode: number;
  readonly rpcMessage: string;    // the node's verbatim text, unedited and untranslated
  readonly rpcData: unknown;
  readonly diagnosis: TvmDiagnosis;
  readonly endpoint: string;      // scrubbed
}
```

`src/chain/errors.ts:223`.

The node's text is **unedited and untranslated**. Editing it is how forbidden translation re-enters
through the back door — an appended clarification is a translation with a friendlier name — and it
destroys the one artifact a user can search a java-tron issue tracker for.

The diagnosis is a **field and not part of the message**, and this is the load-bearing detail:
`'REVERT opcode executed'.includes('revert')` is `false`, so upstream's four case-sensitive
substrings miss both of TRON's probe outcomes — but the string `'reverted'` *does* contain `revert`,
so interpolating the diagnosis kind into the message would silently perform exactly the translation
the design forbids.

The diagnosis is derived in the constructor rather than passed in, so there is one classification
site and two callers cannot disagree about the same payload.

### `ChainTransportError` and `TransportFailure`

```ts
type TransportFailure =
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'http-status'; readonly status: number }
  | { readonly kind: 'non-json-body'; readonly detail: string }
  | { readonly kind: 'malformed-envelope'; readonly detail: string }
  | { readonly kind: 'timeout' };
```

`src/chain/errors.ts:96`, `:287`.

`unreachable` is what a *disabled* eth-compat service looks like on a stock java-tron: the gate
(`node.jsonrpc.httpFullNodeEnable`) is at the service level and port 8545 never binds, so the
symptom is `ECONNREFUSED`, not `-32601`.

`non-json-body` is what a reverse proxy or a web server in front of the node produces rather than
the node itself. It is detected on the resolved value's **type**, not in a catch, because axios
resolves such a body as a string.

A transport failure is **never** classified as a probe outcome and **never** swallowed. The
specimen is the sibling plugin's `slots.ts:getSlot`.

### `ChainInstanceChangedError` — owned here, thrown by the record layer

```ts
class ChainInstanceChangedError extends Error {
  readonly code: 'TRON_CHAIN_INSTANCE_CHANGED';
  readonly comparison: ChainInstanceChange;
  readonly context: {
    readonly manifestFile: string;   // from manifestPathFor
    readonly recordCount: number;
    readonly endpoint: string;       // scrubbed
  };
}
```

`src/chain/errors.ts:441`. **This surface owns the text because it holds the comparison, and never
throws it** — the record layer decides that refusal is the policy.

The message **discards nothing and names the remedy**, and "discards nothing" is structural rather
than a promise: this directory has no filesystem access at all, so it is incapable of modifying the
file the message names. The wording differs by signal — a chain-id change leads with "a different
network", the strongest claim the surface makes, while a hash change says "a different instance of
the same chain" and names deleting the manifest as the remedy for a restarted local node.

### The twelfth category: `EnvironmentIncompleteError`

A `chain` slot that cannot supply chain-state access is reported through the **seam's own** family
(`TRONBOX_ENV_INCOMPLETE`), not this namespace. Three helpers construct it — none is on this face,
because a consumer narrows on the seam's class:

| Helper | Diagnosis kind | Condition |
|---|---|---|
| `chainHandleMalformedError` (`src/chain/errors.ts:474`) | `handle-malformed` | `fullNode.host` / `fullNode.request` is absent, or a host getter threw — the `'missing'`/`'threw'` distinction is preserved |
| `chainHandleWrongTypeError` (`src/chain/errors.ts:574`) | `invariant-violated` | The path is present but its value is not the type read — e.g. a numeric `fullNode.host` |
| `chainJsonRpcUnavailableError` (`src/chain/errors.ts:531`) | `invariant-violated` | The handle is sound and the endpoint cannot serve eth-compat JSON-RPC |

Reusing that family rather than adding a fourth diagnosis to it costs one thing, paid inside the
text: the seam's renderer appends `(provided in …; absent in …)` read from its slot table, which for
the `chain` slot is a true statement about invocation contexts that is actively misdirecting for a
live-capability failure — the user's context *did* provide the handle; their node did not serve the
RPC. So each `detail` is written as a non-terminal clause that **names the parenthetical and
disowns it** (`src/chain/errors.ts:508`).
