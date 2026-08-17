import type { Cause } from './causes';
import type { Diagnosis } from './diagnose';

/**
 * The validation pipeline's two error classes.
 *
 * **Why this module exists.** `causes.ts` is fixed as *"the closed union of
 * causes. Pure data. No policy."* — an error class is neither — and `index.ts`
 * cannot hold them either: the modules that raise an invariant error would all
 * import the face while the face imports `pipeline.ts`, which imports them.
 * That is a runtime import cycle, not a stylistic preference. A leaf module is
 * the only cycle-free home, and a per-directory `errors.ts` is
 * already the package's idiom three times over: `src/chain/errors.ts`,
 * `src/options/errors.ts`, `src/environment/errors.ts`. The two type imports
 * above are `import type`, so they are erased and create no runtime edge back
 * into `causes.ts`, which imports this module at runtime.
 *
 * There used to be a third class, `CompilerRetiredError`, guarding reuse of a
 * poisoned wasm compiler handle. It left with the embedded compiler: the
 * Foundry-model pipeline never loads one, so there is no handle to retire.
 */

/**
 * A broken invariant — always a plugin bug, never a user-facing condition.
 *
 * The only thing `deriveValidationInput` may throw is this (plus the seam's
 * own `ArtifactNameAmbiguousError`, which denotes an operation that skipped
 * its ambiguity decision). Every *user* condition is one of the seven
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
 * The one construct through which a refusal becomes user-visible output.
 *
 * **The absence of a `string` parameter is the enforcement.** A consumer cannot
 * word its own refusal sentence here — that is a compile error rather than a
 * review finding — so seven causes cannot become twenty-one messages as the
 * proxy operations, the standalone operations, and adoption (forceImport) are
 * written. Follows the plugin's typed-error idiom: `src/chain/errors.ts:152-153`,
 * `src/options/errors.ts:107-108`.
 *
 * The validation pipeline never constructs or throws this. `deriveValidationInput`
 * returns the refusal as a value; the operation boundary decides whether
 * carrying it or throwing it is right for its own contract.
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
