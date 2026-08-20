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
  const host = hostKey(deployer);
  if (host === undefined) {
    // Nothing to key on — a call with no deployer handle runs free.
    return run();
  }
  if (active.getStore() === host) {
    // A nested operation would await its own tail: a silent hang. Refuse by
    // name instead.
    throw new NestedOperationError(operation);
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
