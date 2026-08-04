import type { Cause } from './causes';
import type { Diagnosis } from './diagnose';

/**
 * SF-2's three error classes.
 *
 * **Why this module exists, when the planned module list named twelve and none of
 * them was this one.** `ValidationInputInvariantError` and `CompilerRetiredError`
 * were specified with the error handling, and the invariant set adds a third,
 * `ValidationInputRefusedError` (INV-20), but no module in the twelve owns them.
 * The two candidates both fail:
 *
 * - `index.ts` — nine modules raise an invariant error, so every one of them
 *   would import the face while the face imports `pipeline.ts`, which imports
 *   them. That is a runtime import cycle, not a stylistic preference.
 * - `causes.ts` — Design fixes it as *"the closed union of eleven causes. Pure
 *   data. No policy."* An error class is neither.
 *
 * A leaf module is the only cycle-free home, and a per-directory `errors.ts` is
 * already the package's idiom three times over: `src/chain/errors.ts`,
 * `src/options/errors.ts`, `src/environment/errors.ts`. The two type imports
 * above are `import type`, so they are erased and create no runtime edge back
 * into `causes.ts`, which imports this module at runtime.
 */

/**
 * A broken invariant — always a plugin bug, never a user-facing condition.
 *
 * INV-1: the only two things `deriveValidationInput` may throw are this and
 * {@link CompilerRetiredError}. Every *user* condition is one of the eleven
 * enumerated causes, returned as a value.
 */
export class ValidationInputInvariantError extends Error {
  readonly code = 'VALIDATION_INPUT_INVARIANT' as const;

  constructor(detail: string) {
    super(
      `tronbox-upgrades broke one of its own invariants while deriving a ` +
        `validation input: ${detail} This is a bug in the plugin, not in your ` +
        `project. Please report it with the contract you were validating.`,
    );
    this.name = 'ValidationInputInvariantError';
  }
}

/**
 * A `CompilerHandle` was used after its `compile` threw (INV-24).
 *
 * Loud on purpose. Emscripten's abort poisons the module, so a silently reused
 * handle turns one contract's memory ceiling into every later contract's:
 * `evidence/probe-wasm-memory-ceiling.js` uses one fresh child process per trial
 * for exactly this reason.
 */
export class CompilerRetiredError extends Error {
  readonly code = 'COMPILER_RETIRED' as const;

  constructor(readonly retiredBy: string) {
    super(
      `The Solidity compiler this validation loaded was retired after it threw ` +
        `(${retiredBy}), and a retired compiler is never reused: an emscripten ` +
        `abort leaves the module in a state where later compiles fail for ` +
        `reasons that have nothing to do with what they were asked to compile.`,
    );
    this.name = 'CompilerRetiredError';
  }
}

/**
 * The one construct through which a refusal becomes user-visible output
 * (INV-20).
 *
 * **The absence of a `string` parameter is the enforcement.** A consumer cannot
 * word its own refusal sentence here — that is a compile error rather than a
 * review finding — so eleven causes cannot become thirty-three messages as
 * SF-5, SF-6 and SF-7 are written. Follows the plugin's typed-error idiom:
 * `src/chain/errors.ts:152-153`, `src/options/errors.ts:107-108`.
 *
 * SF-2 never constructs or throws this. `deriveValidationInput` returns the
 * refusal as a value (INV-1); the operation boundary decides whether carrying it
 * or throwing it is right for its own contract.
 *
 * The cause is exposed as `refusedCause` rather than `cause` because ES2022's
 * `Error.cause` means *the error this one wraps*, and a `Cause` is not an error.
 */
export class ValidationInputRefusedError extends Error {
  readonly code = 'VALIDATION_INPUT_REFUSED' as const;

  readonly refusedCause: Cause;

  readonly diagnosis: Diagnosis;

  constructor(refusedCause: Cause, diagnosis: Diagnosis) {
    super(`${diagnosis.headline} ${diagnosis.remedy}`);
    this.name = 'ValidationInputRefusedError';
    this.refusedCause = refusedCause;
    this.diagnosis = diagnosis;
  }
}
