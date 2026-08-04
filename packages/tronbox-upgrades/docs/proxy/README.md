# Deploying and upgrading proxies

The two operations, the one-file setup they need, and what each refusal is telling you.

## Setup, once per project

The plugin deploys OpenZeppelin's ported proxy contracts, and **your project compiles
them** — one import file is the whole setup:

```solidity
// contracts/Proxies.sol
import "@openzeppelin/tronbox-upgrades/contracts/Proxies.sol";
```

Run `tronbox compile` afterwards. Without this, deploy operations refuse naming the missing
proxy artifact and this exact step as the remedy.

## Deploy

```js
const { deployProxy } = require('@openzeppelin/tronbox-upgrades');
const Box = artifacts.require('Box');

module.exports = async function (deployer) {
  const result = await deployProxy(Box, [42], { deployer });
  console.log('proxy at', result.address);
};
```

What happened, in order: your implementation was **validated for upgrade safety before
anything spent**, the implementation and the proxy were deployed through TronBox's own
migration queue, the proxy's transaction was **confirmed on-chain with its receipt checked**
— a reverted deployment is a failure, never an apparent success — and the proxy was recorded
in the deployment record beside your artifacts. `kind: 'uups'` selects a TRC1967 proxy;
the default is transparent, which deploys its own admin owned by `initialOwner` (default:
the sending account).

**Always `await` the operations.** The reasons — and the precise meaning of "returned" —
are on the [deployment and transactions](../deploy/README.md) page.

## Upgrade

```js
const BoxV2 = artifacts.require('BoxV2');
const result = await upgradeProxy(proxyAddress, BoxV2, { deployer });
```

In order: the new implementation is validated, its storage layout is checked against the
layout **of the implementation currently installed on-chain** (read from the proxy's 1967
slot — never guessed from a contract name), the upgrade authority is resolved **before** the
new implementation is deployed (so a mis-routed proxy cannot orphan a paid-for
implementation), the right entry point for the proxy's generation is chosen by probing
`UPGRADE_INTERFACE_VERSION` (v4 and v5 admins and implementations all dispatch correctly —
an unrecognised generation refuses rather than guessing), and after the call confirms, the
implementation slot is **read back from chain** and compared — a slot that does not hold the
new implementation is an error, not a success.

## Running a migration twice

Both operations declare what a replay does:

- **`deployProxy` reconciles.** If this migration already deployed a proxy on this chain and
  the deployment record vouches for it, you get the recorded proxy back — no second deploy,
  no second record entry. If the record *cannot* vouch for it (the node was wiped, the
  record was deleted, or something else deployed there), the operation refuses and names
  which investigation comes first — it never deploys a duplicate beside a stale record.
- **`upgradeProxy` recognizes already-current.** If the proxy already runs the target
  implementation — compared by address identity, whatever spelling either side uses — the
  operation is a no-op: nothing is sent and nothing is re-recorded.

## Refusals you may meet, and what they mean

| refusal | it is telling you |
|---|---|
| proxy artifact missing | do the one-file setup above and recompile |
| artifact collision | two compiled contracts share the proxy's bare name; TronBox indexes by bare name, so the plugin will not pick silently |
| not upgrade-safe | the validation engine found an unsafe pattern in the implementation; the message lists each finding |
| storage-incompatible | the new layout moves or removes existing state; the message names the change |
| beacon proxy | this proxy's implementation lives on its beacon — upgrade the beacon |
| unknown proxy generation | the reported `UPGRADE_INTERFACE_VERSION` is outside what this plugin knows; nothing was sent |
| empty initializer | the ported TRC1967Proxy rejects uninitialized deployment for both kinds; add an initializer or use a beacon proxy |
| `initialOwner` is a ProxyAdmin | the v5 transparent proxy deploys its own admin; passing an existing ProxyAdmin is almost always a v4 habit — the message names the skip option if you really mean it |
| stale proxy record | a prior deployment's record cannot vouch for a replay; see above |
