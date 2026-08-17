/**
 * @openzeppelin/tronbox-upgrades
 *
 * Upgrades plugin for TronBox: deploy and upgrade proxies on TRON with
 * upgrade-safety validations backed by `@openzeppelin/upgrades-core`.
 *
 * ## The one rule this module enforces on itself
 *
 * **Nothing here may load the validation engine at import time.** The engine's
 * record layer reads its location from the environment once, at module scope —
 * setting it afterwards is a silent no-op — so the location must be configured
 * (`configureRecordLocation`, from the record layer's face) from a resolved
 * environment *before* any engine-reaching module executes. An operation does
 * that at call time and then imports the engine-reaching modules dynamically,
 * exactly as the record layer itself already does.
 *
 * Concretely: `./options/resolve` and `./output/engine` hold **value** imports
 * of `@openzeppelin/upgrades-core`, so re-exporting either from here would
 * load the engine the moment a user's migration `require`s the plugin —
 * before any operation ran, with the record location silently wrong for every
 * subsequent write. `test/entry-point-closure.test.ts` makes this rule
 * structural: the entry module's static value-closure must never reach the
 * engine.
 *
 * Type-only exports are erased at compile time and are therefore exempt —
 * which is why the public type surface can live here now, ahead of the
 * operations that will join it.
 */

/*
 * The option surface. Each operation's alias describes exactly the keys that
 * operation accepts — no more, checked against its runtime accepted-options
 * list in both directions by `test/public-option-surface.test.ts`. A call
 * passes one of these intersected with {@link MigrationHandles}: that
 * intersection is what every operation's FINAL parameter declares — the
 * position differs per operation, which is why the type test keys off the last
 * parameter rather than a fixed index.
 *
 * One limit worth stating, because it is TypeScript's and not this package's:
 * an unaccepted key is a compile error for a fresh object literal at the call
 * site (excess-property checking). Assign the options to a variable first and
 * the extra key becomes structurally invisible — the runtime refusal is what
 * catches it then. `satisfies DeployProxyOptions & MigrationHandles` on that
 * variable restores the compile-time check.
 */
export type {
  CallOption,
  DeployBeaconOptions,
  DeployBeaconProxyOptions,
  DeployImplementationOptions,
  DeployProxyOptions,
  ForceImportOptions,
  InitialOwnerOption,
  InitializerOption,
  PrepareUpgradeOptions,
  ProxyAdminCheckOption,
  ProxyKind,
  RedeployMode,
  StandaloneOptions,
  TransferProxyAdminOwnershipOptions,
  UnsafeAllowKind,
  UpgradeBeaconOptions,
  UpgradeOptions,
  UpgradeProxyOptions,
  ValidateImplementationOptions,
  ValidateUpgradeOptions,
} from './options/types';

/** The migration handles half of every operation's option parameter. */
export type { MigrationHandles } from './proxy';

export type {
  AdoptionOutcome,
  AlreadyHeldAuthorityTransfer,
  AuthorityTransfer,
  ContractHandle,
  ExecutedAuthorityTransfer,
  DeployedBeacon,
  DeployedProxy,
  ImplementationDeployment,
  OperationResult,
  TransactionIdentity,
  UpgradedProxy,
  ValidationOutcome,
} from './results/types';

/*
 * `silenceWarnings` is exported directly from its own leaf, never from the
 * `./output` face: the face's `./output/engine` and `./output/channel` leaves
 * are reached only per-operation today, and re-exporting the face here would
 * make them load-bearing at import time instead. `./output/silence` carries
 * no import of its own — nothing to defer — so this one path is safe to
 * re-export exactly as written, and `test/entry-point-closure.test.ts`'s
 * closure walk proves it: this specifier adds no engine-reaching module to
 * the entry's static value-closure.
 */
export { silenceWarnings } from './output/silence';

/*
 * The operations. Each is shaped exactly as the rule above requires: resolve
 * the environment → `configureRecordLocation` (called by the toolkit factory
 * itself, so it runs in both modes; `openRecord` calls it again on the
 * state-changing path) → dynamic import of the engine-reaching modules → run. Their static closures are
 * engine-free, and `test/entry-point-closure.test.ts` recomputes that from
 * disk on every run.
 */
export { deployProxy, upgradeProxy } from './proxy';
export {
  validateImplementation,
  validateUpgrade,
  deployImplementation,
  prepareUpgrade,
} from './standalone';
export { forceImport } from './adopt';
export { transferProxyAdminOwnership } from './admin';
export { deployBeacon, deployBeaconProxy, upgradeBeacon } from './beacon';
export {
  AuthorityAlreadyTransferredError,
  AuthorityVerificationFailedError,
} from './admin/errors';
export {
  AdoptionKindMismatchError,
  AdoptionVerificationFailedError,
  NothingToAdoptError,
} from './adopt/errors';
export {
  BeaconInitialOwnerRequiredError,
  BeaconProxyRefusedError,
  EmptyInitializerRefusedError,
  ImplementationNotPreviouslyDeployedError,
  InitialOwnerUnsupportedKindError,
  NotTransparentProxyError,
  OptionsInArgsPositionError,
  ProxyAdminAsOwnerError,
  ProxyArtifactCollisionError,
  ProxyArtifactMissingError,
  ProxyOperationRefusedError,
  StaleProxyRecordError,
  TransparentInitialOwnerRequiredError,
  UnknownProxyGenerationError,
  UpgradeVerificationFailedError,
} from './proxy';
export {
  DeploymentRefusedError,
  DeployerAbsentError,
  TransactionRevertedError,
  ConfirmationIndeterminateError,
  SenderMismatchError,
  LinkedImplementationRefusedError,
  LinkVerificationFailedError,
  StaleTransactionIdentityError,
  CheatcodeSlotCollisionError,
} from './deploy';
// The one record-layer error a consumer must be able to catch by class:
// `openRecord` throws it directly, on a fingerprint sidecar it cannot use, and
// catching it is how a caller tells "corrupt" from "the chain instance
// changed" (its counterpart below). The rest of the record layer's errors are
// internal to `./record`, whose own face exports this class as a type only —
// deliberately, so a consumer distinguishes by `code` rather than by importing
// constructors. `openRecord`'s contract documents more refusals than these
// two; the others carry a `code`, which is the documented way to branch on
// them (see the surface rule below).
export { RecordFingerprintUnreadableError } from './record/errors';

/*
 * THE ERROR-SURFACE RULE (review r3788402299). An exported class is a
 * commitment — it can never be renamed once published — so the classes below
 * are only the refusals a CALLER can cause and fix from the call site:
 * API-misuse (a bad option, a missing owner, a wrong kind) plus the two
 * chain-state refusals a caller must branch on to recover
 * (`RecordFingerprintUnreadableError` above, `ChainInstanceChangedError`
 * below), and the two family bases that make a one-`instanceof` catch
 * possible. Many of the remaining errors — transport failures, malformed
 * environments beyond the family base, result-building refusals — carry a
 * stable `code` string, and branching on `code` is the documented path for
 * those; the rest, the engine's own verdicts among them, carry only their
 * message. For a migration tool, most errors reach a human reading
 * `tronbox migrate` output rather than a `catch`; the message, not the class,
 * is the primary surface.
 */

/**
 * The public 1967-slot readers — cheap, engine-free, and mirroring Hardhat's
 * own `erc1967`/`beacon` namespaces. See `./erc1967`'s own header for why
 * re-exporting it here reaches no engine module.
 */
export { erc1967, beacon, type Erc1967ReadOptions } from './erc1967';
// The two refusals the readers above can throw directly (`getAdminAddress`
// never throws for an empty slot; the other two do). Real classes, for the
// same reason `RecordFingerprintUnreadableError` is one: a consumer needs
// them to write a `catch`, not merely a `code` to switch on.
export {
  ChainBeaconNotFoundError,
  ChainImplementationNotFoundError,
  // Reachable from every STATE-CHANGING operation, not only the readers:
  // opening the deployment record compares the recorded chain instance against
  // the live one (`src/record/session.ts`), and this is the refusal when they
  // differ. The two validation-only operations never reach it — they open no
  // record (`proxy/toolkit.ts`, `mode: 'validate-only'`). Its fingerprint
  // sibling above was already exported, and the two are the pair a caller
  // distinguishes — "the record file is unusable" from "this is a different
  // chain than the one the record was written against". The chain layer's
  // OTHER refusals (transport, RPC, endpoint, address shape) stay unexported
  // under the surface rule above: a caller does not fix a node from a `catch`
  // — branch on their `code` where automation needs to.
  ChainInstanceChangedError,
} from './chain';

/*
 * The option-refusal family, thrown by the resolver every operation runs: an
 * unaccepted key, a value of the wrong shape, two options that contradict each
 * other, or an option TRON has no equivalent of. Not the first thing an
 * operation does — the environment resolves, and a state-changing operation
 * opens its chain access and record session, before the resolver sees the
 * options at all (`proxy/toolkit.ts`) — so a call with a bad option can still
 * fail on the environment first. `UpgradesOptionError` is the base the whole
 * family extends and is exported for the one thing the subclasses cannot
 * express — catching the family in a single `instanceof`. One subclass,
 * `OptionUnsupportedOnTronError`, stays unexported under the surface rule
 * above — the family base catches it, and its `code` names it.
 *
 * Imported from the leaf, never from `./options`, whose face re-exports
 * `./options/resolve` and would load the engine at import time — the rule
 * this module's header states and `test/entry-point-closure.test.ts` enforces.
 * Each of the four subclasses also carries a `code`, which stays the
 * documented way to branch without importing a constructor; the base does not
 * — it is the family, and `instanceof` is the only thing it answers.
 */
export {
  OptionConflictError,
  OptionValueError,
  UnknownOptionError,
  UpgradesOptionError,
} from './options/errors';

/*
 * The refusal a caller sees when the build record cannot answer the question
 * validation asks — a missing artifact, a stale one, a record with no usable
 * layout. Every validating operation can raise it directly. Its invariant
 * sibling in the same module stays unexported on purpose: an invariant
 * breach is this plugin's bug, not a state a caller catches and handles.
 */
export { ValidationInputRefusedError } from './validation-input/errors';

/*
 * The result-side errors are deliberately NOT exported — including
 * `ResultCapabilityUnavailableError`, whose disposition the release issue
 * left open and which is hereby decided: unexported. Exporting later is
 * additive and safe; unexporting later is breaking, so the smaller surface is
 * the reversible choice. All of them carry a `code` to branch on.
 */

/*
 * The environment family's base: the most likely error a programmatic
 * (non-`tronbox migrate`) caller meets first, since every operation resolves
 * the environment before doing anything. Exported for the same reason
 * `UpgradesOptionError` is — one `instanceof` catches the family — while the
 * shape-specific subclasses stay unexported under the surface rule above and
 * branch by `code`.
 */
export { TronBoxEnvironmentError } from './environment';
