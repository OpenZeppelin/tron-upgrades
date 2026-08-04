/**
 * Reading a `ValidationInputOutcome`: the success shape with its `fidelity` and
 * its provenance, and the refusal with one of the eleven enumerated causes.
 *
 * The outcome is a two-member closed union, and both members are total. A refusal
 * is a value rather than a throw because the pipeline has to be *able* to carry a
 * reduced-fidelity proceed, and a thrown refusal cannot become one — catching it
 * cannot manufacture the layouts a lenient path would need to return.
 *
 * The only two things `deriveValidationInput` throws are
 * `ValidationInputInvariantError` and `CompilerRetiredError`, and both denote
 * plugin bugs rather than user conditions. Everything a project can do wrong
 * arrives here as a `Cause`.
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

/**
 * The two basis arms, and the compile reason, projected off `ValidationInput`.
 *
 * The face exports `InputProvenance` and the input type but not the arms by name,
 * so these are derived rather than deep-imported: a consumer that reached into
 * `src/validation-input/pipeline` to name them would be importing past the
 * directory's face for a type it can already compute.
 */
type PluginCompileBasis = Extract<
  ValidationInput['provenance']['basis'],
  { kind: 'plugin-compile' }
>;
type CompileReason = PluginCompileBasis['reason'];

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
 * The fresh path reports `declaration-order-only` with a **non-empty**
 * `missingFor`; the three compiling paths report `slot-level`. The pipeline
 * asserts that biconditional on its way out, which is why a consumer may read it
 * as fact: an unconditional `slot-level` claim is a permissive mislabel, and a
 * `declaration-order-only` claim about a compiled input would understate what was
 * measured and refuse shapes it could have decided.
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
 * `provenance.basis` is a closed union rather than a set of optional fields, so
 * *"which compiler ran"* and *"which record verified"* can be neither both absent
 * nor both present.
 *
 * It exists to be **reported**, not to be gated on. There is no supported way to
 * request or forbid a compile, and an operation that behaves differently depending
 * on which path ran is an operation whose behaviour depends on whether the user
 * recently ran `tronbox compile`. The one legitimate read is the escalation guard
 * in [`04-escalate-once.ts`](./04-escalate-once.ts), which asks *"is there
 * anything to escalate to"* rather than *"did we compile"*.
 */
export function provenanceLines(input: ValidationInput): readonly string[] {
  const { basis, partition, sourceKeys } = input.provenance;
  const lines = [
    `input reconstructed from: ${input.provenance.reconstructedFrom}`,
    `target source key:        ${partition.target}`,
    `closure:                  ${partition.closure.length} sources`,
    `input order:              ${sourceKeys.length} keys`,
    `solc (long):              ${input.solcVersion}`,
  ];

  if (basis.kind === 'build-record-ast') {
    lines.push(
      `output from:              build record ${basis.gate.file}`,
      `candidates read:          ${basis.gate.candidates}`,
      `compiler:                 ${basis.compilerLongVersion}, not loaded`,
    );
    return lines;
  }

  lines.push(
    `output from:              this plugin's own compile`,
    `because:                  ${describeReason(basis.reason)}`,
    `compiler:                 ${basis.compiler.longVersion}`,
    `                          (${basis.compiler.family}, requested ` +
      `${basis.compiler.requestedVersion})`,
    `soljson:                  ${basis.compiler.soljsonPath}`,
    ...gateLines(basis.gate),
  );

  // Present *iff* the two hashes disagree: the code is identical and the metadata
  // is not. Worth reporting, and specifically not worth refusing over — the
  // stale-artifact cause fires on the trimmed comparison, not this one.
  if (basis.identity.metadataOnlyDifference === true) {
    lines.push(
      `identity:                 code identical, metadata differs`,
    );
  } else {
    lines.push(
      `identity:                 trimmed ${basis.identity.withoutMetadataMatches}` +
        `, full ${basis.identity.withMetadataMatches}`,
    );
  }
  return lines;
}

/** The three reasons a compile happened, each a different situation. */
function describeReason(reason: CompileReason): string {
  switch (reason) {
    case 'build-record-stale':
      return 'a build record was found for this contract and described a ' +
        'different build';
    case 'build-record-absent':
      return 'no build record described this contract';
    case 'ast-only-escalation':
      return 'the caller re-asked after a non-empty declaration-order report';
  }
}

/**
 * The gate, whichever way it went — including on a `plugin-compile` basis, where
 * it is the gate that *sent* the call to the compiler.
 *
 * On an escalation it is the `fresh` gate of the input being escalated, which is
 * the record of *escalated from a verified record* — and the reason no separate
 * flag is needed to read the path off a produced input.
 */
function gateLines(gate: PluginCompileBasis['gate']): readonly string[] {
  switch (gate.kind) {
    case 'fresh':
      return [`gate:                     fresh (${gate.file})`];
    case 'stale':
      return [
        `gate:                     stale, ${gate.rejected.length} rejected`,
        ...gate.rejected.map(
          rejection => `  ${rejection.file}: ${rejection.reason}`,
        ),
      ];
    case 'absent':
      return [`gate:                     absent (${gate.because})`];
  }
}

// ---------------------------------------------------------------------------
// 4. The refusal: eleven causes, closed
// ---------------------------------------------------------------------------

/**
 * Who can act on the refusal. The exhaustive switch is the point of the example,
 * not the categories.
 *
 * The union is closed, and closed is the property that matters: it is what makes
 * one `could not validate` covering eleven situations unrepresentable, and what
 * makes the `never` assignment below a compile error the day a twelfth obligation
 * arrives without a diagnosis and a remedy.
 *
 * Reach for `cause.kind` only where a category genuinely changes what your
 * operation does. If all eleven end the same way for you, the diagnosis is already
 * rendered and there is nothing to switch on.
 */
export type Actor =
  | 'the project'
  | 'the compiler cache'
  | 'the TronBox version'
  | 'the machine'
  | 'this plugin';

export function whoCanAct(cause: Cause): Actor {
  switch (cause.kind) {
    // 1 — the compiler the project resolves to is not in the cache. The path is
    // carried so the remedy names which file was looked for, which is the only
    // way to tell a missing download from a moved cache.
    case 'compiler-absent':
      return 'the compiler cache';

    // 2 — present, loadable, matching, and still outside the verified range. The
    // gate is on the version rather than on the output, because an older compiler
    // accepts a `storageLayout` request with zero diagnostics of any severity and
    // simply omits the key.
    case 'compiler-unsupported':
      return 'the project';

    // 3 — the loaded compiler is not the build that produced the artifact,
    // compared as the long version. Two files at the same name under the two
    // cache trees report different commits and produce different bytecode, so a
    // version triple cannot answer this.
    case 'compiler-mismatched':
      return 'the project';

    // 4, 5 — a source in the closure cannot be read, or an import cannot be
    // resolved to a source the plugin may supply. Both are decided before the
    // compiler runs, so the message names the file to edit rather than reporting
    // the plugin's own input assembly back to the user.
    case 'source-unreadable':
    case 'import-unresolvable':
      return 'the project';

    // 6 — the artifact lacks a field this module requires. `missingField` is a
    // closed union of the host's own artifact keys, so a field can be absent only
    // because the host version predates it.
    case 'artifact-shape-unsupported':
      return 'the TronBox version';

    // 7, 11 — the pair that makes distinct remedies earn their keep. Both are
    // fixed by running `tronbox compile`; the remedy is what says which situation
    // you are in — recompile a stale artifact, or go read the compiler's own
    // errors, which the host already prints.
    case 'artifact-stale':
    case 'sources-do-not-compile':
      return 'the project';

    // 8 — the compiler exhausted its own memory on this closure. Terminal: one
    // contract's closure is the smallest partition there is.
    case 'compiler-resource-exhausted':
      return 'the machine';

    // 9 — the one that is *this plugin's* fault. It is a cause rather than an
    // invariant throw because an empty reference layout classifies every variable
    // as a safe append, and a silent accept is the worst outcome available here —
    // so the condition goes through the same enumerated, rendered, tested path as
    // everything else.
    case 'layout-vacuous':
      return 'this plugin';

    // 10 — a linked library's name is past the length the host can encode, which
    // corrupts the artifact's own bytecode. The message names the library and the
    // band because upstream's `Bytecode is not a valid hex string` names neither.
    case 'library-name-unsupported':
      return 'the project';

    default: {
      // A twelfth member fails here at compile time rather than at runtime, which
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
 * eleven. If one reads wrongly for your operation, fix it where every consumer
 * gets the fix — a paraphrase here is how eleven causes become thirty-three
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
 * Two codes come from this module. `storage-layout-unavailable` says the flat
 * layout was reconstructed from the AST, and only the fresh path records it.
 * `namespaced-ast-only` says this contract declares namespaced storage, whose
 * members carry no positions in **either** mode — so it is not a fresh-path
 * artefact, and every path that finds a namespace records it.
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
