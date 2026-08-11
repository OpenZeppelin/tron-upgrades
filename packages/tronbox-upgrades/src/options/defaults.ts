import type { RedeployMode } from './types';

/**
 * The defaults table: one entry per option this package owns, each traced to the
 * parity-target site its value came from.
 *
 * **The six validation defaults are not here, and that is the point.**
 * `resolveUpgradeOptions` calls upstream's `withValidationDefaults`, so they cannot
 * drift by construction. A local re-implementation of `kind: 'transparent'` or
 * `unsafeAllowRenames: false` that drifted from upstream would flip the safety
 * posture of every operation with no diagnostic — the risk the option/result
 * surface exists to remove:
 * *"a silently flipped default … changes safety posture across every
 * operation"*.
 *
 * What this table owns is the five values upstream has no opinion about, plus the
 * recorded expectation the canary checks upstream against.
 */

/** The five defaults this package owns. */
export const pluginOptionDefaults: {
  readonly timeout: number;
  readonly pollingInterval: number;
  readonly redeployImplementation: RedeployMode;
  readonly useDeployedImplementation: boolean;
  readonly unsafeSkipProxyAdminCheck: boolean;
} = Object.freeze({
  /** Milliseconds. Live on TRON — a recorded divergence from the parity target. */
  timeout: 60_000,
  /** Milliseconds. Live on TRON — a recorded divergence from the parity target. */
  pollingInterval: 5_000,
  redeployImplementation: 'onchange',
  /** Collapsed into `redeployImplementation` at resolution; never surfaces. */
  useDeployedImplementation: false,
  unsafeSkipProxyAdminCheck: false,
});

/** `constructorArgs` when the caller supplies none. Frozen, shared, never mutated. */
export const defaultConstructorArgs: readonly unknown[] = Object.freeze([]);

/**
 * The initializer function name when the caller supplies none and there is at
 * least one argument, from
 * `plugin-truffle/src/utils/initializer-data.ts:getInitializerData`.
 */
export const DEFAULT_INITIALIZER = 'initialize';

/**
 * What `withValidationDefaults({})` is recorded as returning.
 *
 * A canary asserts this against the installed package in **both**
 * directions, so an `upgrades-core` bump that changes a validation default is a
 * failing test rather than a silent safety-posture change. This value is **never
 * read by resolution** — it is the canary's expectation, not a fallback, and
 * making it a fallback would reintroduce exactly the drift the invariant closes.
 *
 * **Verified present at `@openzeppelin/upgrades-core@1.46.0`** by
 * calling `withValidationDefaults({})` against the installed tree: these six keys,
 * these six values. The set is also exactly `Required<ValidationOptions>`, and it
 * **includes both deprecated booleans** — the structural fact that makes narrowing
 * upstream's surface incompatible with calling `getStorageUpgradeReport`.
 */
export const recordedUpstreamValidationDefaults: {
  readonly kind: 'transparent';
  readonly unsafeAllow: readonly never[];
  readonly unsafeAllowCustomTypes: false;
  readonly unsafeAllowLinkedLibraries: false;
  readonly unsafeAllowRenames: false;
  readonly unsafeSkipStorageCheck: false;
} = Object.freeze({
  kind: 'transparent',
  unsafeAllow: Object.freeze([]),
  /** Derived by upstream: true when `unsafeAllow` holds struct- **and** enum-definition. */
  unsafeAllowCustomTypes: false,
  /** Derived by upstream: true when `unsafeAllow` holds external-library-linking. */
  unsafeAllowLinkedLibraries: false,
  unsafeAllowRenames: false,
  unsafeSkipStorageCheck: false,
});

/**
 * The lower bound on both millisecond options. `0` is legal and means "wait
 * indefinitely" per `dist/deployment.d.ts:DeployOpts`, so the bound is inclusive.
 * Upstream validates neither option, in either plugin.
 */
export const MILLISECOND_OPTION_MINIMUM = 0;
