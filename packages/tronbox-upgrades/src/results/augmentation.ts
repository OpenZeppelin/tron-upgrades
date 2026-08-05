/**
 * The host-object augmentation policy, and its one guarded helper.
 *
 * **The policy (INV-19):** *the plugin may define non-enumerable accessors on a
 * host object it has verified it does not share with the host's own cache. It may
 * never mutate a shared instance.*
 *
 * Concretely: no module may install, redefine or delete a property on a
 * host-supplied object without first verifying that the object is not held in the
 * host's own cache. Verification is an **injected predicate**, required and not
 * optional, supplied by the caller that owns the cache. When the predicate says the
 * object is shared, the plugin **refuses and says why** — it never proceeds and
 * never falls back to mutating.
 *
 * **Why this lives in SF-10 with no SF-10 call site.** The result contract itself
 * has zero mutation sites: `limitations.ts` seals by proxying, so it satisfies the
 * policy by construction. But the policy applies package-wide, and SF-10 is the
 * dependency root every operation imports — SF-3 and SF-4 will mutate TronBox's
 * abstraction, because writing the address onto the cached class is *how* the
 * host's own artifact lookup finds a deployment afterwards. Handing SF-11 one
 * function to point a mechanical rule at (`Object.defineProperty`,
 * `Object.defineProperties`, `Object.setPrototypeOf`, `delete` and new-member
 * assignment on a host object are permitted only through {@link installGuarded}) is
 * what makes INV-19 enforceable rather than reviewed.
 *
 * **Deviation 10, closed:** for one release this file and SF-0's
 * `src/environment/handles.ts` each declared a `HostInstanceSharedError` of its
 * own — one policy, one name, two homes, because each is a dependency root the
 * other must not import. The vocabulary now lives in `../host-sharing`, the one
 * shared leaf both roots may import, and this file re-exports it so its face is
 * unchanged.
 */

import {
  HostInstanceSharedError,
  hostSharingGuard,
  type HostSharingGuard,
} from '../host-sharing';

export { HostInstanceSharedError, hostSharingGuard };
export type { HostSharingGuard };

/*
 * Why the refusal exists at all — the **verified host mechanism** this file's
 * guard call sites are protecting against:
 * `build/components/Resolver/intercept.js:ResolverIntercept`
 * holds `this.cache = {}` keyed by normalized import path, and `contracts()` returns
 * `Object.values(cache)` — byte-identical on 4.9.0 and 4.8.0 — which `Migrate` hands
 * to `artifactor.saveAll`. Today `Contract.at` clones first
 * (`this.clone(JSON.parse(JSON.stringify(this._json)))`, identical on both minors,
 * and the clone is verifiably not the abstraction), so nothing a caller receives
 * reaches the cache. **That is a property of TronBox's implementation, not a
 * guarantee.** If a future minor hands back the cached instance, an unguarded
 * augmentation poisons every later consumer of that abstraction *and* is written
 * into the artifact on disk. The guard converts "breaks if TronBox changes" into
 * "refuses if TronBox changes".
 */

/**
 * The one sanctioned property-installation site for a host-supplied object.
 *
 * @param target the host object to augment
 * @param member the property name being installed
 * @param descriptor how to install it. Defaults to non-enumerable, so
 *   `JSON.stringify` and `Object.keys` see nothing new; a caller that needs
 *   otherwise says so explicitly.
 * @param guard **required**, never optional. An optional guard defaulting to "no
 *   check" would make the common call site the unguarded one, which is the
 *   silent-degradation class this policy exists to eliminate. Required means the
 *   compiler forces every call site to name where its shared-instance knowledge
 *   comes from.
 *
 * @throws {HostInstanceSharedError} when `guard` reports the object is shared
 *
 * Note what the guard does **not** protect against, so the two hazards are not
 * conflated: `Object.defineProperty` still fails on a non-configurable property,
 * which is absolute and unrelated to identity — it is why the result contract seals
 * by proxying instead (`limitations.ts`). A member installed through
 * `Contract.addProp` is non-configurable and cannot be augmented at all; a
 * `_static_method` is a writable, configurable data property and can.
 */
export function installGuarded(
  target: object,
  member: string,
  descriptor: PropertyDescriptor,
  guard: HostSharingGuard,
): void {
  if (guard.isHostShared(target)) {
    throw new HostInstanceSharedError(member, guard.evidence);
  }
  Object.defineProperty(target, member, {
    enumerable: false,
    configurable: false,
    ...descriptor,
  });
}
