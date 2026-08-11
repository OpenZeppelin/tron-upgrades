/**
 * The primary pattern: derive the validation input inside the operation that
 * needs it, and compile nothing — because nothing here can compile.
 *
 * Three facts this file exists to make executable:
 *
 *  1. `deriveValidationInput` returns an **outcome**. A refusal is a value, so the
 *     operation boundary — not this module — decides whether to throw it or carry
 *     it (`src/validation-input/pipeline.ts`).
 *  2. The layout is reconstructed from the ASTs the host's own build record
 *     already carries, after that record content-verifies against the artifact's
 *     deployed bytecode. **No compiler is located, loaded or run, on any path** —
 *     the dependency surface (§ 4) has no compiler member to inject, so a compile
 *     is unrepresentable rather than merely avoided.
 *  3. The input says so about itself. `provenance.basis.kind` is
 *     `'build-record-ast'`, and `fidelity.kind` is `'declaration-order-only'` with
 *     a non-empty `missingFor`. Neither is inferred by a consumer — both are
 *     asserted on the pipeline's own return boundary.
 *
 * Reduced fidelity here is not "unchecked", and a sentence saying so would be
 * false. `upgrades-core` reconstructs the layout from the contract's AST and
 * becomes **stricter, not blinder**: appends are structurally exempt, while
 * reordering, renames, retypes and deletions are all still detected. Exactly two
 * shapes need slot positions — consuming a `__gap` array, and inserting into
 * unused padding inside an existing slot — and both are **refused rather than
 * accepted**, so it fails in the correct direction. Read the README's
 * "Validation without storage layouts" section before writing a sentence about
 * it.
 */
import { fileSystemBuildInfoReader } from '../../../src/environment';
import {
  deriveValidationInput,
  ValidationInputRefusedError,
  type Cause,
  type Diagnosis,
  type ValidationInput,
  type ValidationInputEnvironment,
} from '../../../src/validation-input';

// ---------------------------------------------------------------------------
// 1. The primary pattern
// ---------------------------------------------------------------------------

/**
 * Nothing is cached at module scope, and nothing needs to be: a derivation is a
 * directory listing and a handful of file reads — never a compile — which is
 * what makes re-deriving per operation affordable.
 *
 * An input is a snapshot of the source tree, the artifact and the build record at
 * the moment of the call, and nothing in it is invalidated when the tree changes.
 * The production `deps` defaults are resolved inside the call, so there is no
 * module-scope state to reuse anyway.
 */
export async function inputFor(
  contract: string,
  env: ValidationInputEnvironment,
): Promise<ValidationInput> {
  const outcome = await deriveValidationInput({ contract, env });

  if (outcome.kind === 'refused') {
    // The one rendering (`src/validation-input/errors.ts`). The constructor
    // takes no `string`, so composing a sentence here is a compile error rather
    // than a review finding — seven causes cannot become twenty-one messages
    // across the consuming operations.
    throw new ValidationInputRefusedError(outcome.cause, outcome.diagnosis);
  }

  return outcome.input;
}

/**
 * The same call, carrying the refusal instead of throwing it.
 *
 * An `upgradeProxy` that must not proceed should throw; a dry-run that wants to
 * report every contract's verdict should carry. That choice is the reason the
 * pipeline returns a value: a thrown refusal cannot become a proceed, because
 * catching it cannot manufacture the layouts a lenient path would need.
 */
export async function verdictFor(
  contract: string,
  env: ValidationInputEnvironment,
): Promise<
  | { readonly contract: string; readonly input: ValidationInput }
  | {
      readonly contract: string;
      readonly cause: Cause;
      readonly diagnosis: Diagnosis;
    }
> {
  const outcome = await deriveValidationInput({ contract, env });
  return outcome.kind === 'input'
    ? { contract, input: outcome.input }
    : { contract, cause: outcome.cause, diagnosis: outcome.diagnosis };
}

// ---------------------------------------------------------------------------
// 2. What a produced input reports about itself
// ---------------------------------------------------------------------------

/**
 * The fresh gate's whole record: which file verified, how many candidates were
 * examined to find it, and which paired compiler-input file became `solcInput`.
 *
 * `candidates` counts work done rather than records held — candidates after the
 * one that verified are never read. `compilerLongVersion` is the artifact's own
 * long version, and it is trustworthy for a specific reason: the build record
 * that verified against the artifact by deployed bytecode was produced by that
 * compiler, by content rather than by claim. No compiler identity is recorded
 * because no compiler was reached.
 *
 * `basis` is a single-member union — the Foundry model has exactly one producing
 * step — so there is nothing to narrow before reading it. The discriminant is
 * kept so a future second basis (TronBox emitting `storageLayout`, say) arrives
 * as an added member rather than a reshaping.
 */
export function describeFreshInput(input: ValidationInput): string {
  const basis = input.provenance.basis;
  return [
    `verified record: ${basis.gate.file}`,
    `candidates read: ${basis.gate.candidates}`,
    `solc input from: ${basis.inputFile}`,
    `compiler:        ${basis.compilerLongVersion} (never loaded)`,
    `sources:         ${input.provenance.partition.closure.length} in closure`,
  ].join('\n');
}

/**
 * The two fields that come as a pair on every produced input, and the reason.
 *
 * The pipeline asserts on its way out that the one producing step reports
 * `declaration-order-only` with a non-empty `missingFor` — no build record
 * carries storage positions, because TronBox does not request them. The
 * `slot-level` branch below is not producible today; it stays in the union so
 * that the day the host starts emitting layouts, the change arrives as a
 * detector answer rather than a stale claim. An unconditional `slot-level`
 * claim — which this pipeline once carried — is a permissive mislabel, and it
 * is the bug the fidelity detector was rewritten to remove.
 */
export function positionsMissingFor(
  input: ValidationInput,
): readonly string[] {
  return input.fidelity.kind === 'declaration-order-only'
    ? input.fidelity.missingFor
    : [];
}

// ---------------------------------------------------------------------------
// 3. `solcInput` is the recorded pair, verbatim
// ---------------------------------------------------------------------------

/**
 * `solcInput` is the paired `<hash>.json` compiler input TronBox wrote next to
 * the verified build record — the exact input that produced `solcOutput` —
 * narrowed at the gate and handed on untouched.
 *
 * Deliberately **not** reconstructed from the contracts directory: source text
 * on disk can drift from what was compiled while the deployed bytecode still
 * verifies, and a consumer decoding the output's AST spans against drifted text
 * reads the wrong characters. The pair is the one input whose spans match this
 * output by construction.
 *
 * `sources[key].content` is also the only place in this module where Solidity
 * source text exists at all — no cause payload, no diagnosis and no degraded note
 * can carry a byte of it.
 */
export function sourceKeysInOrder(input: ValidationInput): readonly string[] {
  return input.provenance.sourceKeys;
}

// ---------------------------------------------------------------------------
// 4. The dependency surface has no compiler member, demonstrated
// ---------------------------------------------------------------------------

/**
 * The one non-filesystem dependency is `readBuildInfo` — the build-record
 * reader, which is a real member of `ValidationInputDependencies` and the seam
 * the whole gate is decided through.
 *
 * Wrapping the production reader, as here, changes nothing about behaviour; it
 * makes the pipeline's cost model observable. One consultation per derivation
 * is the whole record-side I/O budget — and there is no `loadCompiler`, no
 * compiler handle, and no compiler cache anywhere on the surface to wrap,
 * because the pipeline has nothing to do with a compiler.
 *
 * `deps.exists` and `deps.readSource` are the other two members, called on
 * every derivation: the source closure is resolved before the gate, because a
 * project with an unreadable import has that problem whether or not it also
 * lacks a build record. The full seam, and what each member is for, is
 * [`02-supply-your-own-dependencies.ts`](./02-supply-your-own-dependencies.ts).
 */
export async function deriveCountingRecordReads(
  contract: string,
  env: ValidationInputEnvironment,
): Promise<{ readonly input: ValidationInput; readonly consultations: number }> {
  let consultations = 0;

  const outcome = await deriveValidationInput({
    contract,
    env,
    deps: {
      readBuildInfo: directory => {
        consultations += 1;
        return fileSystemBuildInfoReader.read(directory);
      },
    },
  });

  if (outcome.kind === 'refused') {
    throw new ValidationInputRefusedError(outcome.cause, outcome.diagnosis);
  }
  return { input: outcome.input, consultations };
}

/*
 * Deliberately NOT provided, because it is the one thing this seam does not do:
 *
 *   deriveValidationInput({ contract, env, deps: { policy: myTable } });
 *
 * There is no `policy` member on `ValidationInputDependencies` and there must not
 * be. An injectable table restores per-call-site variation through the back door,
 * and the whole point of one policy call site is that a leniency decision is made
 * in one table rather than seven times at seven call sites. There is no writer
 * on the seam either: this module persists nothing, so the injected surface has no
 * write capability to misuse.
 */
