# README contributions from chain-state access

User-observable facts this sub-feature contributes to the package README. **The README is assembled
by SF-12 and proved followable there** — these are fragments, in the shape the assembler can lift,
not a document.

Everything below is user-facing. Nothing here mentions a sub-feature, an invariant number, or a
module path: a user who reads the README does not experience either.

---

## Why this contributes no quickstart

The quickstart belongs to the operations a user actually calls. This surface is a dependency of all
of them and the entry point of none — a user never writes `createChainAccess`. What it contributes
instead is: one environment variable, one node requirement, one troubleshooting table, and the
sentences that explain a failure a user *will* hit on a local node.

---

## Fragment 1 — Requirements

> **Your node must serve the Ethereum-compatible JSON-RPC API.**
>
> TRON nodes expose two HTTP APIs: the native wallet API (port **8090** by default) and an
> Ethereum-compatible JSON-RPC service (port **8545**). This plugin reads chain state through the
> second one.
>
> On TronGrid and the public testnet endpoints it is already enabled. On a **self-hosted java-tron
> node it is disabled by default** — set `node.jsonrpc.httpFullNodeEnable = true` in your node
> configuration and restart.
>
> Because your `fullHost` normally names the wallet API on 8090, and the JSON-RPC service listens on
> 8545, the plugin may need to be told where to find it — see
> [`TRONBOX_UPGRADES_RPC_URL`](#fragment-2--tronbox_upgrades_rpc_url).

Two supporting facts the assembler may want inline, and both are measured:

- The gate is at the **service level**, so a disabled service does not answer "method not found" per
  method — the port never binds, and the symptom is a refused connection.
- `tronbox test` and `tronbox migrate` both work; `tronbox console` works too, because the chain
  handle is the one capability that context supplies.

---

## Fragment 2 — `TRONBOX_UPGRADES_RPC_URL`

> **`TRONBOX_UPGRADES_RPC_URL`** — the Ethereum-compatible JSON-RPC endpoint to use.
>
> By default the plugin derives the endpoint from the network's own `fullHost`/`fullNode` by
> appending `/jsonrpc`. Set this variable when the JSON-RPC service is somewhere else — a different
> port, a different host, or a provider endpoint.
>
> ```sh
> TRONBOX_UPGRADES_RPC_URL=http://127.0.0.1:8545/jsonrpc tronbox migrate --network development
> ```
>
> It must be an absolute `http` or `https` URL. There is **no fallback**: if the value is set and
> cannot be used, the plugin tells you so rather than quietly using a different endpoint — because
> quietly reading chain state from the wrong node is the failure this plugin exists to prevent.
>
> **If the endpoint you set is on a different host than your network's node**, the plugin will not
> route the request through the node's own HTTP client — that client can carry an API key or
> credentials configured for *your* node, and sending them elsewhere is not something a plugin should
> do quietly. On Node 18 and later a built-in `fetch` handles this automatically. On an older runtime
> the plugin refuses and says so.

---

## Fragment 3 — Where deployment records are stored

> Deployment records are written by `@openzeppelin/upgrades-core` to `.openzeppelin/`, one file per
> network. TRON's chain ids are not in the upgrades library's network-name table, so the files are
> named by chain id:
>
> | Network | Chain id | File |
> |---|---|---|
> | Mainnet | 728126428 | `.openzeppelin/unknown-728126428.json` |
> | Nile | 3448148188 | `.openzeppelin/unknown-3448148188.json` |
> | Shasta | 2494104990 | `.openzeppelin/unknown-2494104990.json` |
> | TRON Quickstart / TRE (local) | 3360022319 | `.openzeppelin/unknown-3360022319.json` |
>
> **Commit the files for networks you care about.** They are the record of which proxies you own and
> what is behind them.

---

## Fragment 4 — Restarting a local node

This is the one failure a user will hit that needs its own README paragraph, because the remedy is
not guessable.

> **If you wipe or restart your local TRON node, delete its records file.**
>
> A local node like TRON Quickstart / TRE starts from a fresh chain each time its data is wiped, but
> it keeps the same chain id — so the records file from the previous run is still there, describing
> proxies that no longer exist.
>
> The plugin detects this by comparing the chain's own identity, and **refuses rather than guessing**.
> It tells you which signal changed, that nothing has been changed or removed, and that the fix is:
>
> ```sh
> rm .openzeppelin/unknown-3360022319.json
> ```
>
> If you did **not** expect a restart, do not delete anything yet — the node may be serving a
> different chain than you intended. Check the endpoint first.
>
> This never fires on a public network unless the network really is a different one. Mainnet, Nile
> and Shasta do not restart from genesis.

---

## Fragment 5 — Limitations

> - **Chain state is read from present state only.** The plugin does not support reading a proxy's
>   state at a historical block: TRON's Ethereum-compatible state methods answer from present state
>   and cannot serve a historical read. Asking for one is refused with a clear message rather than
>   silently answered from the present — which is what the node itself does for one of the three
>   methods.
> - **Addresses in Base58 (`T…`) form are not accepted where the plugin talks to the JSON-RPC
>   service.** The service accepts a 20-byte address as `0x`-prefixed hex, as bare hex, or as
>   `41`-prefixed TRON hex; it rejects Base58 with a hex-decoding error. The plugin refuses Base58
>   with a message naming the encodings it does accept, rather than passing your address through to
>   get that error.
> - **Request timeouts are the ones you configured for the network.** The plugin sets none of its
>   own and does not retry. One request per read.
> - **The plugin will not answer the Hardhat and Anvil node-metadata probes.** The upgrades library
>   asks every provider whether it is a Hardhat or Anvil development node; answering "yes" on TRON
>   would misreport what chain you are on, so the plugin declines. This is expected and invisible in
>   normal use.

---

## Fragment 6 — Troubleshooting

The `TRON_CHAIN_*` table. Every error the surface raises carries a `code`, so a user can match what
they saw. Ordered by how likely a user is to meet it.

> | Code | What it means | What to do |
> |---|---|---|
> | `TRONBOX_ENV_INCOMPLETE` (naming the JSON-RPC service) | Your node did not answer on its Ethereum-compatible JSON-RPC service | Enable `node.jsonrpc.httpFullNodeEnable` on a self-hosted node, or set `TRONBOX_UPGRADES_RPC_URL` to the service's URL. Remember it listens on **8545** while `fullHost` normally names **8090** |
> | `TRON_CHAIN_ENDPOINT_REFUSED` | The endpoint could not be used at all | The message names which source supplied it and what is wrong: not an absolute `http`/`https` URL; a path ending in `/tre`, which is TronBox's cheatcode namespace and not a JSON-RPC endpoint; or a different-origin endpoint on a runtime with no `fetch` |
> | `TRON_CHAIN_TRANSPORT` | No JSON-RPC answer arrived | Check the endpoint and the node. A refused connection usually means the JSON-RPC service is not enabled or not on that port. A non-JSON body means something in front of the node answered — a proxy or a web server — rather than the node |
> | `TRON_CHAIN_INSTANCE_CHANGED` | The chain is not the one your records were written against | See [Restarting a local node](#fragment-4--restarting-a-local-node). The message names the file and the remedy. Nothing has been changed or removed |
> | `TRON_CHAIN_IMPLEMENTATION_NOT_FOUND` | The address has no ERC-1967 implementation slot set | Check the address. If it is right, the contract at it is not an ERC-1967 proxy |
> | `TRON_CHAIN_BEACON_NOT_FOUND` | The address's ERC-1967 beacon slot is empty | Check the address. A beacon has no legacy fallback slot, so there is no second place to look |
> | `TRON_CHAIN_ADDRESS_UNUSABLE` | An address could not be sent to the JSON-RPC service | Use `0x`-prefixed hex, bare hex, or `41`-prefixed TRON hex. Base58 `T…` is not accepted here |
> | `TRON_CHAIN_RPC_ERROR` | The node refused the request | The message carries the node's own JSON-RPC code and its **verbatim** text, so you can search for it. `out of energy` means raise the fee limit or fund the account |
> | `TRON_CHAIN_BLOCK_TAG_REFUSED` | A historical block was requested | Only present state is available. See [Limitations](#fragment-5--limitations) |
> | `TRON_CHAIN_RESULT_SHAPE` | The endpoint answered with a value the plugin cannot use | The endpoint may not be an Ethereum-compatible JSON-RPC service for this chain. Check that `TRONBOX_UPGRADES_RPC_URL` points at the right node |
> | `TRON_CHAIN_SLOT_MALFORMED` | A storage word read from the chain is not a 32-byte value carrying an address | Report this — it means the endpoint is answering `eth_getStorageAt` in a shape this plugin does not recognise |
> | `TRON_CHAIN_METHOD_REFUSED` | The plugin declined a Hardhat/Anvil dev-node probe | Expected. See [Limitations](#fragment-5--limitations) — you should not see this in normal use |

---

## What this does *not* contribute

- **Any installation or quickstart step.** A user never constructs this surface.
- **Anything about validation, storage layout, or the compiler.** Different sub-features own those,
  including everything about why an artifact does not carry a storage layout.
- **Anything about proxy kinds or which operation to call.** The operations own their own README
  sections; this surface reads slots and never judges what they mean.
- **A statement about upstream behaviour changing.** The plugin pins
  `@openzeppelin/upgrades-core@1.46.0`, and the README should not promise a change to a pinned
  dependency. Fragment 4 describes what the user does today.
