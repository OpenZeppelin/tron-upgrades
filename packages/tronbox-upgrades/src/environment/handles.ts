/**
 * The outcome of reading one property off a host object.
 *
 * INV-17 turns on the three states being distinguishable: a key that is absent,
 * a key present with a nullish value, and a key present with a falsy-but-valid
 * value. `'threw'` is a fourth, host-specific state —
 * `build/components/Config.js:Config`'s `network_config` getter raises
 * "Network not set" — and is reported separately so a message can say which
 * happened rather than collapsing a raising getter into a missing key.
 */
export type PropertyRead =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'threw';
    };

/**
 * INV-33: every TronBox-internal property path a resolution reads is recorded
 * at the read site, so the reported set is neither a static list nor a
 * superset. An instance's lifetime is one resolution — INV-20 forbids
 * module-scope mutable state, which is why this is a class and not a module
 * singleton.
 */
export class InternalPathRecorder {
  readonly #paths = new Set<string>();

  record(path: string): void {
    this.#paths.add(path);
  }

  snapshot(): readonly string[] {
    return Object.freeze([...this.#paths]);
  }
}

export function isObjectLike(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
  );
}

function read(
  owner: unknown,
  key: PropertyKey,
  path: string,
  recorder: InternalPathRecorder,
  present: (owner: Record<PropertyKey, unknown>) => boolean,
): PropertyRead {
  recorder.record(path);
  if (!isObjectLike(owner)) {
    return { ok: false, reason: 'missing' };
  }

  try {
    if (!present(owner)) {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true, value: owner[key] };
  } catch {
    // A host accessor raised. INV-15: no host throw escapes the seam.
    return { ok: false, reason: 'threw' };
  }
}

/**
 * INV-17: own-property presence, never truthiness. `Config.prototype.addProp`'s
 * getter is `if (this._values[key]) return this._values[key]; …` — a truthiness
 * test — so a key explicitly set to `''` falls through to its default and
 * reports a value the user did not configure. Testing presence instead of
 * truthiness is what keeps those two states apart.
 */
export function readOwnProperty(
  owner: unknown,
  key: PropertyKey,
  path: string,
  recorder: InternalPathRecorder,
): PropertyRead {
  return read(owner, key, path, recorder, target =>
    Object.prototype.hasOwnProperty.call(target, key),
  );
}

/**
 * The `in` variant, for members that legitimately live on a prototype —
 * `ResolverIntercept.prototype.require`, `Deployer.prototype.then`. Using
 * `readOwnProperty` for those would reject a valid handle.
 */
export function readProperty(
  owner: unknown,
  key: PropertyKey,
  path: string,
  recorder: InternalPathRecorder,
): PropertyRead {
  return read(owner, key, path, recorder, target => key in target);
}

/** A handle counts as supplied when the caller passed anything but `undefined`. */
export function supplied(value: unknown): boolean {
  return value !== undefined;
}

/**
 * What a redacted host handle serializes to.
 *
 * **Five host handles are exposed whole and all five are sealed.** INV-29's rule
 * is *all five are unsafe to log*, deliberately not keyed to the subset that is
 * credential-reachable today — a rule keyed to that subset is one an upstream
 * bump silently expires. The column below is a fact about `v4.8.0` and `v4.9.0`;
 * the rule has to survive `v4.10`.
 *
 * Two are verified credential-reachable by *own-enumerable* traversal, three
 * routes each, shallowest depth 4:
 *
 * ```
 * scheduling.deployer → options.options.network_config.privateKey   (depth 4)
 * artifacts.intercept → resolver.options.network_config.privateKey  (depth 4)
 * ```
 *
 * with `…networks.<name>.privateKey` and `…_values.networks.<name>.privateKey`
 * one and two hops further. `receipts.waitForTransactionReceipt` and
 * `output.logger` have no route in any shape TronBox injects. Hiding `networks`
 * would not close the first two: `Config`'s `network_config` getter mints a fresh
 * merged object carrying `privateKey` on every access.
 *
 * `chain.tronWrap` is covered **by the rule rather than by measurement** — a live
 * instance requires a reachable node, so it has not been probed. Two facts are
 * verified present at v4.8.0 and v4.9.0 and the seam relies on **neither**: the
 * account keys live in a module-scope `let privateKeyByAccount`
 * (`src/components/TronWrap/index.js`) rather than on the instance, and the one
 * instance-reachable credential the host does hide is masked by the host's own
 * proxy (`src/components/TronWrap/TronWebProxy.js`,
 * `HIDDEN_PROPS = new Set(['defaultPrivateKey'])`, filtered out of `ownKeys`). A
 * mask the seam does not own is not a guarantee the seam can make, and an
 * unprobed handle is not a safe one.
 *
 * INV-40 requires that no credential appear in any slot field, while INV-29
 * deliberately exposes those five as named capabilities — a slot that hid its
 * handle would not be a usable capability. TronBox applies no shield to `Config`,
 * `Deployer` or `Resolver`, so the seam applies one at its own boundary.
 */
export const REDACTED_HOST_HANDLE =
  '[TronBox host handle — redacted, not serialized]';

/*
 * The host-object augmentation policy's vocabulary — the injected predicate,
 * its factory and the refusal — lives in `../host-sharing`, the one shared
 * leaf this seam and the result layer may both import (each is a dependency
 * root the other must not import, so for one release the refusal class
 * existed twice under one name; the shared leaf is the recorded collapse).
 * Re-exported here so the seam's face is unchanged: every sealing site in
 * this seam names its evidence through `hostSharingGuard`, because the
 * handles arrive as arguments (`types.ts:RawMigrationHandles`) rather than
 * being fetched from anywhere.
 *
 * The refusal is deliberately **not** a `TronBoxEnvironmentError` — INV-10
 * fixes that family at three, and this is not a diagnosis of the user's
 * environment.
 */
import {
  HostInstanceSharedError,
  hostSharingGuard,
  type HostSharingGuard,
} from '../host-sharing';

export { HostInstanceSharedError, hostSharingGuard };
export type { HostSharingGuard };

/**
 * Freezes a slot and gives it a non-enumerable `toJSON` that replaces the named
 * host-handle fields with {@link REDACTED_HOST_HANDLE}.
 *
 * Redaction is `toJSON` rather than non-enumerable properties on purpose. Making
 * the handle non-enumerable would also break spread and `Object.keys`, so
 * `{ ...env.output }` would silently drop `logger`; `toJSON` breaks only
 * serialization, which is the behaviour that has to break. It additionally makes
 * the composite serializable at all: a real `Deployer` reaches its Config, whose
 * `_values.resolver.options` closes a cycle, so plain
 * `JSON.stringify(composite)` throws `TypeError: Converting circular structure
 * to JSON` without this.
 *
 * Installing `toJSON` is a mutation, so the augmentation policy applies and
 * `guard` is how it is enforced — asserted at the point of mutation rather than
 * argued in a comment. At all five of this seam's sealing sites the predicate is
 * `false` today, because every one passes a fresh object literal allocated in the
 * same call. That is the point: the guard is what makes a refactor which seals a
 * host handle *itself* refuse here, instead of writing `toJSON` onto an object
 * TronBox will later hand to `artifactor.saveAll`. It converts "breaks if the
 * plugin changes" into "refuses if the plugin changes".
 *
 * Note what the guard is *not* protecting against, so the two hazards do not get
 * conflated: `Object.defineProperty` here cannot fail on a non-configurable
 * property the way SF-10's `events` augmentation does, because the host installs
 * `toJSON` as a `_static_method` — writable and configurable — rather than through
 * `Contract.addProp`, which forces `configurable: false`. That makes this site
 * *mechanically* fine and is exactly why the guard is needed: without it the only
 * thing standing between the seam and a poisoned host object is a property of
 * TronBox's implementation that nobody would notice changing.
 */
export function sealSlot<T extends object>(
  slot: T,
  handleKeys: readonly (keyof T & string)[],
  guard: HostSharingGuard,
): T {
  if (guard.isHostShared(slot)) {
    throw new HostInstanceSharedError('toJSON', guard.evidence);
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slot)) {
    redacted[key] = handleKeys.includes(key as keyof T & string)
      ? REDACTED_HOST_HANDLE
      : value;
  }
  Object.freeze(redacted);

  Object.defineProperty(slot, 'toJSON', {
    value: () => redacted,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(slot);
}
