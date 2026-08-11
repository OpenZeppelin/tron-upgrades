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

export type {
  CallOption,
  DeployBeaconOptions,
  DeployBeaconProxyOptions,
  DeployImplementationOptions,
  DeployProxyOptions,
  ForceImportOptions,
  InitializerOption,
  PrepareUpgradeOptions,
  ProxyKind,
  RedeployMode,
  StandaloneOptions,
  UnsafeAllowKind,
  UpgradeBeaconOptions,
  UpgradeOptions,
  UpgradeProxyOptions,
  ValidateImplementationOptions,
  ValidateUpgradeOptions,
} from './options/types';

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
  BeaconProxyRefusedError,
  EmptyInitializerRefusedError,
  InitialOwnerUnsupportedKindError,
  NotTransparentProxyError,
  OptionsInArgsPositionError,
  ProxyAdminAsOwnerError,
  ProxyArtifactCollisionError,
  ProxyArtifactMissingError,
  ProxyOperationRefusedError,
  StaleProxyRecordError,
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
} from './chain';
