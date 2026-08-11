import {
  unreachableCause,
  type BuildRecordRejection,
  type Cause,
} from './causes';
import { SUPPORTED_SOLC } from './compiler';
import { ValidationInputInvariantError } from './errors';
import { MAX_LIBRARY_NAME_LENGTH } from './identity';

/**
 * Cause → rendered message. Unconditional, and independent of policy.
 *
 * **This module does not import `./policy` and must not.** Cause
 * determination and message rendering happen where the failure is observed,
 * whatever the table decides; only the *disposition* is policy. That separation
 * is what makes a leniency flip provably unable to change the diagnosis, and
 * what makes seven cause tests plus one policy-table test possible instead of
 * seven × two.
 *
 * Every headline interpolates the concrete failing thing its own cause
 * carries: the contract, the source key and path, the specifier and its
 * importer, the rejected record files and their reasons, the library and its
 * band. No headline is generic and none covers two causes — which is the
 * property that makes the actionable-diagnosis requirement checkable per path
 * rather than in aggregate.
 *
 * Every remedy is distinct across the seven. The pair that makes that
 * rule earn its keep is 5 versus 6: both are fixed by running
 * `tronbox compile --all`, and the remedy is what tells the user which
 * situation they are in — no record was ever written for this contract, or
 * every record found no longer describes the compiled artifact.
 */

/**
 * One rendered refusal. Both fields required, both non-empty: a diagnosis that
 * says something failed without saying what to do satisfies the
 * actionable-diagnosis requirement's letter and defeats its purpose.
 */
export interface Diagnosis {
  /** One sentence naming the contract or input and the cause. */
  readonly headline: string;
  /** The remedy, as an imperative. One per cause; never shared between causes. */
  readonly remedy: string;
}

/**
 * This function's runtime guard. A blank string is a plugin bug rather than a
 * user condition, so it raises rather than rendering an empty line — mirroring
 * the option/result surface's `DegradedNote` rule (`src/output/types.ts:125-130`,
 * *"Never empty"*).
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

/**
 * One rejected record rendered as `file (reason)`, with the reason in the
 * user's vocabulary rather than the enum's. Self-contained on purpose: the
 * rejection reasons are the whole evidence a `build-record-stale` refusal
 * carries, so a phrase that needs the source code to decode would defeat the
 * actionable-diagnosis requirement for the one cause with a list payload.
 */
function rejectionPhrase(reason: BuildRecordRejection['reason']): string {
  switch (reason) {
    case 'deployed-bytecode-differs':
      return "its deployed bytecode is not the artifact's";
    case 'nothing-to-compare':
      return (
        'it carries no deployed bytecode to verify — an abstract contract ' +
        'or interface cannot be validated'
      );
    case 'ast-closure-incomplete':
      return "it lacks an AST for part of the contract's import closure";
    case 'target-definition-absent':
      return 'its AST does not declare this contract';
    case 'input-pair-absent':
      return 'its paired compiler-input file is missing';
    case 'input-pair-unparseable':
      return 'its paired compiler-input file is not valid JSON';
    case 'input-pair-unusable':
      return 'its paired compiler-input file is not the input of this record';
  }
}

function renderRejections(rejected: readonly BuildRecordRejection[]): string {
  return rejected
    .map(entry => `${entry.file} (${rejectionPhrase(entry.reason)})`)
    .join('; ');
}

export function diagnose(cause: Cause): Diagnosis {
  switch (cause.kind) {
    case 'compiler-unsupported':
      return diagnosis(
        `This project compiles with Solidity ${cause.resolvedVersion}, which is ` +
          `outside the range tronbox-upgrades supports for upgrade-safety ` +
          `validation (${SUPPORTED_SOLC.min}–${SUPPORTED_SOLC.max}). Validation ` +
          `interprets the compiler output TronBox recorded for this project, ` +
          `and this plugin is verified only across that range.` +
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
          `resolve to a source of this project. The validation reads this ` +
          `contract's whole import closure out of the build record TronBox ` +
          `wrote, so a reference that cannot be resolved stops it before the ` +
          `record is consulted.`,
        `Fix the reference to "${cause.specifier}" in ${cause.importedBy}: local ` +
          `files must start with \`./\` or \`../\` and stay inside the contracts ` +
          `directory, and an npm import must look like \`package/path.sol\` or ` +
          `\`@scope/package/path.sol\` with the package installed.`,
      );

    case 'artifact-shape-unsupported':
      return diagnosis(
        `The compiled artifact for ${cause.contract} carries no ` +
          `\`${cause.missingField}\`, which upgrade-safety validation needs in ` +
          `order to tie the build record TronBox wrote to the bytecode that is ` +
          `about to be deployed.`,
        `Upgrade TronBox to ${cause.providedSince} or later — that is the ` +
          `oldest version verified to write \`${cause.missingField}\` into every ` +
          `artifact — then run \`tronbox compile\`.`,
      );

    case 'build-record-absent':
      return diagnosis(
        `TronBox's build-info directory ` +
          `${
            cause.because === 'directory-absent'
              ? 'does not exist'
              : cause.because === 'directory-unreadable'
                ? 'could not be read'
                : 'holds no build record for this contract'
          }, so there is no record of the compile that produced this ` +
          `artifact. Upgrade-safety validation reads storage information out ` +
          `of that record and never compiles on its own, so without one there ` +
          `is nothing to validate from.`,
        `Run \`tronbox compile --all\` and retry: the \`--all\` flag forces ` +
          `recompilation of unchanged sources, so the remedy always works — ` +
          `a build record is written even when TronBox considers the project ` +
          `up to date.`,
      );

    case 'build-record-stale':
      return diagnosis(
        `Every build record found for this contract was rejected: ` +
          `${renderRejections(cause.rejected)}. None of them describes the ` +
          `compiled artifact that is about to be deployed, so validating from ` +
          `them would check the wrong program.`,
        `Run \`tronbox compile --all\` and retry: the \`--all\` flag forces ` +
          `recompilation of unchanged sources, so stale build records are ` +
          `regenerated from the same compile as the artifact.` +
          (cause.rejected.some(
            rejection => rejection.reason === 'nothing-to-compare',
          )
            ? ` If the target is an abstract contract or interface, select a ` +
              `concrete deployable contract instead: recompilation cannot ` +
              `create deployed bytecode for it.`
            : ''),
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

    default:
      return unreachableCause(cause, 'diagnose');
  }
}
