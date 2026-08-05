# Chain-state access

> The plugin's only path to chain state, and the only translation point between TronWeb and
> what `@openzeppelin/upgrades-core` expects. One composite, built by one async factory, with
> four injectable seams and a closed family of eleven typed refusals.

**This is not the package README.** It is internal documentation for the sub-features built on
top of this surface. `@openzeppelin/tronbox-upgrades` exposes no part of it to end users
directly; the package's public entry point belongs to packaging, and the user-facing README is
assembled and proved followable by the consumer end-to-end harness. See
[`readme-contributions.md`](./readme-contributions.md) for the facts this sub-feature
contributes to that README.

**Audience:** the six sibling sub-features the source names as consumers
(`src/chain/index.ts:8`, `src/chain/index.ts:66`) — the deployment record and address
canonicalization layer, proxy deploy and upgrade operations, standalone validate/prepare,
force-import, the admin surface and beacon workflows — plus packaging and the consumer
end-to-end harness.

---

## Why this surface exists

`@openzeppelin/upgrades-core` reads the chain through a `send(method, params)` interface. TRON
exposes an Ethereum-compatible JSON-RPC service, but three things about it do not line up with
what the engine assumes, and each has a measured failure mode:

1. **The endpoint is not where the handle points.** A network's `fullHost`/`fullNode` names the
   native wallet API, on port 8090 by default. The eth-compat service is a *different service*
   on port 8545, gated behind `node.jsonrpc.httpFullNodeEnable`, which defaults to **false** on
   a stock self-hosted java-tron. Because the gate is at the service level, the symptom of a
   disabled service is `ECONNREFUSED` rather than a `-32601` for each method.
2. **The host's own chain handle sets a trap.** `tronWrap.send` POSTs to
   `networkConfig.fullNode + '/tre'` — TronBox's cheatcode namespace — with
   a default arm that falls through to that POST for **every** method it does not recognise
   (`node_modules/tronbox/build/components/TronWrap/index.js:tronWrap.send`, re-verified in the
   installed **4.8.0** bundle; reported at 4.9.0). On a local TRE that answers; on every public
   network it returns HTTP 405, which the host rewrites into
   `TRE RPC 'eth_chainId': Request failed with status code 405`. That names the wrong capability,
   and it works on one machine and fails on another.
3. **The engine distinguishes a disposable dev node from a persistent one by *catching*.**
   `getDevInstanceMetadata` probes `anvil_metadata`, then `hardhat_metadata`, and returns
   `undefined` **only** by catching both
   (`node_modules/@openzeppelin/upgrades-core/dist/manifest.js:30-53`). An adapter that resolves
   an error *envelope* for either method reaches the throw at
   `dist/manifest.js:46` — `Broken invariant: Hardhat or Anvil metadata's chainId … does not
   match eth_chainId …` — on the path of **every** deploy and every upgrade, with a message
   naming neither TRON nor the adapter.

So the translation has to happen somewhere, and it has to happen exactly once. This directory is
that place. Two structural rules hold the boundary:

- **`src/chain/**` imports the host by no path** and imports `@openzeppelin/upgrades-core`
  as **types only** — one type-only specifier, at `src/chain/index.ts:15`. Every reach for chain
  state goes through the handle the environment seam hands over.
- **Exactly one module reads a property off that handle, along exactly two paths**:
  `src/chain/endpoint.ts`, reading `fullNode.host` and `fullNode.request` and nothing else. Its
  typed view of the handle is module-private and not exported.

---

## Quick start

```ts
import { resolveEnvironment } from '../environment';
import { createChainAccess } from '../chain';

// Inside a function the migration calls, with the migration's own globals passed in.
const env = resolveEnvironment(handles, { require: ['chain'] });
const access = await createChainAccess(env.chain);

access.endpoint.describe;                  // 'http://127.0.0.1:8545/jsonrpc' — scrubbed
await Manifest.forNetwork(access.provider); // the engine gets this, never env.chain.tronWrap
await access.read.readProxySlots(address);  // the reader surface
await access.identity();                    // the instance fingerprint, memoized
```

Four things to notice, because each is load-bearing:

1. **It is async, and the reason is one probe.** `createChainAccess` performs exactly one
   capability probe — `eth_chainId` — so a network without the eth-compat service fails once, up
   front, **naming the capability**, rather than at an arbitrary point inside an operation. One
   method and not eight, because java-tron registers the eth-compat methods together at the
   service level: "serves `eth_chainId` but not `eth_getStorageAt`" is not a configuration the
   node produces. The complete answer is available on demand from
   [`verifyCapabilities`](./api-reference.md#verifycapabilitiesaccess).
2. **There is deliberately no unprobed variant.** No `createChainAccessUnchecked`, no
   `skipProbe`, no lazy mode (`src/chain/index.ts:180-184`). An escape hatch is worse than no
   probe, because the diagnosis's main failure mode is a caller who skipped it — and it would be
   skipped in exactly the harness where the endpoint is least standard. Tests substitute
   `deps.post` instead.
3. **`access.provider` is the engine's own `EthereumProvider` type.** So `Manifest.forNetwork(access.provider)`
   type-checks and `Manifest.forNetwork(env.chain.tronWrap)` does not, and no consumer writes a
   cast of its own. What that declaration asserts — including three results forwarded
   unvalidated — is written out at
   [`safety.md § asEngineProvider`](./safety.md#asengineprovider-bridges-once-and-forwards-three-results-unvalidated).
4. **It is not a singleton.** One per operation is correct and costs one probe; one held across a
   migration is supported, cheaper, and the only way to pay for the fingerprint once. The
   obligation the surface *states and cannot enforce* is that a record write and the engine's
   manifest write go through the same instance — see
   [`safety.md § the shared-instance obligation`](./safety.md#the-shared-instance-obligation-is-the-callers).

---

## Key concepts

### The composite, and what it deliberately does not hold

`ChainAccess` has four members: `provider`, `endpoint`, `identity()`, `read`. **No field holds
the host handle, anything reachable from it, or the raw endpoint URL** — both live in closures
(`src/chain/index.ts:80-106`). `JSON.stringify(access)` therefore cannot leak either and does not
throw.

That is why this surface needs no redaction step. The environment seam meets the same guarantee
by *redacting* handles on serialization, because its slots expose them as named capabilities;
this one meets it by *construction*, because there is no field to redact. The first field added for
convenience silently undoes it.

`EndpointDescriptor` has exactly two members — `describe` and `origin` — and **no `url` field**,
no `host` field, and no field the raw endpoint can be reconstructed from. `describe` is scrubbed:
userinfo stripped, query and fragment dropped, scheme/host/port/path kept
(`src/chain/endpoint.ts:233`). That matters because the raw URL is credential-bearing and the
chain of custody is verified rather than assumed: TronBox's `filterNetworkConfig` is
`fullNode: options.fullNode || options.fullHost` with **no normalization**
(`node_modules/tronbox/build/components/TronWrap/index.js:filterNetworkConfig`), `tronweb`'s
`isValidURL('http://u:p@node:8545')` returns `true`, and `HttpProvider` strips only trailing
slashes — so HTTP Basic userinfo and query-string API keys reach `fullNode.host` untouched.

### Endpoint precedence, and the transport that follows from it

The endpoint is chosen **once**, by a fixed precedence, with **no fallback between sources**
(`src/chain/endpoint.ts:302-331`):

| Order | Source | `origin` |
|---|---|---|
| 1 | `deps.endpointOverride` | `'argument'` |
| 2 | `deps.env.TRONBOX_UPGRADES_RPC_URL` | `'environment'` |
| 3 | the network's `fullHost`/`fullNode` + `/jsonrpc` | `'derived'` |

A value that is present but unusable is **refused**, never skipped in favour of the next source.
Only `undefined` counts as absent; an empty string is a mistake worth naming. The specimen this
guards against is the sibling plugin's `slots.ts:getSlot`, which reroutes on a blanket catch to
`hre.network.config.url ?? process.env.TRE_URL ?? 'http://127.0.0.1:9090/jsonrpc'` — so on a
public network with `url` unset, a *transient* failure silently reads ERC-1967 slots from a local
dev chain. The severity is not that a read failed; it is that the read *succeeded* against the
wrong chain and the answer is plausible.

The transport then follows from the endpoint's origin, and this is the one place you may have to
supply something:

    deps.post  →  globalThis.fetch (read at factory time)  →  refuse

Same origin as the handle's own node? The handle's HTTP client is used, because it carries the
timeout the user configured. Different origin? The request goes through a transport carrying
nothing the plugin did not construct — and if this runtime has no global `fetch` and you supplied
no `post`, it **refuses**, because the only remaining transport would lend the node's client
credentials to a host named in an environment variable. Read
[`safety.md § credentials never cross an origin`](./safety.md#credentials-never-cross-an-origin)
before configuring an override.

### Refusals are declared, not inherited

Two methods are refused **locally, from a table, before any request** (`src/chain/policy.ts:44`):
`anvil_metadata` and `hardhat_metadata`. This is a positive obligation of the adapter, not a gap
in it — see the third reason in [§ Why this surface exists](#why-this-surface-exists), and
[`safety.md`](./safety.md#the-two-refusals-are-an-obligation-not-a-gap) for the whole argument.

Block tags are refused **uniformly** for every method carrying one, even though the node's own
handling is not uniform. Only `'latest'` is served; a named tag, a numeric height and an
EIP-1898 block object are all refused locally, before the request is built
(`src/chain/policy.ts:212-236`).

### Instance identity dissolves the dev-node question

Nothing in this directory decides whether a chain is a development, disposable, local or dev node
(`src/chain/instance.ts:1-18`). No chain-id allow-list, no client-version match, no port
heuristic. The mechanism removes the need: **chain id and genesis hash survive a TRE wipe; block
1's hash does not** — measured across four boots and two TRE image versions. So the *same*
comparison is a no-op on mainnet and a refusal on a wiped local node, and there is no
classification that could misclassify a legitimate private production chain.

`identity()` reads three values and memoizes the promise. `compareChainInstance` is pure and
total, compares chain-id → genesis-hash → first-block-hash, reports which signal disagreed, and
**never refuses on `indeterminate`** — which is the state every existing project is in on the
first run after this ships.

### Every no-answer reason is a named union member

`undefined` is never a reason. `readProxySlots` returns `no-code` or `code`;
`tvmCallOptional` returns `answered` or `no-answer` with `reverted`/`no-contract-at-address`;
`readBeaconImplementation` returns three outcomes where upstream collapses two into
`InvalidBeacon`. The one permitted `| undefined` in the whole surface is
`readUpgradeInterfaceVersion`, and it mirrors upstream's documented contract for a present,
answering contract with no such getter.

The measured consequence of losing that distinction: upstream's `beacon.ts:assertIsBeacon` tells a
user their address "is not an upgradeable beacon: its `implementation()` getter did not return an
address" when in fact **nothing is deployed there at all**.

### The error family, by behaviour

Eleven classes, one closed `TRON_CHAIN_*` code namespace, no two sharing a code, each with one
condition and one remedy. **Narrow on the class or on `code`, never on the message.** Every fact
in a message is also reachable as a field.

The one distinction worth learning up front: `ChainRpcError.diagnosis` is a **field**, and the
diagnosis kind is deliberately **absent from the message**. `'REVERT opcode
executed'.includes('revert')` is `false`, so upstream's four case-sensitive substrings miss both
of TRON's probe outcomes — but the string `'reverted'` *does* contain `revert`, so interpolating
the kind into the message would silently perform the translation the design forbids.

A twelfth category exists and is deliberately **not** in this namespace: a `chain` slot that
cannot supply chain-state access is reported through the seam's own `EnvironmentIncompleteError`
(`TRONBOX_ENV_INCOMPLETE`), reusing that family rather than starting a second error path the
no-secrets guarantee would have to hold in twice.

---

## Documents

| Document | Purpose |
|---|---|
| [`api-reference.md`](./api-reference.md) | Every export of `src/chain/index.ts`, with full TypeScript signatures |
| [`integration-guide.md`](./integration-guide.md) | Four end-to-end consumption patterns, and the mistakes to avoid |
| [`safety.md`](./safety.md) | Credentials, the refusal asymmetry, the manifest gap, bounded costs, and what this surface does *not* promise |
| [`readme-contributions.md`](./readme-contributions.md) | User-observable facts contributed to the package README, including the `TRON_CHAIN_*` troubleshooting table (the consumer end-to-end harness assembles) |
| [`examples/`](./examples) | Five type-checked example modules |
