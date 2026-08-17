/**
 * The admin surface, v5-correct: one operation. A v5 transparent proxy's
 * admin is its own immutable ProxyAdmin, so "change the admin" is not a thing
 * that can work — what transfers is the ProxyAdmin's OWNERSHIP, and this is
 * that transfer, with the pre-read that keeps a replay from surfacing as an
 * opaque on-chain revert.
 */

import type { ContractAbstraction } from '../environment';
import type { TransferProxyAdminOwnershipOptions } from '../options/types';
import { canonicalizeAddress } from '../record';
import {
  ConfirmationIndeterminateError,
  TransactionRevertedError,
} from '../deploy';
import { transactionIdentity, operationNotes } from '../results/types';
import type { AuthorityTransfer } from '../results/types';
import { NotTransparentProxyError } from '../proxy/errors';
import {
  createOperationToolkit,
  handlesFrom,
  HANDLE_OPTION_KEYS,
  type OperationContext,
  type MigrationHandles,
} from '../proxy/toolkit';
import {
  AuthorityAlreadyTransferredError,
  AuthorityVerificationFailedError,
} from './errors';

export const TRANSFER_OWNERSHIP_ACCEPTED_OPTIONS = [
  ...HANDLE_OPTION_KEYS,
  'timeout',
  'pollingInterval',
] as const;

/** The pipeline over an already-built toolkit. Exported for the tests. */
export async function runTransferProxyAdminOwnership(
  context: OperationContext,
  proxy: string,
  newOwner: string,
): Promise<AuthorityTransfer> {
  const { toolkit } = context;
  const proxyAddress = canonicalizeAddress(proxy);
  const targetOwner = canonicalizeAddress(newOwner);

  // An empty admin slot refuses before anything else. The batched
  // read, because the per-slot reader raises on an empty slot (measured).
  const slots = await toolkit.proxySlots(proxyAddress);
  if (slots.kind === 'no-code' || slots.admin === null) {
    throw new NotTransparentProxyError(proxyAddress);
  }
  const adminAddress = canonicalizeAddress(slots.admin);

  // The pre-read (scenario 3). Nothing sends when it already answers.
  const currentOwner = await toolkit.ownerOf(adminAddress);
  if (currentOwner !== null && currentOwner === targetOwner) {
    // Already transferred: a declared no-op naming the holder — the replay
    // disposition, documented next to the operation.
    return Object.freeze({
      proxy: proxyAddress,
      previousOwner: currentOwner,
      newOwner: targetOwner,
      transaction: null,
      alreadyHeld: true,
      notes: operationNotes(toolkit.channel.recorded),
    }) as unknown as AuthorityTransfer;
  }
  const sender = toolkit.resolveSender();
  if (
    currentOwner !== null &&
    sender.kind === 'resolved' &&
    currentOwner !== canonicalizeAddress(sender.address)
  ) {
    throw new AuthorityAlreadyTransferredError(
      proxyAddress,
      currentOwner,
      targetOwner,
    );
  }

  const deployer = toolkit.requireDeployer();

  // One queued step: send, confirm, verify.
  const outcome = await toolkit.queue(deployer, async () => {
    const writeBack = await toolkit.callThroughFacade({
      facadeName: 'ProxyAdmin',
      at: adminAddress,
      method: 'transferOwnership',
      args: [targetOwner],
    });

    const verdict = await toolkit.confirm(writeBack.transactionHash);
    if (verdict.kind === 'reverted') {
      throw new TransactionRevertedError(verdict);
    }
    if (verdict.kind === 'indeterminate') {
      throw new ConfirmationIndeterminateError(verdict);
    }

    // The verify re-read, canonical and unconditional (scenario 1's
    // "actually surfacing": success is the chain's answer, not the receipt's).
    const observed = await toolkit.ownerOf(adminAddress);
    if (observed !== targetOwner) {
      throw new AuthorityVerificationFailedError(
        proxyAddress,
        targetOwner,
        observed ?? 'nothing that answers owner()',
      );
    }

    return writeBack;
  });

  return Object.freeze({
    proxy: proxyAddress,
    previousOwner: currentOwner,
    newOwner: targetOwner,
    transaction: transactionIdentity(
      outcome.transactionHash,
      'transferProxyAdminOwnership',
    ),
    alreadyHeld: false,
    notes: operationNotes(toolkit.channel.recorded),
  }) as unknown as AuthorityTransfer;
}

export async function transferProxyAdminOwnership(
  proxy: string,
  newOwner: string,
  options: TransferProxyAdminOwnershipOptions & MigrationHandles = {},
): Promise<AuthorityTransfer> {
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: TRANSFER_OWNERSHIP_ACCEPTED_OPTIONS,
  });
  return runTransferProxyAdminOwnership(context, proxy, newOwner);
}

export type { ContractAbstraction };
