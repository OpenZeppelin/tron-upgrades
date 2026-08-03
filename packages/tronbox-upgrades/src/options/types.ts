import type {
  DeployOpts,
  ProxyKindOption,
  StandaloneValidationOptions,
  ValidationOptions,
} from '@openzeppelin/upgrades-core';

/**
 * The portable option surface, composed from `@openzeppelin/upgrades-core`'s
 * public types.
 *
 * INV-1: every member upstream already declares is reached by **extension**, never
 * by local re-declaration, and no closed set is widened. The failure mode this
 * avoids is concrete and in this repo's own family: the Hardhat TRON sibling's
 * `src/utils/options.ts:ValidationOptions` is a bare local interface with four
 * members against upstream's six and `unsafeAllow?: string[]`, so a typo
 * type-checks; its `upgradeableContractFor` then hand-copies four fields into the
 * upstream call, and a caller passing `unsafeAllowLinkedLibraries` gets it
 * **silently swallowed before it reaches the engine** — a safety opt-out the
 * caller believes they set.
 *
 * INV-43: `src/options/**` imports only `@openzeppelin/upgrades-core`. Nothing
 * from the seam, nothing from another sub-feature.
 */

/**
 * The exact accepted set for `unsafeAllow`, named through upstream's own **public**
 * `ValidationOptions` rather than by deep-importing `errorKinds` from
 * `dist/validate/run` or by restating the literals.
 *
 * `dist/validate/overrides.d.ts:StandaloneValidationOptions` declares
 * `unsafeAllow?: ValidationError['kind'][]`, so indexing it recovers the union
 * without naming `ValidationError`, which is **not** root-exported — verified
 * present at `@openzeppelin/upgrades-core@1.46.0`: neither `dist/index.d.ts` nor
 * `dist/validate/index.d.ts` re-exports it. That non-export is the root cause of
 * the sibling's widening to `string[]`; indexing the public type is the third
 * option it missed.
 */
export type UnsafeAllowKind = NonNullable<ValidationOptions['unsafeAllow']>[number];

/** `'uups' | 'transparent' | 'beacon'`, from `dist/manifest.d.ts:ProxyDeployment`. */
export type ProxyKind = NonNullable<ProxyKindOption['kind']>;

/** Mirrors the inline union in `plugin-truffle/src/utils/options.ts:StandaloneOptions`. */
export type RedeployMode = 'always' | 'never' | 'onchange';

/**
 * The runtime enumeration, needed because rejecting a value requires naming the
 * accepted ones (scenario 2) and types do not survive compilation.
 *
 * INV-2, both directions: `satisfies` rejects a member upstream does not have, and
 * `_UnsafeAllowKindsComplete` below rejects a member upstream added. An
 * `upgrades-core` bump that changes the set is a **compile error**, not a silent
 * narrowing — which matters because the set grew from 9 members at the
 * parity-target revision to 14 in 1.46.0. Mirroring the parity target's set
 * literally would reject five values the installed engine accepts, which is why
 * "mirror the parity target exactly" is qualified here: the option *shape* is
 * mirrored from the parity target, the closed *value set* comes from the installed
 * engine (divergence D-8).
 *
 * **Verified present at `@openzeppelin/upgrades-core@1.46.0`**: exactly these 14,
 * in this order, matching `dist/validate/run.js:errorKinds`. The deep import that
 * proves it lives in the test canary, never in `src/` — the package ships no
 * `exports` map today, so a minor that adds one would break a `src/` deep import,
 * and a canary that fails loudly is a signal where an outage is not.
 */
export const unsafeAllowKinds = [
  'state-variable-assignment',
  'state-variable-immutable',
  'external-library-linking',
  'struct-definition',
  'enum-definition',
  'constructor',
  'delegatecall',
  'selfdestruct',
  'missing-public-upgradeto',
  'internal-function-storage',
  'missing-initializer',
  'missing-initializer-call',
  'duplicate-initializer-call',
  'incorrect-initializer-order',
] as const satisfies readonly UnsafeAllowKind[];

/** The three proxy kinds, as data, for the same reason and with the same proof. */
export const proxyKinds = [
  'uups',
  'transparent',
  'beacon',
] as const satisfies readonly ProxyKind[];

/** The three redeploy modes, as data. */
export const redeployModes = [
  'always',
  'never',
  'onchange',
] as const satisfies readonly RedeployMode[];

/**
 * Names any union member the list beside it omits, as a compile error, with no
 * runtime emission. The `satisfies` clauses above cover the converse.
 */
type NoMissingMembers<Missing extends never> = Missing;
type _UnsafeAllowKindsComplete = NoMissingMembers<
  Exclude<UnsafeAllowKind, (typeof unsafeAllowKinds)[number]>
>;
type _ProxyKindsComplete = NoMissingMembers<
  Exclude<ProxyKind, (typeof proxyKinds)[number]>
>;
type _RedeployModesComplete = NoMissingMembers<
  Exclude<RedeployMode, (typeof redeployModes)[number]>
>;

/**
 * Mirrors `plugin-truffle/src/utils/options.ts:StandaloneOptions`, less its
 * deployer member, which is deployment-shaped and therefore SF-4's (INV-47).
 *
 * Fields are deliberately **not** `readonly`: `unsafeAllow` and the rest arrive
 * through upstream's own interfaces, and re-declaring them to add `readonly` is
 * precisely the local-narrowing mistake INV-1 exists to prevent. The mutation
 * hazard those types carry is neutralized at the one place that reaches upstream —
 * see `resolve.ts:engineValidationOptions`.
 */
export interface StandaloneOptions extends StandaloneValidationOptions, DeployOpts {
  constructorArgs?: unknown[];
  /**
   * @deprecated Use `redeployImplementation: 'never'`. Mirrored because the parity
   * target declares it; collapsed into `redeployImplementation` at resolution, so
   * exactly one field expresses the policy downstream.
   */
  useDeployedImplementation?: boolean;
  redeployImplementation?: RedeployMode;
}

/** Mirrors `plugin-truffle/src/utils/options.ts:UpgradeOptions`. */
export interface UpgradeOptions extends ValidationOptions, StandaloneOptions {}

/** Mirrors the private `plugin-truffle/src/utils/options.ts:Initializer`. */
export interface InitializerOption {
  initializer?: string | false;
}

/** The `call` member `upgradeProxy` accepts and `deployProxy` does not. */
export interface CallOption {
  call?: { fn: string; args?: unknown[] } | string;
}

export type DeployProxyOptions = StandaloneOptions & InitializerOption;
export type UpgradeProxyOptions = UpgradeOptions & CallOption;
export type PrepareUpgradeOptions = UpgradeOptions;
export type DeployImplementationOptions = StandaloneOptions;
export type DeployBeaconOptions = StandaloneOptions;
export type UpgradeBeaconOptions = UpgradeOptions;
/**
 * Includes `DeployOpts` where the parity target omits it (divergence D-4). That
 * omission is an upstream inconsistency — the Hardhat plugin's equivalent does
 * include it — harmless in Truffle where the fields are inert, but on TRON it
 * would leave one operation with no confirmation control (divergence D-1).
 */
export type DeployBeaconProxyOptions = ProxyKindOption &
  InitializerOption &
  DeployOpts;
export type ForceImportOptions = ProxyKindOption;
export type ValidateImplementationOptions = StandaloneValidationOptions;
export type ValidateUpgradeOptions = ValidationOptions;

/**
 * Options after resolution.
 *
 * INV-3: every field is **required**, so "defaults were applied" is a type-level
 * fact and no downstream module writes `?? default` a second time. The object and
 * both its arrays are frozen, and no field is ever assigned an explicit
 * `undefined` — under this package's `exactOptionalPropertyTypes: true` that would
 * be a compile error anyway (verified this stage: `const a: ValidationOptions = {
 * kind: undefined }` fails with **TS2375**).
 *
 * The hazard this shape removes is the spec's own stakes line: a downstream
 * operation reading `resolved.timeout` as possibly-undefined and re-applying its
 * own default, which silently diverges from the parity target's the moment either
 * changes.
 */
export interface ResolvedUpgradeOptions {
  /**
   * Exactly what upstream's engine entry points demand.
   * `getStorageUpgradeReport` and one `assertStorageUpgradeSafe` overload are
   * declared over `Required<ValidationOptions>` (`dist/storage/index.d.ts`), so a
   * narrowed local option type is *structurally* unable to call them. Carrying the
   * upstream-shaped object explicitly turns that constraint into a compile-time
   * obligation instead of a note — and it is the type system's own proof that
   * narrowing upstream's validation surface is wrong.
   *
   * **Frozen. Do not hand this to an engine entry point directly** — use
   * `resolve.ts:engineValidationOptions`, which exists because upstream mutates
   * what it is given. See that function for the verified mechanism.
   */
  readonly validation: Required<ValidationOptions>;
  readonly constructorArgs: readonly unknown[];
  readonly redeployImplementation: RedeployMode;
  /**
   * Milliseconds. `0` means wait indefinitely, per `dist/deployment.d.ts:DeployOpts`.
   *
   * Divergence D-1: the parity target's own comment says these are *"not used for
   * Truffle, but include these anyways"*. On TRON confirmation is real, so the
   * value acquires meaning — a wrong value here is a real confirmation-policy
   * change rather than a dead field. Shape and default are mirrored exactly; the
   * confirmation policy itself is SF-4's.
   */
  readonly timeout: number;
  /** Milliseconds. See divergence D-1 on {@link timeout}. */
  readonly pollingInterval: number;
}

/** The outcome of the `initializer` rule. Never a nullable function name. */
export type InitializerResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'call'; readonly fn: string };
