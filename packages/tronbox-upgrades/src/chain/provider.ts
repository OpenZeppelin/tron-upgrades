/**
 * The `send(method, params)` adapter — the only export shaped like the engine's
 * `EthereumProvider`, and the only thing that ever leaves the plugin.
 *
 * INV-30: `access.provider` is what goes to `@openzeppelin/upgrades-core`.
 * `chain.tronWrap` is passed to no upstream function, ever.
 */

import {
  ChainBlockTagRefusedError,
  ChainMethodRefusedError,
  ChainResultShapeError,
  ChainRpcError,
  ChainTransportError,
} from './errors';
import { blockTagVerdict, policyFor, stringResultMethods } from './policy';
import type { RpcChannel } from './transport';

/**
 * The engine's injection surface.
 *
 * A single `send(string, unknown[]) => Promise<unknown>` satisfies the whole of
 * `EthereumProvider` through its catch-all overload — verified at upgrades-core
 * `1.46.0`, where `provider.d.ts` declares eleven overloads and **no `request`**.
 * So this is web3-style `send`, not EIP-1193, and the shape is not a choice.
 */
export interface TronEthereumProvider {
  send(method: string, params: readonly unknown[]): Promise<unknown>;
}

/** INV-5-style exhaustiveness over `JsonRpcOutcome`: a fourth member won't compile. */
function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * Narrows a resolved result to the shape *that method's* consumer requires.
 *
 * Exported because `read.ts` and `instance.ts` are reachable with a bare
 * `{ send }` object that never went through this module (INV-47 requires exactly
 * that, so their tests can drive them without a `ChainAccess`), and one predicate
 * table is what keeps the two boundaries from disagreeing.
 *
 * @throws {ChainResultShapeError} INV-4.
 */
export function requireResultShape(method: string, value: unknown): string {
  const rule = stringResultMethods[method];
  if (rule === undefined) {
    // Only reachable if a caller inside SF-1 asks for a shape the table does not
    // describe, which is a defect here rather than a fact about the node — so it
    // is named as such instead of being waved through.
    throw new ChainResultShapeError(
      method,
      'a shape this plugin declares for it',
      value,
    );
  }
  if (!rule.accepts(value)) {
    throw new ChainResultShapeError(method, rule.describe, value);
  }
  return value;
}

/**
 * Builds the adapter over one channel.
 *
 * INV-23: **`send` memoizes nothing.** No cache, no memo, no dedupe — N calls
 * with the same arguments produce N round-trips. `eth_chainId` is immutable per
 * instance and the engine calls it on every `Manifest.forNetwork`, so memoizing
 * here is the obvious optimization, and it reproduces a defect measured in the
 * sibling: it reads the implementation slot through one transport and *verifies*
 * it through another, so its post-upgrade check can compare answers about two
 * different addresses. A memoizing `send` is a second source of truth about the
 * chain living inside the one object whose entire purpose is to be the single
 * translation point — and its staleness window is unbounded, because a
 * `tronbox console` session can switch network under it. Memoization lives on
 * `ChainAccess.identity()`, where its scope is one object.
 */
export function createProvider(channel: RpcChannel): TronEthereumProvider {
  return Object.freeze({
    async send(method: string, params: readonly unknown[]): Promise<unknown> {
      // INV-12: the policy lookup precedes any use of the channel, so a refused
      // method issues **zero** network requests — which is what makes the refusal
      // SF-1's declared property rather than a property of java-tron's method
      // registry, and what spec scenario 7's test asserts.
      const policy = policyFor(method);
      if (policy.kind === 'refuse') {
        throw new ChainMethodRefusedError(method, policy.because);
      }

      // INV-20: likewise refused locally, before the request is built.
      const tag = blockTagVerdict(method, params);
      if (tag.kind === 'refuse') {
        throw new ChainBlockTagRefusedError(method, tag.because);
      }

      const outcome = await channel.post({ method, params });

      switch (outcome.kind) {
        case 'result':
          return stringResultMethods[method] === undefined
            ? // INV-2: resolved **unwrapped and untouched**. No `Object.freeze`,
              // no `seal`, no `preventExtensions`, no `Proxy`, no defensive copy.
              // `provider.js:getTransactionReceipt` does
              // `receipt.status = receipt.status.match(…) ? '0x0' : …` in a
              // `"use strict"` module, and the assignment is **guarded** by
              // `if (receipt?.status)` — which makes freezing *worse* rather than
              // better: a frozen result passes every test that polls a
              // not-yet-mined transaction (`result: null`) and throws
              // `TypeError: Cannot assign to read only property 'status'` only
              // when the receipt finally arrives, i.e. on the **success** path of
              // every deploy, after the transaction is already on chain. This is
              // the one place SF-1 must be less defensive than its instincts.
              outcome.result
            : requireResultShape(method, outcome.result);
        case 'node-error':
          // Every node error raises. `read.ts`'s probes absorb only the two
          // `isProbeOutcome` diagnoses off this error and rethrow the rest
          // (INV-16), so "out of energy" — which arrives on the same `-32000` as
          // a revert — cannot silently disable a safety check.
          throw new ChainRpcError(
            method,
            outcome.error,
            channel.endpoint.describe,
          );
        case 'transport-failure':
          throw new ChainTransportError(
            method,
            outcome.cause,
            channel.endpoint.describe,
          );
        default:
          return assertNever(outcome, 'JsonRpcOutcome');
      }
    },
  });
}
