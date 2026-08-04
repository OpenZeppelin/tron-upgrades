/**
 * The fresh path: derive the validation input inside the operation that needs it,
 * and on a tree the host has just built, compile nothing.
 *
 * Three facts this file exists to make executable:
 *
 *  1. `deriveValidationInput` returns an **outcome**. A refusal is a value, so the
 *     operation boundary — not this module — decides whether to throw it or carry
 *     it (`src/validation-input/pipeline.ts:243`).
 *  2. When the host's own build record for the target verifies against the
 *     artifact's deployed bytecode, the layout is reconstructed from the ASTs that
 *     record already carries and **no compiler is located, loaded or run**. § 4
 *     passes a `loadCompiler` that raises if it is ever called; on this path it is
 *     not called.
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
 * accepted**, so it fails in the correct direction. Read
 * [`../README.md`](../README.md#what-the-fresh-path-actually-costs) before writing
 * a sentence about it.
 */
import {
  deriveValidationInput,
  ValidationInputRefusedError,
  type Cause,
  type CompilerHandle,
  type Diagnosis,
  type ValidationInput,
  type ValidationInputEnvironment,
} from '../../../src/validation-input';

// ---------------------------------------------------------------------------
// 1. The primary pattern
// ---------------------------------------------------------------------------

/**
 * Nothing is cached at module scope, and nothing needs to be: the fresh path
 * costs zero compiles, which is what makes re-deriving per operation affordable.
 *
 * An input is a snapshot of the source tree, the artifact and the build record at
 * the moment of the call, and nothing in it is invalidated when the tree changes.
 * The compile memo is created per call and the production `deps` defaults are
 * resolved inside the call, so there is no module-scope state to reuse anyway.
 */
export async function inputFor(
  contract: string,
  env: ValidationInputEnvironment,
): Promise<ValidationInput> {
  const outcome = await deriveValidationInput({ contract, env });

  if (outcome.kind === 'refused') {
    // The one rendering (`src/validation-input/errors.ts:85`). The constructor
    // takes no `string`, so composing a sentence here is a compile error rather
    // than a review finding — eleven causes cannot become thirty-three messages
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
// 2. What a fresh input reports about itself
// ---------------------------------------------------------------------------

/**
 * The fresh gate's whole record: which file verified, and how many candidates
 * were examined to find it.
 *
 * `candidates` counts work done rather than records held — candidates after the
 * one that verified are never read. `compilerLongVersion` is the artifact's own
 * long version, and it is trustworthy on this path for a specific reason: the
 * build record that verified against the artifact by deployed bytecode was
 * produced by that compiler, by content rather than by claim. There is no
 * `CompilerIdentity` here because no compiler was reached.
 */
export function describeFreshInput(input: ValidationInput): string | null {
  const basis = input.provenance.basis;
  if (basis.kind !== 'build-record-ast') {
    return null;
  }
  return [
    `verified record: ${basis.gate.file}`,
    `candidates read: ${basis.gate.candidates}`,
    `compiler:        ${basis.compilerLongVersion} (never loaded)`,
    `sources:         ${input.provenance.partition.closure.length} in closure`,
  ].join('\n');
}

/**
 * The two fields that come as a pair on this path, and the reason they do.
 *
 * The pipeline asserts the biconditional on its way out: the fresh path reports
 * `declaration-order-only` with a non-empty `missingFor`, and the three compiling
 * paths report `slot-level`. An unconditional `slot-level` claim — which this
 * pipeline once carried — is a permissive mislabel, and it is the bug the fidelity
 * detector was rewritten to remove.
 */
export function positionsMissingFor(
  input: ValidationInput,
): readonly string[] {
  return input.fidelity.kind === 'declaration-order-only'
    ? input.fidelity.missingFor
    : [];
}

// ---------------------------------------------------------------------------
// 3. `solcInput` exists on this path too, and is needed
// ---------------------------------------------------------------------------

/**
 * `solcInput` is reconstructed from the contracts directory on **every** path,
 * including the fresh one where nothing was compiled from it.
 *
 * That is deliberate rather than wasteful: the engine reads
 * `sources[key].content` for its own namespace-annotation version check, and
 * would throw on a key the output carries and the input does not.
 * `provenance.basis` is what says whether anything compiled it.
 *
 * `sources[key].content` is also the only place in this module where Solidity
 * source text exists at all — no cause payload, no diagnosis and no degraded note
 * can carry a byte of it.
 */
export function sourceKeysInOrder(input: ValidationInput): readonly string[] {
  return input.provenance.sourceKeys;
}

// ---------------------------------------------------------------------------
// 4. Zero compiles, demonstrated rather than asserted
// ---------------------------------------------------------------------------

/**
 * A `loadCompiler` that raises if it is reached.
 *
 * On the fresh path this is never called, and neither is `deps.homeDirectory` —
 * the gate inside the compiler step decides whether the machine is read at all,
 * and on this path it is not read once. So a project whose `~/.tronbox` cache was
 * never populated still validates on a freshly built tree, and cause 1
 * (`compiler-absent`) is unreachable there.
 *
 * `deps.exists` and `deps.readSource` *are* called on every path — the source
 * closure is resolved before the gate, because a project with an unreadable
 * import has that problem whether or not it also lacks a cached compiler.
 *
 * The full seam, and what each member is for, is
 * [`02-supply-your-own-dependencies.ts`](./02-supply-your-own-dependencies.ts).
 */
export async function deriveWithoutAnyCompiler(
  contract: string,
  env: ValidationInputEnvironment,
): Promise<ValidationInput> {
  const outcome = await deriveValidationInput({
    contract,
    env,
    deps: {
      loadCompiler: (soljsonPath: string): CompilerHandle => {
        throw new Error(
          `the fresh path loaded a compiler (${soljsonPath}), which it must ` +
            `not: the layout came from the build record's ASTs.`,
        );
      },
    },
  });

  if (outcome.kind === 'refused') {
    throw new ValidationInputRefusedError(outcome.cause, outcome.diagnosis);
  }
  return outcome.input;
}

/*
 * Deliberately NOT provided, because it is the one thing this seam does not do:
 *
 *   deriveValidationInput({ contract, env, deps: { policy: myTable } });
 *
 * There is no `policy` member on `ValidationInputDependencies` and there must not
 * be. An injectable table restores per-call-site variation through the back door,
 * and the whole point of one policy call site is that a leniency decision is made
 * in one table rather than eleven times at eleven call sites. There is no writer
 * on the seam either: this module persists nothing, so the injected surface has no
 * write capability to misuse.
 */
