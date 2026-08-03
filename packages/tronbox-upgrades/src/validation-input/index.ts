/**
 * SF-2's face: one function, its types, the declared compiler range, and the
 * three error classes.
 *
 * **One function and no second entry point** (INV-51). `policy`, `diagnose`,
 * `sourceKey`, `detectFidelity`, `buildSolcInput`, `resolveSourceGraph`,
 * `cutPartition` and `openCompiler` are deliberately **not** here. If they were, a
 * consumer could assemble a validation input from the parts plus its own compile
 * and bypass the policy point entirely — and INV-9's call-site scan would still
 * pass, because that second pipeline would never call `policy` at all. They stay
 * reachable by direct module import, which is how the tests see them.
 *
 * SF-11 owns the package entry point; this is the directory's face to its
 * siblings.
 */

export { deriveValidationInput } from './pipeline';

/** D2, declared once in `compiler.ts` and read by both the gate and the message. */
export { SUPPORTED_SOLC } from './compiler';

/**
 * The refusal's one rendering (INV-20) plus the two invariant classes.
 *
 * `ValidationInputRefusedError`'s constructor takes no `string`, so a consumer
 * cannot word its own refusal sentence — eleven causes cannot drift into
 * thirty-three messages across SF-5, SF-6 and SF-7. The other two are on the face
 * because INV-1 makes them the only two things `deriveValidationInput` throws, and
 * a consumer that wants to tell a plugin bug from a user condition needs to be
 * able to name them.
 */
export {
  CompilerRetiredError,
  ValidationInputInvariantError,
  ValidationInputRefusedError,
} from './errors';

export type { Cause, WasmAbort } from './causes';
export type { CompilerHandle, CompilerIdentity } from './compiler';
export type { Diagnosis } from './diagnose';
export type { ArtifactIdentityComparison } from './identity';
export type { LayoutFidelity } from './layout-fidelity';
export type { PartitionRecord } from './partition';
export type {
  InputProvenance,
  ValidationInput,
  ValidationInputDependencies,
  ValidationInputEnvironment,
  ValidationInputOutcome,
  ValidationInputRequest,
} from './pipeline';
export type { SolcStandardInput, SolcStandardOutput } from './solc-input';
