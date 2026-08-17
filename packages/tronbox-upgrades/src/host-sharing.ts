/**
 * The host-sharing vocabulary of the augmentation policy, in its ONE home.
 *
 * The policy: *the plugin may define members on a host object it has verified
 * it does not share with the host's own cache; it may never mutate a shared
 * instance.* Two directories enforce it at their own mutation sites — the
 * environment seam's `sealSlot` and the result layer's `installGuarded` — and
 * both consume exactly this vocabulary: the injected predicate, its factory,
 * and the refusal.
 *
 * **Why a top-level leaf.** Each enforcing directory is a dependency root the
 * other must not import (the seam imports nothing in the package; the result
 * layer imports only `../output`), so for one release the class existed twice
 * under one name — recorded as a deviation at both sites, with the collapse
 * owed. This module is that collapse: it imports nothing at all, so either
 * root can depend on it without acquiring the other, and the import scans
 * name it as their single sanctioned shared leaf.
 */

/**
 * Where the caller's non-sharing knowledge comes from, quoted verbatim in the
 * refusal. A refusal that names the policy but not its evidence leaves the
 * reader unable to tell a real collision from a mis-supplied guard.
 *
 * The predicate is **required, never optional**, at every consuming site: an
 * optional guard defaulting to "no check" would make the common call site the
 * unguarded one, which is the silent-degradation class the policy exists to
 * eliminate. Required means the compiler forces every call site to name where
 * its shared-instance knowledge comes from.
 */
export interface HostSharingGuard {
  readonly evidence: string;
  /** `true` when the host holds its own reference to `target`. */
  isHostShared(target: object): boolean;
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

/**
 * The guard for a caller that can enumerate every host object it holds — which
 * every call site inside a migration can, because TronBox injects its handles
 * as arguments rather than exposing them to be fetched.
 *
 * Non-object members of `hostObjects` are dropped: a primitive cannot be the
 * target of a mutation, so keeping it would make the set look larger than the
 * knowledge behind it.
 */
export function hostSharingGuard(
  evidence: string,
  hostObjects: readonly unknown[],
): HostSharingGuard {
  const shared = new Set<object>(hostObjects.filter(isObjectLike));
  return Object.freeze({
    evidence,
    isHostShared: (target: object): boolean => shared.has(target),
  });
}

/**
 * Refusal under the augmentation policy: the object about to be mutated is one
 * the host also holds.
 *
 * Deliberately outside the environment seam's three-member error family: this
 * reports a plugin defect, or a host change the plugin has not been updated
 * for — never a diagnosis of the user's environment — which is why it names
 * the member it declined to install and the guard's evidence rather than a
 * slot and a property path.
 */
export class HostInstanceSharedError extends Error {
  readonly code = 'HOST_INSTANCE_SHARED' as const;
  readonly member: string;
  readonly evidence: string;

  constructor(member: string, evidence: string) {
    super(
      `Refusing to install "${member}" on an object TronBox also holds a ` +
        'reference to. The plugin never mutates a shared host instance; it ' +
        'defines members only on an object it has verified is its own, because ' +
        'a shared instance is written back into the artifact on disk and read ' +
        `by every later consumer. Guard evidence: ${evidence}.`,
    );
    this.name = 'HostInstanceSharedError';
    this.member = member;
    this.evidence = evidence;
  }
}
