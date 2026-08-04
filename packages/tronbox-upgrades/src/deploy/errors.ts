/**
 * The deployment seam's refusal family: one closed hierarchy, one class per
 * cause, each with its own remedy (INV-6). Causes with different user remedies
 * are never collapsed — *confirmation exhausted* and *transaction reverted* are
 * the canonical pair, because "raise the bound and re-check" and "fix the
 * contract" point opposite directions, and a user handed the wrong one re-sends
 * a transaction that already landed.
 *
 * Every constructor takes structured fields and renders its own message, so a
 * consumer can neither paraphrase a diagnosis nor construct one with the fields
 * and the text disagreeing.
 */

import type { ConfirmationIndeterminate, ConfirmedReverted } from './types';

/** The base every deployment refusal extends, so one `catch` can scope the family. */
export abstract class DeploymentRefusedError extends Error {
  abstract readonly code: string;
}

/**
 * A state-changing operation was invoked in a context that provides no
 * deployer, and the refusal names exactly what is missing (INV-18). Validation
 * in the same context does not refuse — it degrades, because it can. Deployment
 * refuses because there is nothing to send the transaction through.
 */
export class DeployerAbsentError extends DeploymentRefusedError {
  readonly code = 'deployer-absent';
  constructor(readonly context: string) {
    super(
      `This operation sends a transaction, and the ${context} context provides ` +
        `no deployer to send it through. Run it from a migration ` +
        `(\`tronbox migrate\`), where TronBox constructs the deployer. ` +
        `Validation does not require one and has already run if requested.`,
    );
    this.name = 'DeployerAbsentError';
  }
}

/**
 * The transaction executed and failed, with the TVM's own verdict preserved
 * verbatim (scenario 3). Never thrown for an exhausted wait — that is
 * {@link ConfirmationIndeterminateError}, whose remedy differs.
 */
export class TransactionRevertedError extends DeploymentRefusedError {
  readonly code = 'transaction-reverted';
  constructor(readonly verdict: ConfirmedReverted) {
    super(
      `Transaction ${verdict.transactionHash} executed and failed: the node ` +
        `reports ${verdict.vmResult}` +
        (verdict.vmMessage === null ? '' : ` — "${verdict.vmMessage}"`) +
        `. Nothing was recorded as deployed. The failure is on-chain and ` +
        `re-running without a change will fail the same way.`,
    );
    this.name = 'TransactionRevertedError';
  }
}

/**
 * The gate could not decide within its bound, or the receipt arrived without
 * the one field that affirms success. Carries the hash because the user can
 * check what the plugin could not, and the bound because a refusal that says
 * "timed out" without saying how long invites an immediate identical retry.
 */
export class ConfirmationIndeterminateError extends DeploymentRefusedError {
  readonly code = 'confirmation-indeterminate';
  constructor(readonly verdict: ConfirmationIndeterminate) {
    super(
      verdict.because === 'wait-exhausted'
        ? `Transaction ${verdict.transactionHash} was sent, and no receipt ` +
          `appeared within ${verdict.waitedMs === null ? 'the polling bound' : `${verdict.waitedMs} ms`}. ` +
          `It may still confirm. Check the transaction before retrying — ` +
          `re-sending a transaction that later lands deploys twice.`
        : `Transaction ${verdict.transactionHash} has a receipt that carries ` +
          `no execution verdict, so success cannot be affirmed. This plugin ` +
          `refuses to report success it cannot verify. Inspect the ` +
          `transaction directly before proceeding.`,
    );
    this.name = 'ConfirmationIndeterminateError';
  }
}

/**
 * The identity the authority preflight inspected is not the identity that
 * signed (INV-13). Both are named in canonical form, because the mismatch is
 * the diagnosis and the pair is the evidence.
 */
export class SenderMismatchError extends DeploymentRefusedError {
  readonly code = 'sender-mismatch';
  constructor(
    readonly preflighted: string,
    readonly signed: string,
  ) {
    super(
      `The upgrade-authority check ran against ${preflighted}, but the ` +
        `transaction was signed by ${signed}. The check's answer is about a ` +
        `different account than the one that acted, so the operation stops ` +
        `here. Configure one sending account (\`from\`) so the two agree.`,
    );
    this.name = 'SenderMismatchError';
  }
}

/**
 * The implementation links an external library and no expert opt-out was set
 * (INV-20). The message names the weaker baseline as a requirement of the
 * opt-in, not as politeness: a library address swap changes behavior without
 * changing storage layout, and no other validation catches it.
 */
export class LinkedImplementationRefusedError extends DeploymentRefusedError {
  readonly code = 'linked-implementation-refused';
  constructor(readonly libraries: readonly string[]) {
    super(
      `This implementation links external librar${libraries.length === 1 ? 'y' : 'ies'} ` +
        `${libraries.join(', ')}. Deploying it is refused by default: swapping a ` +
        `linked library's address changes behavior without changing storage ` +
        `layout, and no other validation will catch that. If you accept that ` +
        `risk, set \`unsafeAllow: ['external-library-linking']\` — by opting ` +
        `in you take over verifying every future library address yourself.`,
    );
    this.name = 'LinkedImplementationRefusedError';
  }
}

/**
 * The host's linking flow returned, and the bytecode still carries an
 * unresolved placeholder (INV-21). The host's `link` returns silently when the
 * placeholder it was asked to fill does not exist, so a normal return proves
 * nothing — this error is what makes that silence loud.
 */
export class LinkVerificationFailedError extends DeploymentRefusedError {
  readonly code = 'link-verification-failed';
  constructor(readonly placeholders: readonly string[]) {
    super(
      `After linking, the bytecode still carries unresolved placeholder` +
        `${placeholders.length === 1 ? '' : 's'} ${placeholders.join(', ')}. ` +
        `Deploying it would put a contract on-chain that cannot run. Check ` +
        `that every linked library is deployed and spelled exactly as the ` +
        `implementation imports it.`,
    );
    this.name = 'LinkVerificationFailedError';
  }
}

/**
 * The transaction identity about to be reported was not produced by this run
 * (INV-11): the host took its skip path and handed back a previous
 * deployment's hash — a stale truth, which is harder to spot than a
 * placeholder and is refused for the same reason.
 */
export class StaleTransactionIdentityError extends DeploymentRefusedError {
  readonly code = 'stale-transaction-identity';
  constructor(readonly transactionHash: string) {
    super(
      `The deployment step completed without producing a new transaction: the ` +
        `hash on record (${transactionHash}) predates this run. Reporting it ` +
        `as this run's would claim a deployment that did not happen, so the ` +
        `operation stops instead.`,
    );
    this.name = 'StaleTransactionIdentityError';
  }
}

/**
 * The final constructor argument is a plain object, which the host's deploy
 * action treats as a cheatcode slot and mutates (INV-5) — it destructures
 * `overwrite` off it and forwards the remainder, so the constructor would
 * receive a struct the caller never wrote.
 */
export class CheatcodeSlotCollisionError extends DeploymentRefusedError {
  readonly code = 'cheatcode-slot-collision';
  constructor() {
    super(
      `The last constructor argument is a plain object, and TronBox treats a ` +
        `trailing object as its own options slot: it strips \`overwrite\` and ` +
        `passes the remainder to your constructor, silently altering the ` +
        `argument. Wrap the struct so it is not the final argument — for ` +
        `example, pass it as an array member or add a trailing dummy argument ` +
        `— or restructure the constructor.`,
    );
    this.name = 'CheatcodeSlotCollisionError';
  }
}

/**
 * The seam broke one of its own rules — a queued step tried to settle twice
 * (INV-3), or a bridge was reused. A plugin bug, deliberately outside
 * {@link DeploymentRefusedError}: nothing the user did causes it and no user
 * action remedies it, so it must not be catchable by a handler scoped to
 * refusals.
 */
export class DeploySeamInvariantError extends Error {
  constructor(detail: string) {
    super(
      `Internal error in the deployment seam: ${detail}. This is a bug in ` +
        `@openzeppelin/tronbox-upgrades — please report it.`,
    );
    this.name = 'DeploySeamInvariantError';
  }
}
