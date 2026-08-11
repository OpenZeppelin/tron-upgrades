/**
 * The validation pipeline's face: one function, its types, the declared
 * compiler range, and the two error classes.
 *
 * **One function and no second entry point.** `policy`, `diagnose`,
 * `sourceKey`, `detectFidelity`, `resolveSourceGraph` and
 * `cutPartition` are deliberately **not** here. If they were, a
 * consumer could assemble a validation input from the parts and bypass the
 * policy point entirely — and the call-site scan for `policy`
 * usage would still pass, because that second pipeline would never call
 * `policy` at all. They stay reachable by direct module import, which is how
 * the tests see them.
 *
 * Packaging owns the package entry point; this is the directory's face to its
 * siblings.
 */

export { deriveValidationInput } from './pipeline';

/** The declared range, defined once in `compiler.ts` and read by both the gate and the message. */
export { SUPPORTED_SOLC } from './compiler';

/**
 * The refusal's one rendering plus the invariant class.
 *
 * `ValidationInputRefusedError`'s constructor takes no `string`, so a consumer
 * cannot word its own refusal sentence — seven causes cannot drift into
 * twenty-one messages across the proxy operations, the standalone operations
 * and adoption (forceImport). `ValidationInputInvariantError` is on the face
 * because it is the one thing `deriveValidationInput` throws, and a consumer
 * that wants to tell a plugin bug from a user condition needs to be able to
 * name it.
 */
export {
  ValidationInputInvariantError,
  ValidationInputRefusedError,
} from './errors';

export type { BuildRecordRejection, Cause } from './causes';
export type { Diagnosis } from './diagnose';
export type { LayoutFidelity } from './layout-fidelity';
export type { PartitionRecord } from './partition';
export type {
  BuildRecordGate,
  InputBasis,
  InputProvenance,
  ValidationInput,
  ValidationInputDependencies,
  ValidationInputEnvironment,
  ValidationInputOutcome,
  ValidationInputRequest,
} from './pipeline';
export type { SolcStandardInput, SolcStandardOutput } from './solc-input';
