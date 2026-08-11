/**
 * The owned-promise bridge over TronBox's migration queue — the only module in
 * `src/deploy/**` that touches the host deployer.
 *
 * ## Why the bridge exists, measured rather than assumed
 *
 * `Deployer.prototype.queueOrExec` is two different functions wearing one name.
 * After `start()` it returns a native `Promise` and behaves normally. Before
 * `start()` — the state every migration body runs in — it returns the
 * `DeferredChain` itself, whose `then` is declared with **one parameter**: the
 * `onRejected` an `await` supplies is discarded. The failure is *not* lost — the
 * chain's appended catch fires `_error(e)`, so the runner's `await start()`
 * rejects with the original error — but the **individual caller's await never
 * settles**: not on failure (their `onFulfilled` is never called and they
 * registered nothing else) and, on success, not until `start()` drives the
 * chain. A leaked suspended await, byte-identical across both supported minors.
 *
 * So no host queue value ever escapes this module. Every operation gets
 * a promise this module allocates, settled exactly once from inside the queued
 * step, and the step returns to the host fulfilled in both cases — a
 * failure inside the step rejects the operation's caller and never propagates
 * into the host chain, where it would reach the runner a second time *and*
 * leave the chain's final `then(this._done)` link rejected with no handler.
 *
 * The one consequence this cannot repair, declared rather than hidden: a
 * migration that queues an operation **without awaiting it** observes a host
 * chain that stays fulfilled, so the runner does not learn the step failed.
 * The remedy is to `await` the operation, and the limitation rides the result
 * surface, not only this comment.
 */

import type { QueueHost, WriteBack } from './types';
import {
  CheatcodeSlotCollisionError,
  DeploySeamInvariantError,
  StaleTransactionIdentityError,
} from './errors';

/**
 * Queues `step` on the host and returns a promise this seam owns. The host's
 * return value is consumed here and never escapes. The step's failure settles
 * the returned promise and nothing else — the host chain sees a fulfilled step
 * either way, which is what keeps one error from being delivered three
 * times (caller, runner, unhandled-rejection handler).
 */
export function runThroughQueue<T>(
  host: QueueHost,
  step: () => Promise<T> | T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settleOnce = (settle: () => void): void => {
      if (settled) {
        // Loud, unconditional, and not a refusal: a double settlement is a bug
        // in this seam, not a state a caller can cause or remedy.
        throw new DeploySeamInvariantError('a queued step settled twice');
      }
      settled = true;
      settle();
    };
    const chained = host.then(async () => {
      try {
        const value = await step();
        settleOnce(() => resolve(value));
      } catch (failure) {
        settleOnce(() => reject(failure));
      }
      // Reached in both arms: the host chain continues fulfilled.
    });
    /*
     * The skipped-step case, without which the promise above can settle zero
     * times: when an EARLIER step in the migration failed pre-start, the chain
     * arrives rejected and never calls the step queued above — the try/catch
     * guards a body that does not run. `then` is the host queue's defective
     * arity-1 method, but its `catch` is real and appends a genuine rejection
     * handler, so the upstream failure is observable there. The rethrow is
     * load-bearing: without it the chain would continue FULFILLED past this
     * link, and a user's later migration step would execute after a failure
     * the host's own semantics say must skip it.
     */
    const catchable = chained as {
      catch?: (onRejected: (failure: unknown) => unknown) => unknown;
    };
    if (typeof catchable.catch === 'function') {
      catchable.catch((failure: unknown) => {
        if (!settled) {
          settleOnce(() => reject(failure));
        }
        throw failure;
      });
    }
  });
}

/**
 * The marshalling guard. `hostDeploy` calls the host's `abstraction.new(...)`
 * directly, and that call's own contract layer — `filterEnergyParameter` in
 * `Contract/contract.js` — inspects the **final** argument, taking the same
 * branch for a plain object AND for `null` (`typeof null === 'object'`).
 * Verified against both installed minors (`tronbox-4.8.0`, `tronbox-4.9.0`),
 * because they disagree past that point:
 *
 * - A trailing plain object is popped off the argument list entirely
 *   (`args.pop()`) and mined for the keys recognized as deploy parameters
 *   (`feeLimit`, `originEnergyLimit`, and the rest of
 *   `constants.deployParameters`) — the constructor never receives the
 *   struct, and everything else in it is discarded, identically on both
 *   minors. Usually a loud arity mismatch; silent exactly when the
 *   constructor also expects that many arguments once the struct is popped.
 * - A trailing `null` is where the minors diverge: 4.8.0 has no null guard
 *   and crashes inside `filterEnergyParameter` itself (`Object.keys(null)`
 *   throws before any deploy is attempted); 4.9.0 added a null check and
 *   passes `null` through untouched, where the ABI encoder's behavior then
 *   depends on the constructor parameter's type (most types throw a
 *   clear-but-unnamed error; a `bool` parameter silently coerces `null` to
 *   `false` — measured against `ethers.AbiCoder`). Neither outcome is a
 *   value this plugin can vouch for.
 *
 * A user argument of either shape is refused by name rather than forwarded
 * bare into whichever of these the installed host version does.
 */
export function assertNoCheatcodeCollision(args: readonly unknown[]): void {
  if (args.length === 0) {
    return;
  }
  const last = args[args.length - 1];
  if (last === null) {
    throw new CheatcodeSlotCollisionError('null');
  }
  if (typeof last === 'object' && !Array.isArray(last)) {
    throw new CheatcodeSlotCollisionError('plain-object');
  }
}

/**
 * The staleness assertion: the transaction identity about to be reported
 * must have been produced by *this* call to `hostDeploy`. The `overwrite:
 * false` skip this was originally written to guard is real TronBox
 * behavior, but it lives one layer up, in `deployer.deploy()`'s action
 * wrapper (`Deployer/src/actions/deploy.js`) — it destructures `overwrite`
 * off a trailing struct and, when it is `false` and the contract
 * `isDeployed()`, returns the already-deployed instance instead of calling
 * `.new()`. `hostDeploy` never goes through that action: it calls
 * `abstraction.new(...)` directly, and neither `.new()` nor the
 * `filterEnergyParameter` step it runs through has any skip branch of its
 * own — verified against the installed host source. So that specific skip
 * is not reachable from this seam's call chain today. What this check
 * verifies is the invariant that remains real regardless: a `hostDeploy`
 * call reports a genuinely new transaction, not a replayed one. Checked
 * rather than assumed, so a future change that routes a deploy through
 * `deployer.deploy()` — or a host version whose `.new()` grows a skip of its
 * own — is caught instead of silently trusted.
 */
export function assertFreshTransaction(
  before: string | null,
  after: WriteBack,
): void {
  if (before !== null && before === after.transactionHash) {
    throw new StaleTransactionIdentityError(after.transactionHash);
  }
}
