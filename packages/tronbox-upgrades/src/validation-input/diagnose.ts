import { unreachableCause, type Cause } from './causes';
import { SUPPORTED_SOLC } from './compiler';
import { ValidationInputInvariantError } from './errors';
import { MAX_LIBRARY_NAME_LENGTH } from './identity';

/**
 * Cause → rendered message. Unconditional, and independent of policy.
 *
 * **This module does not import `./policy` and must not** (INV-11). Cause
 * determination and message rendering happen where the failure is observed,
 * whatever the table decides; only the *disposition* is policy. That separation
 * is what makes a leniency flip provably unable to change the diagnosis
 * (INV-12), and what makes eleven cause tests plus one policy-table test
 * possible instead of eleven × two.
 *
 * Every headline interpolates the concrete failing thing its own cause carries
 * (INV-14): the contract, the source key and path, the specifier and its
 * importer, the two long versions that disagreed, the library and its band. No
 * headline is generic and none covers two causes — which is the property that
 * makes SC-006 checkable per path rather than in aggregate.
 *
 * Every remedy is distinct across the eleven (INV-13). The pair that makes that
 * rule earn its keep is 7 versus 11: both are fixed by running
 * `tronbox compile`, and the remedy is what tells the user which situation they
 * are in — recompile a stale artifact, or go read the compiler's own errors.
 */

/**
 * One rendered refusal. Both fields required, both non-empty: a diagnosis that
 * says something failed without saying what to do satisfies SC-006's letter and
 * defeats its purpose.
 */
export interface Diagnosis {
  /** One sentence naming the contract or input and the cause. */
  readonly headline: string;
  /** The remedy, as an imperative. One per cause; never shared between causes. */
  readonly remedy: string;
}

/**
 * INV-13's runtime guard. A blank string is a plugin bug rather than a user
 * condition, so it raises rather than rendering an empty line — mirroring
 * SF-10's `DegradedNote` rule (`src/output/types.ts:125-130`, *"Never empty"*).
 */
function diagnosis(headline: string, remedy: string): Diagnosis {
  if (headline.trim() === '' || remedy.trim() === '') {
    throw new ValidationInputInvariantError(
      `a diagnosis was constructed with an empty ${
        headline.trim() === '' ? 'headline' : 'remedy'
      }.`,
    );
  }
  return Object.freeze({ headline, remedy });
}

/** Which compiler tree the path came from, in the user's own vocabulary. */
function familyName(family: 'tvm' | 'evm'): string {
  return family === 'evm' ? 'Ethereum (--evm)' : 'Tron';
}

export function diagnose(cause: Cause): Diagnosis {
  switch (cause.kind) {
    case 'compiler-absent':
      return diagnosis(
        `TronBox's compiler cache has no usable ${familyName(cause.family)} ` +
          `Solidity compiler ${cause.requestedVersion} at ` +
          `${cause.soljsonPath}, and that is the version this project compiles ` +
          `with. Upgrade-safety validation needs to run that exact compiler to ` +
          `read storage layouts out of it.`,
        `Run \`tronbox compile\`, which downloads the compiler, or fetch it ` +
          `directly with \`tronbox --download-compiler ${cause.requestedVersion}\`` +
          `${cause.family === 'evm' ? ' --evm' : ''}.`,
      );

    case 'compiler-unsupported':
      return diagnosis(
        `This project compiles with Solidity ${cause.resolvedVersion}, which is ` +
          `outside the range tronbox-upgrades supports for upgrade-safety ` +
          `validation (${SUPPORTED_SOLC.min}–${SUPPORTED_SOLC.max}). Validation ` +
          `needs storage layouts from the compiler, and this plugin is verified ` +
          `only across that range.` +
          (cause.viaLegacyFlag === undefined
            ? ''
            : ` The version came from the \`${cause.viaLegacyFlag}\` flag in ` +
              `your TronBox config.`),
        cause.viaLegacyFlag === undefined
          ? `Set \`compilers.solc.version\` to a version between ` +
            `${SUPPORTED_SOLC.min} and ${SUPPORTED_SOLC.max}, then run ` +
            `\`tronbox compile\`.`
          : `Remove \`${cause.viaLegacyFlag}\` from your TronBox config, set ` +
            `\`compilers.solc.version\` to a version between ` +
            `${SUPPORTED_SOLC.min} and ${SUPPORTED_SOLC.max}, then run ` +
            `\`tronbox compile\`.`,
      );

    case 'compiler-mismatched':
      return diagnosis(
        `The artifact was built by ${cause.artifactLongVersion}, but the ` +
          `compiler this project now resolves to reports ` +
          `${cause.loadedLongVersion}. Those are different builds, so the ` +
          `storage layouts one produces do not describe the bytecode the other ` +
          `produced. Validation is currently using the ` +
          `${familyName(cause.family)} compiler tree.`,
        `Recompile the project with \`tronbox compile\` so the artifact and the ` +
          `compiler agree — and check that \`--evm\` is used the same way when ` +
          `you build and when you deploy or upgrade, since the two trees ship ` +
          `different builds under the same version number.`,
      );

    case 'source-unreadable':
      return diagnosis(
        `The source ${cause.sourceKey}, which this contract's import closure ` +
          `needs, is ${cause.because === 'missing' ? 'not on disk' : 'unreadable'}` +
          ` at ${cause.path}.`,
        cause.because === 'missing'
          ? `Restore ${cause.path}, or remove the import that pulls it in, then ` +
            `run \`tronbox compile\`.`
          : `Make ${cause.path} readable as UTF-8 text — check its file ` +
            `permissions and that it is not a directory or a broken symlink.`,
      );

    case 'import-unresolvable':
      return diagnosis(
        `${cause.importedBy} refers to "${cause.specifier}", which does not ` +
          `resolve to a source this plugin may hand the compiler. Every source ` +
          `has to be supplied to solc up front, so a reference that cannot be ` +
          `resolved stops the validation before the compiler runs.`,
        `Fix the reference to "${cause.specifier}" in ${cause.importedBy}: local ` +
          `files must start with \`./\` or \`../\` and stay inside the contracts ` +
          `directory, and an npm import must look like \`package/path.sol\` or ` +
          `\`@scope/package/path.sol\` with the package installed.`,
      );

    case 'artifact-shape-unsupported':
      return diagnosis(
        `The compiled artifact for ${cause.contract} carries no ` +
          `\`${cause.missingField}\`, which upgrade-safety validation needs in ` +
          `order to tie the compiler's storage layouts to the bytecode that is ` +
          `about to be deployed.`,
        `Upgrade TronBox to ${cause.providedSince} or later — that is the ` +
          `oldest version verified to write \`${cause.missingField}\` into every ` +
          `artifact — then run \`tronbox compile\`.`,
      );

    case 'artifact-stale':
      return diagnosis(
        `The compiled artifact for ${cause.contract} does not match the sources ` +
          `on disk: recompiling them produces different code. Validating the ` +
          `artifact would check the wrong program.`,
        `Run \`tronbox compile\`.`,
      );

    case 'compiler-resource-exhausted':
      return diagnosis(
        `The Solidity compiler ran out of memory compiling ${cause.target} ` +
          `together with its ${cause.closureSize} transitive sources` +
          `${
            cause.raised === 'memory-access-out-of-bounds'
              ? ''
              : ' (the WebAssembly module aborted for a reason other than the' +
                ' memory ceiling)'
          }. That closure is the smallest input this plugin can give the ` +
          `compiler for this contract, so there is nothing smaller to retry ` +
          `with.`,
        `Reduce ${cause.target}'s import closure — split the contract, or drop ` +
          `imports it does not use — and report the closure size to the ` +
          `tronbox-upgrades issue tracker so the ceiling is recorded.`,
      );

    case 'layout-vacuous':
      return diagnosis(
        `The compiler returned an empty storage layout for ${cause.contract}, ` +
          `which declares ${cause.declaredStateVariables} state variable` +
          `${cause.declaredStateVariables === 1 ? '' : 's'}. An empty reference ` +
          `layout makes every variable in an upgrade look like a safe append, so ` +
          `this refusal exists to stop a validation that would pass no matter ` +
          `what changed.`,
        `Please report this as a bug against tronbox-upgrades, naming ` +
          `${cause.contract} and your compiler version — the plugin asked for a ` +
          `layout and got nothing usable, and that is the plugin's fault rather ` +
          `than your project's.`,
      );

    case 'library-name-unsupported':
      return diagnosis(
        `The library ${cause.libraryName} has a ${cause.length}-character name, ` +
          `and TronBox writes library placeholders into a fixed 40-character ` +
          `field without truncating` +
          `${
            cause.band === '>=39'
              ? `. At ${cause.length} characters the placeholder overruns that ` +
                `field, so the artifact's own bytecode is no longer what the ` +
                `compiler produced`
              : `. At ${cause.length} characters the placeholder no longer has ` +
                `the trailing underscores upgrades-core needs to recognise it, ` +
                `so no contract identity can be computed`
          }.`,
        `Rename ${cause.libraryName} to ${MAX_LIBRARY_NAME_LENGTH} characters ` +
          `or fewer and run \`tronbox compile\`.`,
      );

    case 'sources-do-not-compile':
      return diagnosis(
        `The sources for ${cause.target} do not compile: the compiler reported ` +
          `${cause.errorCount} error${cause.errorCount === 1 ? '' : 's'}. ` +
          `Until they compile there is no output to compare the artifact ` +
          `against, so nothing about the upgrade can be checked.`,
        `Fix the compile errors in ${cause.target}; run \`tronbox compile\` to ` +
          `see the compiler's own error text, which TronBox prints in full.`,
      );

    default:
      return unreachableCause(cause, 'diagnose');
  }
}
