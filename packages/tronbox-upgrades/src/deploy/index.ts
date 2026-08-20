/**
 * The deployment seam's package-internal face. The operation sub-features
 * (proxy lifecycle, beacons, admin transfer) compose these; nothing here is the
 * package's public API — the entry module owns that.
 */

export type {
  ConfirmationBounds,
  ConfirmationIndeterminate,
  ConfirmationVerdict,
  ConfirmedReverted,
  ConfirmedSuccessful,
  EffectiveSender,
  QueueHost,
  WriteBack,
} from './types';
export {
  CheatcodeSlotCollisionError,
  ConfirmationIndeterminateError,
  DeployerAbsentError,
  DeploymentRefusedError,
  DeploySeamInvariantError,
  LinkedImplementationRefusedError,
  LinkVerificationFailedError,
  NestedOperationError,
  SenderMismatchError,
  StaleTransactionIdentityError,
  TransactionRevertedError,
} from './errors';
export type { SpentDeployment } from './errors';
export {
  assertFreshTransaction,
  assertNoCheatcodeCollision,
  runThroughQueue,
} from './queue';
export {
  confirmTransaction,
  HOST_CONFIRMATION_BOUNDS,
  type BoundWait,
} from './confirm';
export {
  assertSignerMatches,
  resolveEffectiveSender,
  type ConfiguredSenderSlot,
} from './sender';
export {
  assertFullyLinked,
  linkedLibraryNames,
  refuseUnlessLinkingAllowed,
} from './link';
export { serializeOperation } from './serialize';
