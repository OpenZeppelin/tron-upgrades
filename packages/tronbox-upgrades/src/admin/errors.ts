/**
 * The admin-surface refusals (the family pattern: one class per cause,
 * structured fields, the message rendered here).
 */

import { ProxyOperationRefusedError } from '../proxy/errors';

/**
 * Scenario 3's refusal arm: the authority is held by someone who is neither
 * the configured sender nor the requested target — a transfer this account
 * cannot perform, named instead of surfacing as an opaque on-chain revert.
 */
export class AuthorityAlreadyTransferredError extends ProxyOperationRefusedError {
  readonly code = 'authority-already-transferred';
  constructor(
    readonly proxyAddress: string,
    readonly currentHolder: string,
    readonly requestedOwner: string,
  ) {
    super(
      `The upgrade authority for proxy ${proxyAddress} is held by ` +
        `${currentHolder}, not by the configured account — a transfer to ` +
        `${requestedOwner} cannot be performed from here. If an earlier run ` +
        `already transferred it, this is that transfer's result; otherwise the ` +
        `holder has to perform the transfer.`,
    );
    this.name = 'AuthorityAlreadyTransferredError';
  }
}

/**
 * The transfer confirmed and the chain does not answer with the new owner —
 * success is the chain's answer, never the receipt's.
 */
export class AuthorityVerificationFailedError extends ProxyOperationRefusedError {
  readonly code = 'authority-verification-failed';
  constructor(
    readonly proxyAddress: string,
    readonly expected: string,
    readonly observed: string,
  ) {
    super(
      `The ownership transfer for proxy ${proxyAddress}'s admin confirmed, but ` +
        `owner() answers ${observed} where ${expected} was expected. The ` +
        `authority's actual holder is unverified — investigate before relying ` +
        `on either account.`,
    );
    this.name = 'AuthorityVerificationFailedError';
  }
}
