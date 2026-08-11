/**
 * Reading a `ValidationInputOutcome`: the success shape with its `fidelity` and
 * its provenance, and the refusal with one of the seven enumerated causes.
 *
 * The outcome is a two-member closed union, and both members are total. A refusal
 * is a value rather than a throw because the pipeline has to be *able* to carry a
 * reduced-fidelity proceed, and a thrown refusal cannot become one — catching it
 * cannot manufacture the layouts a lenient path would need to return.
 *
 * The only thing `deriveValidationInput` throws is
 * `ValidationInputInvariantError` (plus the environment seam's own
 * `ArtifactNameAmbiguousError`, for an operation that skipped its ambiguity
 * decision), and both denote plugin bugs rather than user conditions. Everything
 * a project can do wrong arrives here as a `Cause`.
 */
import {
  type Cause,
  type Diagnosis,
  type LayoutFidelity,
  type ValidationInput,
  type ValidationInputEnvironment,
  type ValidationInputOutcome,
} from '../../../src/validation-input';
import type { DegradedNote, OutputChannel } from '../../../src/output';

// ---------------------------------------------------------------------------
// 1. The outcome, narrowed
// ---------------------------------------------------------------------------

/** Both members handled, and no third branch to write. */
export function summarize(outcome: ValidationInputOutcome): string {
  if (outcome.kind === 'refused') {
    // Both fields are required and both are non-empty: a diagnosis that says
    // something failed without saying what to do defeats its own purpose.
    return `refused (${outcome.cause.kind}): ${outcome.diagnosis.headline}`;
  }
  return `input at ${outcome.input.fidelity.kind} fidelity`;
}

// ---------------------------------------------------------------------------
// 2. The success shape: fidelity
// ---------------------------------------------------------------------------

/**
 * `fidelity` is never optional, and its value is a function of the step that
 * produced the input rather than a guess about it.
 *
 * The one producing step — the build-record read — reports
 * `declaration-order-only` with a **non-empty** `missingFor`, and the pipeline
 * asserts exactly that on its way out, which is why a consumer may read it as
 * fact. The `slot-level` arm is not producible today: no supported TronBox
 * requests `storageLayout`, so no build record carries positions. It stays in
 * the union because the detector scans every output's real positions rather
 * than assuming — the day the host emits layouts into its records, this switch
 * is already total over the change.
 *
 * Read it to branch, never to build a user-facing sentence — the sentences are
 * already written, as degraded notes on the channel (§ 5).
 */
export function positionsAvailable(fidelity: LayoutFidelity): boolean {
  switch (fidelity.kind) {
    case 'slot-level':
      return true;
    case 'declaration-order-only':
      // Fully-qualified names whose layout carries no positions. Never empty.
      return fidelity.missingFor.length === 0;
  }
}

// ---------------------------------------------------------------------------
// 3. The success shape: provenance
// ---------------------------------------------------------------------------

/**
 * `provenance.basis` is a single-member union — the Foundry model has exactly
 * one producing step — and its discriminant is kept so a future second basis
 * (TronBox emitting `storageLayout` into its records, say) is an added member
 * rather than a reshaping. `InputBasis`, `BuildRecordGate` and
 * `BuildRecordRejection` are all exported from the face, so naming them in your
 * own signatures needs no deep import.
 *
 * It exists to be **reported**, not to be gated on: with one member there is
 * nothing to branch on, and an operation that starts branching on a future
 * second member is an operation whose behaviour depends on which TronBox
 * version wrote the build record.
 *
 * No compiler is located, loaded or read on the way to a produced input.
 * `compilerLongVersion` is the artifact's own long version, trustworthy because
 * the record that verified against the artifact by deployed bytecode was
 * produced by that compiler — by content rather than by claim.
 */
export function provenanceLines(input: ValidationInput): readonly string[] {
  const { basis, partition, sourceKeys } = input.provenance;
  return [
    `target source key:  ${partition.target}`,
    `closure:            ${partition.closure.length} sources`,
    `input order:        ${sourceKeys.length} keys`,
    `solc (long):        ${input.solcVersion}`,
    `output from:        build record ${basis.gate.file}`,
    `candidates read:    ${basis.gate.candidates}`,
    `solc input from:    ${basis.inputFile} (verbatim)`,
    `compiler:           ${basis.compilerLongVersion}, not loaded`,
  ];
}

// ---------------------------------------------------------------------------
// 4. The refusal: seven causes, closed
// ---------------------------------------------------------------------------

/**
 * Who can act on the refusal. The exhaustive switch is the point of the example,
 * not the categories.
 *
 * The union is closed, and closed is the property that matters: it is what makes
 * one `could not validate` covering seven situations unrepresentable, and what
 * makes the `never` assignment below a compile error the day an eighth obligation
 * arrives without a diagnosis and a remedy.
 *
 * Reach for `cause.kind` only where a category genuinely changes what your
 * operation does. If all seven end the same way for you, the diagnosis is already
 * rendered and there is nothing to switch on.
 */
export type Actor = 'the project' | 'the TronBox version' | 'the build tree';

export function whoCanAct(cause: Cause): Actor {
  switch (cause.kind) {
    // 1 — the project's compiler version is outside the verified range. No
    // compiler is ever loaded; the gate is on the version because the range
    // gates which solc *output* this plugin interprets, and an older compiler
    // accepts a `storageLayout` request with zero diagnostics of any severity
    // and simply omits the key.
    case 'compiler-unsupported':
      return 'the project';

    // 2, 3 — a source in the closure cannot be read, or an import cannot be
    // resolved to a source of this project. Both are decided before the build
    // record is consulted, so the message names the file to edit — and
    // `tronbox compile --all` cannot fix a reference the compiler itself would
    // refuse.
    case 'source-unreadable':
    case 'import-unresolvable':
      return 'the project';

    // 4 — the artifact lacks a field this module requires. `missingField` is a
    // closed union of the host's own artifact keys, so a field can be absent only
    // because the host version predates it.
    case 'artifact-shape-unsupported':
      return 'the TronBox version';

    // 5, 6 — the pair that makes distinct remedies earn their keep. Both are
    // fixed by running `tronbox compile --all` — the `--all` flag forces
    // recompilation of unchanged sources, so the remedy always works — and the
    // remedy is what says which situation you are in: no record was ever
    // written for this contract, or every record found (named per file, with
    // its rejection reason) no longer describes the compiled artifact.
    case 'build-record-absent':
    case 'build-record-stale':
      return 'the build tree';

    // 7 — a linked library's name is past the length the host can encode, which
    // corrupts the artifact's own bytecode. The message names the library and the
    // band because upstream's `Bytecode is not a valid hex string` names neither.
    case 'library-name-unsupported':
      return 'the project';

    default: {
      // An eighth member fails here at compile time rather than at runtime, which
      // is the difference between a member being *added* and a member being
      // *reached*.
      const unhandled: never = cause;
      return unhandled;
    }
  }
}

/**
 * The refusal, rendered — by reading the rendering, not by writing one.
 *
 * `headline` names the concrete failing thing its own cause carries and no
 * headline covers two causes; `remedy` is an imperative and is distinct across all
 * seven. If one reads wrongly for your operation, fix it where every consumer
 * gets the fix — a paraphrase here is how seven causes become twenty-one
 * sentences across three consuming operations.
 */
export function renderRefusal(cause: Cause, diagnosis: Diagnosis): string {
  return `${cause.kind}\n${diagnosis.headline}\n${diagnosis.remedy}`;
}

// ---------------------------------------------------------------------------
// 5. What was stated, as opposed to what was returned
// ---------------------------------------------------------------------------

/**
 * The channel you passed in is where every degraded statement was recorded. Put
 * `channel.recorded` on the operation's result; do not re-derive the statements
 * from `fidelity`.
 *
 * **The record is the guarantee and the log write is a courtesy.** TronBox
 * replaces the log channel with a no-op under `--quiet` and `--silent`, and passes
 * a no-op throughout `tronbox test` — the command that replays every migration on
 * every run. An obligation discharged through a log line would be silent for every
 * test run.
 *
 * Two codes come from this module, and every produced input records the first.
 * `storage-layout-unavailable` says the flat layout was reconstructed from the
 * build record's AST, so it carries declaration order and not positions.
 * `namespaced-ast-only` says this contract declares namespaced storage, whose
 * members carry no positions — recorded wherever a namespace is found, because
 * upstream's own slot-absence branch reads only the flat storage list and for a
 * purely namespaced contract that list is empty.
 */
export function notesFor(channel: OutputChannel): readonly DegradedNote[] {
  return channel.recorded;
}

/**
 * The environment takes a narrowed view of the same channel.
 *
 * `env.output` is `note` and `degraded` only, because those are the two
 * capabilities this module uses — and `recorded` stays with the operation, which is
 * what puts the notes on the operation's own result. Minting a second channel here
 * would be a channel whose records reach no result: the note written and then lost.
 */
export function withChannel(
  env: ValidationInputEnvironment,
  channel: OutputChannel,
): ValidationInputEnvironment {
  return { ...env, output: channel };
}
