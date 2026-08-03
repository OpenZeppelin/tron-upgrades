/**
 * The environment seam's internal public face.
 *
 * INV-28: only `src/environment/**` may read a TronBox-internal property path.
 * Every other module in the package receives the normalized composite or
 * nothing. INV-47: this directory imports no other sub-feature's module, so the
 * dependency direction is one-way.
 *
 * SF-11 owns the package entry point; this is the seam's face to its siblings.
 */
export {
  ArtifactNameAmbiguousError,
  EnvironmentAbsentError,
  EnvironmentIncompleteError,
  EnvironmentInconsistentError,
  TronBoxEnvironmentError,
  getDeclaredTronBoxRange,
  // On the face because INV-14 makes it the *only* way to mint an
  // `UnsatisfiedSlot`, so a sibling reusing this family — rather than starting a
  // second error path INV-40's guarantee would have to hold in twice — has no
  // other route. Not a precedent for widening: the seam's other internals stay
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

/**
 * On the face for the same reason as `HOST_DEFAULT_SOLC_VERSION`: `~/.tronbox/{solc,
 * evm-solc}/soljson_v<version>.js` is a host-internal convention, so a consumer that
 * rebuilt it would hold a second copy of a fact the seam already restates. A pure
 * function of its two arguments rather than a member of the compiler slot — the seam
 * cannot read `homedir()` (INV-43 / INV-44 / INV-47), so the caller supplies it.
 */
export {
  soljsonPathFor,
  type SoljsonPathInput,
  type SoljsonPathResolution,
} from './soljson-path';

export {
  resolveEnvironment,
  type EnvironmentDependencies,
} from './resolve';

export { REDACTED_HOST_HANDLE } from './handles';

/** INV-14 / INV-47: the invocation-context matrix as data, so tests and error
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
