/**
 * The owned-promise bridge over TronBox's migration queue — the only module in
 * `src/deploy/**` that touches the host deployer (INV-19).
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
 * So no host queue value ever escapes this module (INV-1). Every operation gets
 * a promise this module allocates, settled exactly once from inside the queued
 * step, and the step returns to the host fulfilled in both cases (INV-3) — a
 * failure inside the step rejects the operation's caller and never propagates
 * into the host chain, where it would reach the runner a second time *and*
 * leave the chain's final `then(this._done)` link rejected with no handler.
 *
 * The one consequence this cannot repair, declared rather than hidden: a
 * migration that queues an operation **without awaiting it** observes a host
 * chain that stays fulfilled, so the runner does not learn the step failed.
 * The remedy is to `await` the operation, and the limitation rides the result
 * surface (INV-9), not only this comment.
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
 * either way (INV-3), which is what keeps one error from being delivered three
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
      // Reached in both arms: the host chain continues fulfilled (INV-3).
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
 * INV-5's marshalling guard. The host's deploy action inspects the **final**
 * argument: a non-null, non-array object has `overwrite` destructured off it
 * and the remainder forwarded — the constructor receives a struct the caller
 * never wrote, and with `overwrite: false` the deployment is silently skipped.
 * A user argument of that shape is refused by name rather than forwarded bare.
 */
export function assertNoCheatcodeCollision(args: readonly unknown[]): void {
  if (args.length === 0) {
    return;
  }
  const last = args[args.length - 1];
  if (typeof last === 'object' && last !== null && !Array.isArray(last)) {
    throw new CheatcodeSlotCollisionError();
  }
}

/**
 * INV-11's staleness assertion: the transaction identity about to be reported
 * must have been produced by *this* run. The host's `overwrite: false` skip
 * path returns the previously deployed instance, whose `transactionHash` is a
 * real hash from an earlier deployment — a stale truth. `assertNoCheatcodeCollision`
 * makes that path unreachable from this seam's own calls; this check is what
 * verifies the guarantee held instead of trusting it.
 */
export function assertFreshTransaction(
  before: string | null,
  after: WriteBack,
): void {
  if (before !== null && before === after.transactionHash) {
    throw new StaleTransactionIdentityError(after.transactionHash);
  }
}
