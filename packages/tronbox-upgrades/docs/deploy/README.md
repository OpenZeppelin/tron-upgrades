# Deployment and transactions

One rule, three outcomes, and a refusal that guards a risk no other check covers.

This page is about **what you observe from a migration**, not about an API. The deployment
layer is package-internal — the plugin's operations reach it, you do not — so there is nothing
here to import. What there *is*: a rule about `await` that matters more here than anywhere
else in TronBox, a precise meaning for "the operation returned", and two refusals worth
understanding before you meet them.

---

## Always `await` the plugin's operations

```js
module.exports = async function (deployer, network, accounts) {
  const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };
  const box = await deployProxy(Box, [42], handles); // ← await, always
};
```

TronBox migrations queue their steps and run them later, and the queue's native error
behaviour has a sharp edge: a step that fails does reach the migration runner, but **anything
awaiting that step directly never resumes — not with an error, not at all.** The plugin
bridges that edge for its own operations: when you `await` a plugin operation, a failure
rejects your `await` with the real error, and a failure in an *earlier* migration step rejects
it too, instead of leaving your migration suspended.

What the bridge cannot do is help a caller who never awaited:

> **If you invoke a plugin operation and do not `await` it, your migration will not learn that
> it failed.** The migration's own steps continue, the run can end reporting success, and the
> failure is visible only in the operation's own output. This is a documented limitation of
> integrating with the queue, and the remedy is one word long.

## "Returned" means confirmed — and confirmed is checked, not assumed

A state-changing operation returns only once its transaction is **on-chain and its receipt
affirms success**. Those are two different checks, deliberately: a reverted transaction has a
perfectly good receipt, so waiting for the receipt alone would report failed deployments as
successes. Three outcomes are possible, and each looks different:

1. **Success** — the operation returns, and the result's address and transaction identity come
   from the deployment itself, never from a placeholder and never from a previous run's
   records.
2. **Reverted** — the operation fails, carrying the node's own verdict and message (for
   example `REVERT — "REVERT opcode executed"`). The failure is on-chain; re-running without a
   change will fail the same way.
3. **Indeterminate** — the plugin could not verify either way, and says so rather than
   guessing. Two ways to get here, with different remedies in the message:
   - *the wait ran out* (default bound: two minutes of polling). The transaction may still
     land. **Check it before retrying — re-sending a transaction that later confirms deploys
     twice.** The plugin never re-sends on its own, for exactly that reason.
   - *the receipt carried no verdict*. The plugin refuses to report a success it cannot
     verify.

## The sending account is checked after the fact

If your network configuration names a `from` address, the plugin resolves it **once** per
operation, runs any authority check against that identity, and then — because the account
that actually signs is chosen at send time, by TronBox — **compares the identity that signed
against the one it checked.** A difference is a refusal naming both. This closes a quiet
failure: an upgrade-authority check that passes against one account while another account
sends is a check about somebody else.

Addresses are compared by identity, not by spelling — base58, `41…` hex and `0x…` hex forms
of the same account never trip it.

## Linked libraries are refused by default

If your implementation links an external library, deploying or upgrading it refuses until you
opt in:

```js
{ unsafeAllow: ['external-library-linking'] }
```

The reason is stated where you opt in, and it is worth restating: **swapping a linked
library's address changes the contract's behavior without changing its storage layout**, so
the storage-safety validation — every mode of it — has nothing to catch. By opting in you take
over verifying every future library address yourself.

With the opt-out set, the plugin deploys the **linked** bytecode and verifies the linking
actually happened: TronBox's own linker returns silently when a library name does not match
any placeholder, so "the link step ran" proves nothing, and unresolved placeholders would
otherwise reach the chain as a contract that cannot execute.

## Two behaviours worth knowing about

- **A wildcard network id (`network_id: '*'`) does not refuse.** The operation proceeds under
  the chain's real identity — which the deployment record is keyed on regardless — and states
  that identity in its output, so records and artifacts cannot silently disagree about which
  network they describe.
- **A constructor whose final argument is a plain object is refused by name.** TronBox treats
  a trailing object as its own options slot: it strips `overwrite` from it and forwards the
  remainder, so your constructor would receive a struct you never wrote — and with
  `overwrite: false` in it, the deployment is silently skipped and stale results returned.
  The refusal tells you how to restructure the call.

## In contexts with no deployer

Under `tronbox test`, mocha files have no deployer. A state-changing operation there refuses,
naming exactly what the context is missing — **after** any requested validation has run.
Validation works without a deployer and is never blocked by this; deployment refuses because
there is nothing to send a transaction through.
