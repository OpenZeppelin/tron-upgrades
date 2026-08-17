/**
 * The shared result-type contract for every operation, plus the host-object
 * augmentation policy the whole package works under.
 *
 * This directory imports only `../output`, and only for `DegradedNote`.
 *
 * Packaging owns the package entry point; this is the directory's face to its
 * siblings.
 */
export {
  HostInstanceSharedError,
  hostSharingGuard,
  installGuarded,
  type HostSharingGuard,
} from './augmentation';

export {
  ResultCapabilityUnavailableError,
  UnavailableMemberAbsentError,
  sealUnavailable,
  unavailableContractMembers,
  type Limitation,
  type LimitationRegistry,
} from './limitations';

export {
  TransactionHashUnavailableError,
  operationNotes,
  transactionIdentity,
  type AdoptionOutcome,
  type AuthorityTransfer,
  type ContractHandle,
  type DeployedBeacon,
  type DeployedProxy,
  type ImplementationDeployment,
  type OperationResult,
  type TransactionIdentity,
  type UpgradedProxy,
  type ValidationOutcome,
} from './types';
