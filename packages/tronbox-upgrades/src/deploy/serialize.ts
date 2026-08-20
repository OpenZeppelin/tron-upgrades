/**
 * One operation at a time per deployer.
 *
 * The queue bridge (`queue.ts`) cannot be the mutex: by the time an operation
 * reaches it, the pre-queue phase — chain identity, the record session,
 * validation, layout reads — has already run concurrently with any other
 * operation, racing the engine's manifest lock, and "call order" would be
 * decided by network jitter. So the mutex sits at the public operation entry,
 * claimed synchronously before the first `await`: call order holds by
 * construction, and the second operation performs no manifest read until the
 * first has finished. Per process — two `tronbox migrate` processes still
 * meet the record lock (`RecordLockedError`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { NestedOperationError } from './errors';

const tails = new WeakMap<object, Promise<unknown>>();
const active = new AsyncLocalStorage<object>();

/** The handle is `unknown` at the entries; only an object can key a WeakMap. */
function hostKey(deployer: unknown): object | undefined {
  return (typeof deployer === 'object' && deployer !== null) ||
    typeof deployer === 'function'
    ? (deployer as object)
    : undefined;
}

export function serializeOperation<T>(
  operation: string,
  deployer: unknown,
  run: () => Promise<T>,
): Promise<T> {
  if (active.getStore() !== undefined) {
    // Any operation started inside another refuses by name, BEFORE the
    // keyed/unkeyed split: same-host nesting awaits its own tail, a
    // cross-deployer chain that re-enters an outer deployer (A on d1 → B on
    // d2 → C on d1) would pass an innermost-host equality check and deadlock
    // on d1's tail just the same (review r3823745356), and an UNKEYED nested
    // call checked after the split would silently run outside the mutex it
    // is nested within. No legitimate operation runs inside another, and an
    // unconditional refusal cannot deadlock on any deployer count. One known
    // edge, accepted: the store survives into DETACHED async work an
    // operation spawns and never awaits (a timer, a dropped promise), so an
    // operation started from such a descendant refuses too — nothing in this
    // package spawns one, and a loud refusal there beats a silent deadlock.
    // The caller's own continuations are NOT this edge: the returned
    // promise's reactions are registered at the call site, outside the
    // store, so `await op1; op2()` and `op1.then(() => op2())` both compose.
    throw new NestedOperationError(operation);
  }
  const host = hostKey(deployer);
  if (host === undefined) {
    // Nothing to key on — a top-level call with no deployer handle runs free.
    return run();
  }
  const tail = tails.get(host);
  const chained =
    tail === undefined
      ? active.run(host, run)
      : tail.then(() => active.run(host, run));
  // The tail chains on settlement, never success, so a failing operation
  // rejects only its own caller. The absorber lives on this PRIVATE promise;
  // the one returned below carries no handler of ours, so dropping it
  // un-awaited stays an unhandled rejection under Node's defaults.
  tails.set(
    host,
    chained.then(
      () => undefined,
      () => undefined,
    ),
  );
  return chained.then(value => value);
}
