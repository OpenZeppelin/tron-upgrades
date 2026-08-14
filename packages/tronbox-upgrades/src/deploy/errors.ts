/**
 * The deployment seam's refusal family: one closed hierarchy, one class per
 * cause, each with its own remedy. Causes with different user remedies
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
 * What already exists on-chain when a refusal fires *after* the spend.
 *
 * The rule this type serves: **every refusal that can fire after an irreversible
 * on-chain success must name the on-chain fact and the recovery.** A refusal that
 * withholds the address is the worst possible one — the recovery tool takes the
 * address as its argument, so the message that stops the run is also the message
 * that hides what the user needs to fix it.
 *
 * Optional at every constructor that takes it, and that is not laxity: the same
 * classes fire *before* any spend on other paths, where there is no address to
 * name and inventing one would be worse than omitting it. Absent means "nothing
 * was spent", which is a claim, not a gap.
 */
export interface SpentDeployment {
  /** The address the host reported for the deploy. Canonical form. */
  readonly address: string;
  /** The deploy's transaction hash. */
  readonly transactionHash: string;
}

/**
 * The recovery sentence, written once. `forceImport` is the tool in every case
 * because it is the only one that takes an existing address and teaches the
 * record about it.
 */
function adoptClause(spent: SpentDeployment): string {
  return (
    `The contract is at ${spent.address} (transaction ` +
    `${spent.transactionHash}). Nothing here removes it. Once the cause above ` +
    `is resolved, record it with forceImport('${spent.address}') rather than ` +
    `deploying a second one.`
  );
}

/**
 * A state-changing operation was invoked in a context that provides no
 * deployer, and the refusal names exactly what is missing. Validation
 * in the same context does not refuse — it degrades, because it can. Deployment
 * refuses because there is nothing to send the transaction through.
 */
export class DeployerAbsentError extends DeploymentRefusedError {
  readonly code = 'deployer-absent';
  constructor(readonly missingHandle: 'deployer' | 'scheduling') {
    super(
      `This operation sends a transaction, but the ${missingHandle} handle is ` +
        `missing, so there is no deployer to send it through. Run it from a migration ` +
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
 *
 * The message says what this failure did *not* record rather than claiming
 * nothing was recorded at all: on the proxy and beacon paths the engine deploys
 * and records the implementation before this transaction is ever sent
 * (`proxy/deploy-proxy.ts`, inside the queued step), so "nothing was recorded"
 * was false exactly where the operation spends the most.
 */
export class TransactionRevertedError extends DeploymentRefusedError {
  readonly code = 'transaction-reverted';
  constructor(readonly verdict: ConfirmedReverted) {
    super(
      `Transaction ${verdict.transactionHash} executed and failed: the node ` +
        `reports ${verdict.vmResult}` +
        (verdict.vmMessage === null ? '' : ` — "${verdict.vmMessage}"`) +
        `. This transaction recorded nothing. An implementation the same ` +
        `operation deployed before sending it may already be in the upgrades ` +
        `record — that entry is valid and a later run reuses it rather than ` +
        `deploying it again. The failure is on-chain and re-running without a ` +
        `change will fail the same way.`,
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
  constructor(
    readonly verdict: ConfirmationIndeterminate,
    /**
     * Present where the indeterminate transaction was a DEPLOY, and phrased
     * conditionally below because that is the honest shape: indeterminate means
     * this plugin does not know whether it landed. The address is known either
     * way — the host reports it when `.new()` resolves — and naming it is what
     * turns "check the transaction" into something the user can act on.
     *
     * This is also why the write-back is deliberately *not* undone for an
     * indeterminate verdict, unlike a mined revert: the deployment may be real,
     * and erasing a real one is the worse failure.
     */
    readonly spent?: SpentDeployment,
  ) {
    super(
      (verdict.because === 'wait-exhausted'
        ? `Transaction ${verdict.transactionHash} was sent, and no receipt ` +
          `appeared within ${verdict.waitedMs === null ? 'the polling bound' : `${verdict.waitedMs} ms`}. ` +
          `It may still confirm. Check the transaction before retrying — ` +
          `re-sending a transaction that later lands deploys twice.`
        : `Transaction ${verdict.transactionHash} has a receipt that carries ` +
          `no execution verdict, so success cannot be affirmed. This plugin ` +
          `refuses to report success it cannot verify. Inspect the ` +
          `transaction directly before proceeding.`) +
        (spent === undefined
          ? ''
          : `\n\nIf it did land, the contract is at ${spent.address}: adopt it ` +
            `with forceImport('${spent.address}') rather than deploying again. ` +
            `The artifact's entry for it is left in place on purpose, for the ` +
            `same reason — it may name a real deployment.`),
    );
    this.name = 'ConfirmationIndeterminateError';
  }
}

/**
 * The identity the authority preflight inspected is not the identity that
 * signed. Both are named in canonical form, because the mismatch is
 * the diagnosis and the pair is the evidence.
 */
export class SenderMismatchError extends DeploymentRefusedError {
  readonly code = 'sender-mismatch';
  constructor(
    readonly preflighted: string,
    readonly signed: string,
    /**
     * Present on `deployProxy`'s path, where this check runs *after* the proxy
     * is deployed and confirmed. Withholding it was the sharpest form of the
     * post-spend problem: the refusal told the user their accounts disagree
     * while hiding the address of the proxy they had just paid for, which is the
     * one argument the recovery needs.
     */
    readonly spent?: SpentDeployment,
  ) {
    super(
      `The upgrade-authority check ran against ${preflighted}, but the ` +
        `transaction was signed by ${signed}. The check's answer is about a ` +
        `different account than the one that acted, so the operation stops ` +
        `here. Configure one sending account (\`from\`) so the two agree.` +
        (spent === undefined ? '' : `\n\n${adoptClause(spent)}`),
    );
    this.name = 'SenderMismatchError';
  }
}

/**
 * The implementation links an external library and no expert opt-out was set.
 * The message names the weaker baseline as a requirement of the
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
 * unresolved placeholder. The host's `link` returns silently when the
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
 * The transaction identity about to be reported was not produced by this run:
 * the host took its skip path and handed back a previous
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
 * The final constructor argument is one of two shapes this seam refuses
 * outright, verified per-shape against both installed TronBox minors
 * (`tronbox-4.8.0` and `tronbox-4.9.0`, `Contract/contract.js`):
 *
 * - `'plain-object'`: a trailing non-array object. TronBox's contract layer
 *   treats it as its own energy-parameter slot, never as part of the
 *   constructor call: `filterEnergyParameter` pops the argument off the list
 *   entirely and mines it for the keys it recognizes (`feeLimit`,
 *   `originEnergyLimit`, and the rest of `constants.deployParameters`) — the
 *   constructor never sees the struct, and everything else in it is
 *   discarded. Identical on both minors. Usually a loud arity mismatch;
 *   silent exactly when the real constructor also expects that many
 *   arguments once the struct is gone.
 * - `'null'`: a trailing `null`. `typeof null === 'object'`, so
 *   `filterEnergyParameter` takes the SAME branch as a plain object — but the
 *   two minors diverge from there: 4.8.0 has no null check and crashes inside
 *   `filterEnergyParameter` itself (`Object.keys(null)` throws a bare
 *   `TypeError`, before any deploy attempt); 4.9.0 added a null check and
 *   passes `null` through to the constructor untouched, where the ABI
 *   encoder's behavior depends on the parameter's type — most types throw a
 *   clear-but-unnamed encoding error, but a `bool` parameter silently
 *   coerces `null` to `false` (measured: `ethers.AbiCoder`). No installed
 *   version turns a trailing `null` into a reliable, correct deploy.
 */
export class CheatcodeSlotCollisionError extends DeploymentRefusedError {
  readonly code = 'cheatcode-slot-collision';
  constructor(readonly because: 'plain-object' | 'null' = 'plain-object') {
    super(
      because === 'plain-object'
        ? `The last constructor argument is a plain object, and TronBox treats a ` +
          `trailing non-array object as its own energy-parameter slot: it pops ` +
          `the argument off the constructor call entirely and mines it for the ` +
          `deploy parameters it recognizes (fee limit, origin energy limit, and ` +
          `the like) — your constructor never receives it, usually as a loud ` +
          `arity mismatch, silently only when the real constructor happens to ` +
          `expect that many arguments once the struct is gone. Wrap the struct ` +
          `so it is not the final argument — for example, pass it as an array ` +
          `member or add a trailing dummy argument — or restructure the ` +
          `constructor.`
        : `The last constructor argument is \`null\`. TronBox's contract layer ` +
          `takes it down the same path as a plain object (\`typeof null === ` +
          `'object'\`), and the installed host versions disagree on where that ` +
          `leads: one crashes internally before any deploy is attempted, the ` +
          `other passes \`null\` through to your constructor, where the result ` +
          `depends on the parameter's type and is never something this plugin ` +
          `can vouch for. Pass the actual value your constructor expects ` +
          `instead of \`null\`.`,
    );
    this.name = 'CheatcodeSlotCollisionError';
  }
}

/**
 * The seam broke one of its own rules — a queued step tried to settle twice,
 * or a bridge was reused. A plugin bug, deliberately outside
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
