/**
 * The adoption refusal family: one class per cause, structured fields, the
 * message rendered here.
 */

import { ProxyOperationRefusedError } from '../proxy/errors';

/** Scenario 2: nothing adoptable at the address, named. */
export class NothingToAdoptError extends ProxyOperationRefusedError {
  readonly code = 'nothing-to-adopt';
  constructor(
    readonly address: string,
    readonly found: string = 'no code at all',
  ) {
    super(
      `Nothing to import at ${address}: found ${found}. forceImport adopts a ` +
        `proxy, a beacon, or a deployed implementation — check the address and ` +
        `the network you are connected to.`,
    );
    this.name = 'NothingToAdoptError';
  }
}

/**
 * Scenario 3: the on-chain code is not the named contract. Refused by
 * name because recording a plausible-looking wrong baseline silently corrupts
 * every later safety check.
 */
export class AdoptionVerificationFailedError extends ProxyOperationRefusedError {
  readonly code = 'adoption-verification-failed';
  constructor(
    readonly address: string,
    readonly because: string,
  ) {
    super(`Refusing to import ${address}: ${because}.`);
    this.name = 'AdoptionVerificationFailedError';
  }
}

/** Scenario 6: the caller's kind contradicts the chain's, named both ways. */
export class AdoptionKindMismatchError extends ProxyOperationRefusedError {
  readonly code = 'adoption-kind-mismatch';
  constructor(
    readonly address: string,
    readonly foundKind: string,
    readonly expectedKind: string,
  ) {
    super(
      `The contract at ${address} is ${foundKind} on-chain, but ${expectedKind} ` +
        `was expected. Recording it under the wrong kind would corrupt the ` +
        `upgrade baseline, so nothing was recorded.`,
    );
    this.name = 'AdoptionKindMismatchError';
  }
}
