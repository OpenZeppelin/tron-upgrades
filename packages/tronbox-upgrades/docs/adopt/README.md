# Adopting existing deployments

`forceImport` brings a proxy, beacon, or implementation that was deployed **without** this
plugin into the deployment record — after which upgrades and validations work on it
normally. It is the remedy the *"no stored storage layout … register the deployment first
with forceImport"* refusal points at.

```js
const Box = artifacts.require('Box');
await forceImport(proxyAddress, Box);
```

Three things it will not do, each deliberate:

1. **It will not record a contract it cannot verify.** The code on-chain (at the proxy's
   implementation, the beacon's implementation, or the bare address) is compared against
   `Box`'s own compiled bytecode, metadata excluded. If they differ, the import refuses —
   because recording a plausible-looking wrong baseline would make every later upgrade
   validate against the wrong layout and pass unsafe changes silently. Import the contract
   that is actually deployed, compiled from the source that produced it.
2. **It will not guess a kind.** What the address is — transparent proxy, UUPS proxy,
   beacon, bare implementation — is classified from chain state; a `kind` you pass that
   contradicts it refuses naming both, and a beacon is recorded as a beacon, never as a
   proxy.
3. **It will not overwrite.** Importing the same address again changes nothing (the
   recorded baseline is preserved by construction), and an address already recorded under a
   different kind refuses instead of being rewritten.

Adoption sends no transaction and costs nothing on-chain.
