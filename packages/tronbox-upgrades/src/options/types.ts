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
 * Every member upstream already declares is reached by **extension**, never
 * by local re-declaration, and no closed set is widened. The failure mode this
 * avoids is concrete and in this repo's own family: the Hardhat TRON sibling's
 * `src/utils/options.ts:ValidationOptions` is a bare local interface with four
 * members against upstream's six and `unsafeAllow?: string[]`, so a typo
 * type-checks; its `upgradeableContractFor` then hand-copies four fields into the
 * upstream call, and a caller passing `unsafeAllowLinkedLibraries` gets it
 * **silently swallowed before it reaches the engine** — a safety opt-out the
 * caller believes they set.
 *
 * `src/options/**` imports only `@openzeppelin/upgrades-core`. Nothing
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
 * Both directions: `satisfies` rejects a member upstream does not have, and
 * `_UnsafeAllowKindsComplete` below rejects a member upstream added. An
 * `upgrades-core` bump that changes the set is a **compile error**, not a silent
 * narrowing — which matters because the set grew from 9 members at the
 * parity-target revision to 14 in 1.46.0. Mirroring the parity target's set
 * literally would reject five values the installed engine accepts, which is why
 * "mirror the parity target exactly" is qualified here: the option *shape* is
 * mirrored from the parity target, the closed *value set* comes from the installed
 * engine — a recorded divergence from the parity target.
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
 * deployer member, which is deployment-shaped and therefore the deploy seam's.
 *
 * Fields are deliberately **not** `readonly`: `unsafeAllow` and the rest arrive
 * through upstream's own interfaces, and re-declaring them to add `readonly` is
 * precisely the local-narrowing mistake the extension-only requirement exists
 * to prevent. The mutation
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
/**
 * **A recorded divergence from the parity target, the same pattern as
 * {@link DeployBeaconProxyOptions}'s own `kind` omission below:** a beacon
 * has exactly one kind, so `deployBeacon`'s accepted-options list
 * (`beacon/index.ts:DEPLOY_BEACON_ACCEPTED_OPTIONS`) refuses `kind` outright. Built
 * as `Omit<StandaloneOptions, 'kind'>` rather than a fresh composition —
 * `StandaloneOptions` itself keeps `kind` (`DeployProxyOptions` and
 * `DeployImplementationOptions` both need it, and both genuinely accept it
 * at runtime), so the member is dropped locally, on this alias only, rather
 * than widening the omission to every type built from the shared base.
 *
 * Beyond `kind`, this alias needed no further narrowing when
 * `beacon/index.ts`'s accepted-options list was split per operation:
 * `StandaloneOptions` never carried `initializer` (that is
 * `InitializerOption`'s, added only to `DeployProxyOptions`) or
 * `unsafeAllowRenames`/`unsafeSkipStorageCheck` (those are
 * `ValidationOptions`-only, i.e. upgrade-shaped, and `deployBeacon` — a
 * fresh deploy with no prior layout — never compares storage). The type was
 * already exactly this narrow; only the runtime accepted-options list
 * (formerly the shared `BEACON_ACCEPTED_OPTIONS`) had to catch up.
 */
export type DeployBeaconOptions = Omit<StandaloneOptions, 'kind'>;
/**
 * Same divergence, same reason, same pattern: see {@link DeployBeaconOptions}.
 *
 * Also already exactly narrow enough beyond `kind`: `UpgradeOptions` never
 * carried `initializer` (an upgrade sends no proxy init call) or
 * `initialOwner` (the beacon's owner is set once, at `deployBeacon`; an
 * upgrade never touches it) — unlike `deployBeacon`'s alias above,
 * `unsafeAllowRenames`/`unsafeSkipStorageCheck` DO belong here, because
 * `upgradeBeacon` compares storage against the beacon's current
 * implementation and both options reach that comparison.
 */
export type UpgradeBeaconOptions = Omit<UpgradeOptions, 'kind'>;
/**
 * **Two recorded divergences from the parity target, both in this one type:**
 *
 * 1. It includes `DeployOpts` where the parity target omits it. That omission
 *    is an upstream inconsistency — the Hardhat plugin's equivalent does
 *    include it — harmless in Truffle where the fields are inert, but on
 *    TRON it would leave one operation with no confirmation control, which is
 *    itself a second recorded divergence. **Type-shape only, today**:
 *    `timeout`/`pollingInterval` resolve with defaults on every operation,
 *    this one included, but nothing yet threads them to the confirmation
 *    wait (`proxy/toolkit.ts`'s `confirm` always uses the host's own fixed
 *    bound) — a separate, pre-existing gap this composition choice does not
 *    itself close.
 * 2. It omits `ProxyKindOption`, where the parity-shaped type would include
 *    it. A beacon proxy has exactly one kind, so `deployBeaconProxy`'s own
 *    accepted-options list (`beacon/index.ts:DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS`)
 *    refuses `kind` outright rather than accepting and narrowing it — this
 *    type omits the option for the same reason, rather than typing one the
 *    runtime refuses by name whatever value it is given. The old API's
 *    behaviour was narrower still: it refused only a WRONG value; the new
 *    one refuses the option entirely.
 *
 * A third, non-`kind` divergence, added alongside the runtime split into
 * per-operation accepted-options lists: this type was ALREADY narrower than
 * `StandaloneOptions`/`UpgradeOptions` in exactly the way the runtime now
 * mirrors — `deployBeaconProxy` deploys no implementation and validates
 * nothing, so it never carried `constructorArgs`, `initialOwner`, any of the
 * five `unsafeAllow*` validation options, or
 * `redeployImplementation`/`useDeployedImplementation`. The type was correct
 * first; `beacon/index.ts`'s shared `BEACON_ACCEPTED_OPTIONS` (since split)
 * was the one still accepting all nine of those at runtime.
 */
export type DeployBeaconProxyOptions = InitializerOption & DeployOpts;
export type ForceImportOptions = ProxyKindOption;
export type ValidateImplementationOptions = StandaloneValidationOptions;
export type ValidateUpgradeOptions = ValidationOptions;

/**
 * Options after resolution.
 *
 * Every field is **required** — an own key is always present on the frozen
 * result, so "resolution ran" is a type-level fact and no downstream module
 * has to guard a field's mere presence. `validation`, `constructorArgs`,
 * `redeployImplementation`, `timeout` and `pollingInterval` also carry a
 * **defined** value on every input, because each has a resolver-owned
 * default; no field in this group is ever assigned an explicit `undefined`
 * — under this package's `exactOptionalPropertyTypes: true` that would be a
 * compile error anyway (verified by compilation: `const a: ValidationOptions
 * = { kind: undefined }` fails with **TS2375**).
 *
 * `kind`, `initializer`, `call` and `initialOwner` are the recorded
 * exception: each carries `undefined` when the caller supplied nothing,
 * because these are operation-level passthroughs the resolver applies no
 * default to — the operation that consumes them owns the default (or has
 * none), so a resolver-level default here would be a second, possibly
 * diverging opinion. `unsafeSkipProxyAdminCheck` is the exception's own
 * exception: it belongs to that group in kind, but its default (`false`,
 * the safe posture) is unambiguous, so it is always defined. All five are
 * declared required rather than optional to match
 * `proxy/toolkit.ts:ResolvedForProxyOps`, the shape the operations actually
 * read: required-but-possibly-`undefined` states that resolution ran and
 * looked, where `?` would only state that it never looked at all.
 *
 * The hazard this shape removes: a downstream
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
   * **A recorded divergence from the parity target:** its own comment says
   * these are *"not used for Truffle, but include these anyways"*. On TRON
   * confirmation is real, so the value acquires meaning — a wrong value here
   * is a real confirmation-policy change rather than a dead field. Shape and
   * default are mirrored exactly; the confirmation policy itself is the
   * deploy seam's.
   */
  readonly timeout: number;
  /** Milliseconds. See the recorded divergence on {@link timeout}. */
  readonly pollingInterval: number;
  /**
   * The proxy kind the caller supplied, verbatim — `undefined` when omitted.
   * Sourced from the same `readProxyKind` call that feeds
   * `validation.kind`'s input, so the two cannot disagree when the caller
   * sets it; they differ only on the default, because
   * `withValidationDefaults` defaults `validation.kind` to `'transparent'`
   * while this field stays `undefined` when nothing was supplied — one
   * source, surfaced twice, not two parses that could drift apart. Mirrors
   * `proxy/toolkit.ts:ResolvedForProxyOps.kind`, which is where the
   * operations read it.
   */
  readonly kind: 'transparent' | 'uups' | 'beacon' | undefined;
  /**
   * The `initializer` rule's raw input: a function name to call, `false`
   * for no initialization, or `undefined` when the caller left it unset.
   * Deciding what an absent value means for a given argument count is
   * `resolve.ts:resolveInitializer`'s job, not resolution's — this field is
   * that function's own input type, carried through unresolved. Mirrors
   * `proxy/toolkit.ts:ResolvedForProxyOps.initializer`.
   */
  readonly initializer: string | false | undefined;
  /**
   * The `upgradeProxy` dispatch the caller requested: a function name (or
   * raw calldata, still a string), a `{ fn, args }` pair, or `undefined`
   * for none. `args`, when present, is frozen — the same one-level-copy
   * discipline as {@link constructorArgs} and for the same reason: an
   * element is arbitrary caller data and must never be deep-walked.
   * `deployProxy` does not accept the `call` key, so this is `undefined` on
   * every deploy-shaped resolution; only an operation whose accepted list
   * includes `'call'` can ever populate it. Mirrors
   * `proxy/toolkit.ts:ResolvedForProxyOps.call`.
   */
  readonly call:
    | string
    | { readonly fn: string; readonly args?: readonly unknown[] }
    | undefined;
  /**
   * The transparent-proxy admin owner the caller requested, exactly as
   * supplied — `undefined` when omitted. Never canonicalized here:
   * canonicalization is chain-specific and this surface stays chain-agnostic,
   * so `proxy/deploy-proxy.ts` canonicalizes the value itself before use.
   * Mirrors `proxy/toolkit.ts:ResolvedForProxyOps.initialOwner`.
   */
  readonly initialOwner: string | undefined;
  /**
   * Skips the ProxyAdmin-as-owner probe `proxy/deploy-proxy.ts` otherwise
   * runs before spending. Defaults to `false` — the safe posture — so a
   * caller who never set this keeps the check. Mirrors
   * `proxy/toolkit.ts:ResolvedForProxyOps.unsafeSkipProxyAdminCheck`.
   */
  readonly unsafeSkipProxyAdminCheck: boolean;
}

/** The outcome of the `initializer` rule. Never a nullable function name. */
export type InitializerResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'call'; readonly fn: string };
