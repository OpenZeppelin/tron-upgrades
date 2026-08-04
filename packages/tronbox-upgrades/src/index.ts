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
  DeployProxyOptions,
  InitializerOption,
  ProxyKind,
  RedeployMode,
  StandaloneOptions,
  UnsafeAllowKind,
  UpgradeOptions,
  UpgradeProxyOptions,
} from './options/types';

export type {
  AdoptionOutcome,
  AuthorityTransfer,
  ContractHandle,
  DeployedBeacon,
  DeployedProxy,
  ImplementationDeployment,
  OperationResult,
  TransactionIdentity,
  UpgradedProxy,
  ValidationOutcome,
} from './results/types';

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
  NotTransparentProxyError,
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
