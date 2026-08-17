/**
 * The environment seam's internal public face.
 *
 * Only `src/environment/**` may read a TronBox-internal property path.
 * Every other module in the package receives the normalized composite or
 * nothing. This directory imports no other sub-feature's module, so the
 * dependency direction is one-way.
 *
 * Packaging owns the package entry point; this is the seam's face to its
 * siblings.
 */
export {
  ArtifactNameAmbiguousError,
  EnvironmentAbsentError,
  EnvironmentIncompleteError,
  EnvironmentInconsistentError,
  TronBoxEnvironmentError,
  getDeclaredTronBoxRange,
  // On the face because this is the *only* way to mint an
  // `UnsatisfiedSlot`, so a sibling reusing this family — rather than starting a
  // second error path the no-credential-leak guarantee would have to hold in
  // twice — has no other route. Not a precedent for widening: the seam's
  // other internals stay
  // internal and are reached by module import.
  unsatisfiedSlot,
} from './errors';

export {
  buildArtifactAmbiguityIndex,
  fileSystemBuildInfoReader,
  normalizeArtifactName,
  type ArtifactAmbiguityIndex,
  type BuildInfoFile,
  type BuildInfoReader,
  type BuildInfoReadResult,
} from './ambiguity';

export {
  compilerConfigLineageFields,
  configLineageFields,
  networkConfigLineageFields,
  pathConfigLineageFields,
} from './config-lineage';

/** On the face so a consumer never restates TronBox's default compiler version. */
export { HOST_DEFAULT_SOLC_VERSION } from './compiler';

export {
  resolveEnvironment,
  type EnvironmentDependencies,
} from './resolve';

export { REDACTED_HOST_HANDLE } from './handles';

/** The invocation-context matrix as data, so tests and error
 * messages read the matrix rather than restating it. */
export {
  slotNames,
  slotRequirements,
  type SlotRequirement,
} from './slots';

export type {
  AbsolutePath,
  ArtifactAccess,
  ArtifactAmbiguityReport,
  ArtifactCandidate,
  ArtifactNameCollision,
  ArtifactRecord,
  ArtifactRecordField,
  ArtifactRecordReport,
  ArtifactResolution,
  ChainHandleSlot,
  CompilerConfiguration,
  CompilerSettingsSource,
  ConfigLineageBinding,
  ConfigLineageProvenance,
  ConfigScalarField,
  ContractAbstraction,
  DeployerHandle,
  EnvironmentDiagnosis,
  EnvironmentProvenance,
  HandleName,
  Inconsistency,
  IndeterminateReason,
  InvocationContextName,
  NetworkEnvironment,
  NetworkTxDefaults,
  NonAuthoritativeSender,
  OutputChannelSlot,
  ProjectPaths,
  RawMigrationHandles,
  ReceiptSlot,
  ResolverInterceptHandle,
  SchedulingSlot,
  SlotName,
  SlotShapes,
  TronBoxEnvironment,
  TronBoxLogger,
  TronWrapHandle,
  UnsatisfiedSlot,
  WaitForTransactionReceipt,
} from './types';
