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
 * passes one of these intersected with {@link MigrationHandles}, which is the
 * shape every operation's third parameter declares.
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
 * the environment → `configureRecordLocation` (inside `openRecord`) → dynamic
 * import of the engine-reaching modules → run. Their static closures are
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
// The one record-layer error a consumer must be able to catch: `openRecord` throws
// it directly, on a fingerprint sidecar it cannot use. The rest of the record
// layer's errors are internal to `./record`, whose own face exports this class as a
// type only — deliberately, so a consumer distinguishes by `code` rather than by
// importing constructors. This export is the one exception, made here rather than
// there, because catching it is how a caller tells "corrupt" from "the chain
// instance changed", the only other refusal `openRecord` itself raises.
export { RecordFingerprintUnreadableError } from './record/errors';

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
  // Reachable from EVERY operation, not only the readers: opening the
  // deployment record compares the recorded chain instance against the live
  // one (`src/record/session.ts`), and this is the refusal when they differ.
  // Its fingerprint sibling above was already exported, and the two are the
  // pair a caller distinguishes — "the record file is unusable" from "this is
  // a different chain than the one the record was written against" — so
  // exporting one and not the other made the omission look deliberate.
  ChainInstanceChangedError,
} from './chain';

/*
 * The option-refusal family, thrown by the resolver every operation runs
 * before it touches anything: an unaccepted key, a value of the wrong shape,
 * two options that contradict each other, or an option TRON has no equivalent
 * of. `UpgradesOptionError` is the base all four extend and is exported for
 * the one thing the subclasses cannot express — catching the family in a
 * single `instanceof`.
 *
 * Imported from the leaf, never from `./options`, whose face re-exports
 * `./options/resolve` and would load the engine at import time — the rule
 * this module's header states and `test/entry-point-closure.test.ts` enforces.
 * Every class below also carries a `code`, which stays the documented way to
 * branch without importing a constructor.
 */
export {
  OptionConflictError,
  OptionUnsupportedOnTronError,
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
 * The environment refusals: no TronBox context at all, one missing a handle
 * the operation needs, or handles that disagree with each other. Reachable
 * from every operation, since each resolves the environment before doing
 * anything, and the most likely error a programmatic (non-`tronbox migrate`)
 * caller meets first. The abstract base is exported for the same reason
 * `UpgradesOptionError` is.
 */
export {
  EnvironmentAbsentError,
  EnvironmentIncompleteError,
  EnvironmentInconsistentError,
  TronBoxEnvironmentError,
} from './environment';
