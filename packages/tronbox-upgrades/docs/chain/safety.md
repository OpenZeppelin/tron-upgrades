# Safety — what you must know before consuming this surface

Nine things. The first four are hazards you can reintroduce; the middle three are guarantees whose
mechanism you should know so you do not undo it; the last two are the limits — what this surface
does not promise, and the one gap it cannot close.

- [Credentials never cross an origin](#credentials-never-cross-an-origin)
- [The engine gets `access.provider`, and nothing else](#the-engine-gets-accessprovider-and-nothing-else)
- [The two refusals are an obligation, not a gap](#the-two-refusals-are-an-obligation-not-a-gap)
- [`asEngineProvider` bridges once, and forwards three results unvalidated](#asengineprovider-bridges-once-and-forwards-three-results-unvalidated)
- [Nothing here leaks the raw endpoint, and nothing here is unbounded](#nothing-here-leaks-the-raw-endpoint-and-nothing-here-is-unbounded)
- [The timeout is the user's, and nothing accumulates](#the-timeout-is-the-users-and-nothing-accumulates)
- [Round-trip cost is bounded and enumerated](#round-trip-cost-is-bounded-and-enumerated)
- [The manifest gap after a wiped local node](#the-manifest-gap-after-a-wiped-local-node)
- [What this surface deliberately does not promise](#what-this-surface-deliberately-does-not-promise)

---

## Credentials never cross an origin

**The rule.** When the resolved endpoint's origin **is** the handle's own, the handle's HTTP client
is used — it carries the timeout the user configured, and this surface must neither lengthen nor
shorten it. When the origin **differs**, the request goes through a transport carrying nothing this
plugin did not construct: the JSON-RPC payload and one `content-type` header. If no such transport
exists, the endpoint is **refused** (`src/chain/endpoint.ts:467-539`).

**Why the cheapest implementation is the leak.** `HttpProvider`'s constructor is
`axios.create({ baseURL, timeout, headers, auth: user ? { username: user, password } : undefined })`,
and axios applies an instance's `headers` and `auth` to an **absolute** request URL while ignoring
`baseURL`. So handing the absolute override to `fullNode.request` — the cheapest implementation, and
the one that preserves the timeout — would send whatever that instance carries to a host named in an
environment variable.

**The rule is keyed to the origin check, not to a measurement, because the measurement expires.**
*Today* nothing travels: TronBox constructs TronWeb positionally as
`new TronWebProxy(fullNode, solidityNode, eventServer, privateKey)` and passes no `headers`, no
`user` and no `password` — four positional arguments, re-verified in the installed **4.8.0** bundle
at `node_modules/tronbox/build/components/TronWrap/index.js:init` (reported at 4.9.0). But
`headers` is precisely the parameter a
TronGrid API key is configured through, so a rule keyed to that fact would expire silently at the
next minor.

**The precedence, and the remedy that works:**

    deps.post  →  globalThis.fetch (read at factory time, never at module load)  →  refuse

The refusal message names `deps.post` as the remedy, and supplying it resolves the refusal. That is
worth stating explicitly because it was not always true: an earlier draft consulted
`globalThis.fetch` before checking whether `post` had been supplied, so the error stated a fix the
code forbade — the sharpest class of defect there is. The ordering is fixed
(`src/chain/endpoint.ts:490-509`), and it now matches the same-origin path, where the injected seam
has always outranked the platform default.

**Falling back to the handle's client when `fetch` is absent is explicitly not permitted.** That
fallback *is* the leak the rule exists to prevent, so the surface refuses instead — and there is no
twelfth error code for it; it is a `ChainEndpointRefusedError`.

**What to do.** If your endpoint is a different origin — TronGrid, a proxy, a private RPC — either
run on a runtime with a global `fetch`, or supply `deps.post` and build the request yourself. Send
only what you mean to send.

---

## The engine gets `access.provider`, and nothing else

`chain.tronWrap` is passed to no upstream function, ever. There are **four** defences, and they are
independent:

| # | Defence | Where |
|---|---|---|
| 1 | **Type.** The seam's `TronWrapHandle` is `{ trx: object }`, so `Manifest.forNetwork(env.chain.tronWrap)` does not compile | `src/environment/types.ts:54` |
| 2 | **Reach.** Exactly one module reads a property off the handle, along exactly two paths — `fullNode.host` and `fullNode.request`. Its typed view is module-private and not exported | `src/chain/endpoint.ts:1-23` |
| 3 | **Affordance.** `ChainAccess.provider` is declared as the engine's own `EthereumProvider`, so no consumer needs a cast and there is nothing to reach past | `src/chain/index.ts:101` |
| 4 | **Runtime.** An endpoint whose path is or ends in `/tre` is refused, which is the only defence that catches an override typo'd or copy-pasted from the host's cheatcode documentation | `src/chain/endpoint.ts:282-292` |

The trap all four exist for: `tronWrap.send` POSTs to `networkConfig.fullNode + '/tre'` and its
method switch has a **default arm that falls through to that POST for every method it does not
recognise** — the eight `tre_*` / `debug_*` cheatcodes are named, and everything else, `eth_chainId`
included, takes the default
(`node_modules/tronbox/build/components/TronWrap/index.js:tronWrap.send`, re-verified in the
installed **4.8.0** bundle; reported at 4.9.0). On a local TRE that answers; on a public network it
returns HTTP 405 with an HTML body, which the same function rewrites into
`TRE RPC 'eth_chainId': Request failed with status code 405`. An error naming the wrong capability,
in a form that works on one machine and fails on another.

**One thing that is *not* refused, and should not be:** a network configured with a `/tre` `fullHost`.
The derived endpoint is `${host}/jsonrpc`, so `http://127.0.0.1:9090/tre` yields `/tre/jsonrpc`,
which neither *is* nor *ends in* `/tre`. The trap the fourth defence describes is an **override**.

---

## The two refusals are an obligation, not a gap

`anvil_metadata` and `hardhat_metadata` **throw** — locally, from a table, before any request
(`src/chain/policy.ts:44`, `src/chain/provider.ts:82-89`). Zero network requests are issued for
either.

**Refusing is what makes the adapter work.** `getDevInstanceMetadata` distinguishes a dev instance
from a persistent one by *catching*, and its throw sits **outside both catch blocks**
(`node_modules/@openzeppelin/upgrades-core/dist/manifest.js:30-53`). So:

- An adapter that resolves `{jsonrpc, id, error}` for `anvil_metadata` reaches
  `dist/manifest.js:46` and aborts `Manifest.forNetwork` — on the path of every deploy and every
  upgrade — with `Broken invariant: Hardhat or Anvil metadata's chainId … does not match eth_chainId …`,
  a message naming neither TRON nor the adapter.
- An adapter that resolves `null` instead raises an uncaught `TypeError` on
  `networkMetadata.chainId` at the same place.

The plugin would not be subtly degraded; it would not work at all, and the diagnosis would point at
Hardhat.

**Refusing is also correct rather than merely convenient.** Forwarding works today on all four
measured networks — java-tron answers `-32601 method not found` to both, correctly, since it is
neither — but that makes the behaviour a property of *java-tron's method registry* rather than of
this adapter. The day java-tron registers either method, or a proxy, a mock or a TRE variant answers
it, the abort fires from a change nobody in this repository made. Depending on a third party's
continued *absence* of a feature is the borrowed-premise failure this plugin's development has
already hit twice.

It also saves two round-trips on the hot path of every deploy and every upgrade, since
`Manifest.forNetwork` probes both.

**And the refusal reaches no user.** `getAnvilMetadata` and `getHardhatMetadata` have exactly two
call sites in `@openzeppelin/upgrades-core@1.46.0`, both inside `getDevInstanceMetadata`'s nested
try/catch — which is why `ChainMethodRefusedError`'s message is deliberately terse. Both functions
are *exported*, so that licence is version-scoped and a test pins the enumeration.

**Do not soften this.** `verifyCapabilities` reports `refusedLocally` by *driving the refusal
through `send`* and observing the `ChainMethodRefusedError`, against a transport that would have
answered successfully — so a report claiming a local refusal cannot be produced by a build in which
the refusal was softened.

---

## `asEngineProvider` bridges once, and forwards three results unvalidated

`TronEthereumProvider` is **not** assignable to the engine's `EthereumProvider`, and the reason is
structural: assignability to an **overloaded** interface requires compatibility with every signature,
and `Promise<unknown>` is not assignable to the `Promise<HardhatMetadata>` that two of them declare.
At `1.46.0`, `node_modules/@openzeppelin/upgrades-core/dist/provider.d.ts:2-13` declares twelve
`send` signatures — eleven method-specific plus one catch-all.

So the two shapes are declared separately and bridged **exactly once**, at
`src/chain/index.ts:76`. Left unbridged, each of the six consumers would have written its own cast at
the one call site this sub-feature exists to make safe.

**What the bridge asserts, stated rather than buried:**

| Methods | What happens |
|---|---|
| `anvil_metadata`, `hardhat_metadata` | **Throws** — which satisfies any declared return type |
| `eth_chainId`, `web3_clientVersion`, `eth_getStorageAt`, `eth_getCode`, `eth_call` | The result is **validated** against that method's declared shape |
| `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber` | The node's value is **forwarded unvalidated** |

**The three unvalidated results are a named limitation, not an oversight.** It is the same trust
upstream places in any provider — it reads those results through its own accessors — and validation
is scoped to the five methods upstream reads *unguarded*, where a wrong shape becomes a wrong
manifest rather than a `TypeError`. But the consequence for you is concrete: **if you read a
transaction, a receipt or a block through `access.provider`, check the shape yourself.** A node,
proxy or shim that answers `eth_getBlockByNumber` with something structurally absurd will hand it to
you as-is. The absence is pinned by a test, so it cannot silently widen.

`eth_getBlockByNumber` is not in the engine's overload list at all — it is this plugin's own eighth
method. `net_version` and `eth_instanceId` are in the list and are not in the required set: the first
falls through to the node, the second gets `-32601`.

---

## Nothing here leaks the raw endpoint, and nothing here is unbounded

**The raw URL exists only in the transport's closure.** `EndpointDescriptor` has exactly two members
and no field the raw endpoint can be reconstructed from; every rendered form — every error message,
`ChainInstanceIdentity.observedThrough`, `CapabilityReport.endpoint` — is the **scrubbed** form:
userinfo stripped, query and fragment dropped (`src/chain/endpoint.ts:233`, `:67-83`).

That matters because the chain of custody is verified rather than assumed. TronBox's
`filterNetworkConfig` is `fullNode: options.fullNode || options.fullHost` with **no normalization**
(`node_modules/tronbox/build/components/TronWrap/index.js:filterNetworkConfig`);
`tronweb`'s `isValidURL('http://u:p@node:8545')` returns `true`; `HttpProvider` strips only trailing
slashes. HTTP Basic userinfo and query-string API keys reach `fullNode.host` untouched, and an
override certainly can carry both.

**`ChainAccess` needs no redaction step, and that is a design property rather than an omission.**
The environment seam meets the same guarantee by *redacting* handles on serialization, because its
slots expose them as named capabilities; this surface meets it by *construction*, because no exported
object holds a handle or a raw URL in a **field**. `JSON.stringify(access)` is safe and does not
throw. The first field added for convenience silently undoes it — which is also why the seam's
`sealSlot` is deliberately not needed here.

**Every rendered node- or network-supplied string is bounded** at 200 characters with the total
length stated (`src/chain/errors.ts:60`, `src/chain/transport.ts:60`); address and slot-word
excerpts at 80 (`src/chain/slots.ts:57`). The bound is not hygiene: the measured transport failure a
reverse proxy produces is an HTML error page, axios resolves a non-JSON 2xx body as a **string**
rather than rejecting, so the whole page is in hand at the moment the failure is described — and if
the proxy echoes request headers, which error pages do, embedding it is also a leak of exactly what
the origin rule was keeping out.

**The node's own text is preserved verbatim** inside that bound. Editing it destroys the one artifact
a user can search a java-tron issue tracker for, and an appended clarification is a translation with
a friendlier name.

---

## The timeout is the user's, and nothing accumulates

**This surface sets no timeout of its own.** On the same-origin path the request rides the handle's
HTTP client, which carries the timeout the user configured for that network. The timeout message says
so in as many words, so a user who hits it looks at their own configuration rather than at the plugin.

**Across origins the handle's timeout genuinely does not apply**, and that is the trade the origin
rule accepts: a credential reaching a host the user named in an environment variable is the worse
outcome.

**No retry, no backoff, no timer, no queue, no rate limiter** — exactly one HTTP round-trip per
`send` (`src/chain/transport.ts:227-244`). A retry would make a transport failure look like a slow
success, and it would break the outcome contract in a way the type cannot catch, because two attempts
can produce two different outcomes and the second would be returned as if it were the first. The
handle already carries the user's timeout, so a retry is not filling a gap; it is overriding a
decision the user made.

**Nothing accumulates across calls.** The only retained state in a channel is a number — the request
id, which lives on the **instance**, never at module scope, so one channel's ids do not depend on
another's traffic.

**`send` memoizes nothing.** N calls with the same arguments produce N round-trips. Memoizing
`eth_chainId` is the obvious optimization and it is the wrong one: it puts a second source of truth
about the chain inside the one object whose entire purpose is to be the single translation point, with
an unbounded staleness window, because a `tronbox console` session can switch network under it.
Memoization lives on `identity()`, where its scope is one object — and it memoizes the **promise**, so
a concurrent second call awaits the first rather than issuing a second set of reads.

---

## Round-trip cost is bounded and enumerated

Every bound is a property of the surface, not of the chain data, so you can budget against it:

| Call | Round-trips |
|---|---|
| `createChainAccess` | **1** (`eth_chainId`) |
| `identity()` | **3**, once per instance — `eth_chainId`, `eth_getBlockByNumber(0x0)`, `eth_getBlockByNumber(0x1)` |
| `hasCode` | 1 |
| `readImplementationAddress` / `readAdminAddress` | 1 or 2 — modern slot, then the legacy fallback |
| `readBeaconAddress` | 1 — a beacon has no legacy fallback |
| `readProxySlots` | **1** with no code; up to **6** with code, for all three slots |
| `tvmCallOptional` / `readUpgradeInterfaceVersion` / `looksLikeProxyAdmin` | 1 |
| `readBeaconImplementation` | **1** with no code, exactly **2** with code |
| `verifyCapabilities` | **8** served probes plus **0** for the two refusals |

Two ordering guarantees hold inside those numbers, and both are observable:

- **The capability probe completes before any reader is reachable**, because `read` is only
  obtainable from the factory's resolved value.
- **`eth_getCode` comes before any slot read**, which is why a no-code address costs one round-trip
  rather than six.

`readProxySlots` de-duplicates the labels you request, so the bound cannot be exceeded by asking for
the same slot twice.

---

## The manifest gap after a wiped local node

This is a real gap with a real user-visible symptom, and it is worth stating plainly because the
plugin-side mechanism mitigates it rather than closing it.

**Both of upgrades-core's dev-network accommodations are off for TRON**, verified at `1.46.0`:

- `dist/provider.js:104-116` — `isDevelopmentNetwork` short-circuits `true` only on chain id `1337`
  or `31337`, then requires `clientVersion.split('/', 1)[0]` to be `HardhatNetwork`,
  `EthereumJS TestRPC` or `anvil`. TRON reports `TRON`. The client version identifies TRON but
  **not** dev versus production — `TRON/v4.8.2/Linux/Java17` on a TRE and
  `TRON/v4.8.2/Linux/Java1.8` on mainnet.
- `dist/manifest.js:30-53` — `getDevInstanceMetadata` returns `undefined` only by **catching** both
  metadata probes. No TRON node supplies an `instanceId`, and `getSuffix` keys the instance-scoped
  file on `${chainId}-${instanceId}`.

So `dist/manifest.js:63-72` takes the non-dev branch, and the manifest lands at the **persistent**
`.openzeppelin/unknown-<chainId>.json` (`dist/manifest.js:78`) rather than an instance-keyed file
under `os.tmpdir()`. The two accommodations that would otherwise have absorbed a wipe are skipped:
`dist/impl-store.js:159` never deletes a clashing prior deployment, and `dist/deployment.js:54` never
ignores a stale `InvalidDeployment` and redeploys.

**What a user sees today, without a plugin-side check.** They wipe or restart their TRE, deploy
again, and get a hard failure out of `checkForAddressClash` — with a diagnosis that does not name the
cause and no remedy the message suggests. `.openzeppelin/unknown-3360022319.json` still holds the
previous boot's records, describing proxies that no longer exist.

**What this surface adds.** A chain-observed instance fingerprint whose per-boot signal is block 1's
hash, and a comparison whose `changed` verdict lets the record layer refuse and **name the file to
delete**. The user gets a message that says which signal disagreed, that nothing has been changed or
removed, and — for a hash change, which is what a restart looks like — that deleting
`.openzeppelin/unknown-<chainId>.json` and running again is the fix, with a caution to check the
endpoint first if the restart was not expected.

**What it does not do.** The manifest is still the persistent per-chain file, and it will still
accumulate entries across instances if nothing deletes it. This surface has no filesystem access at
all, so it cannot rotate, key or clean that file — the mitigation is a *refusal with a named remedy*,
not automatic recovery. Whether the persistent-versus-instance-keyed behaviour changes upstream is
not something this plugin can promise; it pins `1.46.0`, and no upstream change reaches a pinned
version. **The block-1-hash mechanism is therefore necessary regardless of what upstream does.**

---

## What this surface deliberately does not promise

### It writes nothing, signs nothing, and touches no filesystem

No Node built-in is imported anywhere in `src/chain/**`. No `eth_sendRawTransaction`, no
`eth_sendTransaction`, no signing, no `fs`, no `path`. The manifest filename `manifestPathFor`
returns is a **string rendered into a message**, joined with `/` rather than `node:path`, not a path
this surface opens. That is what makes `ChainInstanceChangedError`'s "nothing has been changed or
removed" structurally true rather than a promise.

### It emits nothing

No `console.*`, no logger, no tracer, no metric. Every diagnosis rides a typed error or a returned
union member. If a fact needs to reach a user, it reaches them through a return value or a throw.

### It does not decide whether a network is a dev node

No chain-id allow-list, no client-version match, no port heuristic, no `isDevelopmentNetwork`-shaped
predicate (`src/chain/instance.ts:1-18`). The mechanism dissolves the need, and **the dissolution is
only durable while the classification stays absent**. The first `if (chainId === TRE_CHAIN_ID)` added
for a "nicer local-node message" reintroduces the hazard the design exists to avoid — misclassifying
a legitimate private production chain — and it will be added by someone who reads the refusal text
and wants to tailor it.

### It does not decide proxy kind

The readers return what the slots say, never what it means. There is no `proxyKind`, and the
admin/implementation asymmetry is mirrored from the engine rather than smoothed, so a caller cannot
end up disagreeing with the engine about whether an address is a proxy.

### It serves only present state

Only `'latest'`. A named tag, a numeric height and an EIP-1898 block object are refused locally for
every method carrying a block parameter, uniformly — because the node's handling is *not* uniform:
`eth_call` validates an EIP-1898 object and then silently answers from present state, while
`eth_getCode` and `eth_getStorageAt` reject the same object as `-32700 "JSON parse error"`. This
refuses nothing upstream sends today; it refuses what a later caller might, including a third party
who reads the catch-all overload and reasonably assumes historical reads work.

### It never throws `ChainInstanceChangedError` itself

The text is owned here because the comparison is held here. The decision that refusal is the policy,
and the throw, belong to the record layer.

### The shared-instance obligation is the caller's

Constructing one `ChainAccess` per operation is correct; holding one across a migration is supported.
But **a deployment record and the engine's manifest write must go through the same instance**,
because both must resolve the same chain id for their records to land in the same manifest file. Two
instances against a load-balanced endpoint can resolve two — and then each file is internally
consistent and neither describes the deployment.

This surface **states and cannot enforce** that. Enforcing it would require process-wide state, which
the no-module-scope-state rule forbids for good reasons of its own. The end-to-end harness owns the
assertion that a deploy and a record write observe one chain id.

### One property is asserted only as an encoding property

Every reader guarantee here is about *encoding* — that a 32-byte word decodes to the address the
engine would read, that a Base58 input is refused by name, that an empty slot is distinguishable from
absent code. **None of it establishes that a deployed TRON proxy's ERC-1967 slot reads back at the
address Ethereum would use**, because java-tron keys contract storage by an address hash derived from
the deploying transaction plus a contract version. Confirming that needs a deployed proxy on a real
network, and it belongs to the end-to-end harness. Nothing in this surface can establish it at any
effort.

### The pinned constants pin hashing, not labels

The five ERC-1967 slot keys and the three selectors are re-derived at test time against the engine's
own derivation, so a bump that changed the hashing or a signature fails. A bump that changed which
**labels** the engine uses would be re-derived consistently by both sides and pass. Detecting that
needs a pinned copy of the label strings — the copy-of-a-copy the pinning exists to avoid — and is an
open item for the next engine bump.
