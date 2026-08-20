/**
 * The CI-facing surface: safety checks decoupled from switching anything live.
 * Two operations that touch no chain state and open no record, and two that
 * deploy an implementation only — the proxy is never touched by any of them.
 *
 * All four ride the operation toolkit; the validate pair uses its
 * `validate-only` mode, which resolves no chain, no receipts, no scheduling
 * and opens no record — while still configuring the
 * record LOCATION before the engine loads, so a validate call cannot poison a
 * later deploy in the same process.
 */

import type { ContractAbstraction } from '../environment';
import type {
  DeployImplementationOptions,
  PrepareUpgradeOptions,
  ValidateImplementationOptions,
  ValidateUpgradeOptions,
} from '../options/types';
import {
  ConfirmationIndeterminateError,
  TransactionRevertedError,
  serializeOperation,
} from '../deploy';
import { canonicalizeAddress } from '../record';
import { NothingToAdoptError } from '../adopt/errors';
import { BeaconProxyRefusedError } from '../proxy/errors';
import { transactionIdentity, operationNotes } from '../results/types';
import type {
  ImplementationDeployment,
  ValidationOutcome,
} from '../results/types';
import {
  createOperationToolkit,
  handlesFrom,
  HANDLE_OPTION_KEYS,
  readWriteBack,
  readWriteBackHash,
  restoreWriteBack,
  type OperationContext,
  type MigrationHandles,
} from '../proxy/toolkit';

export const VALIDATE_ACCEPTED_OPTIONS = [
  ...HANDLE_OPTION_KEYS,
  'kind',
  'constructorArgs',
  'unsafeAllow',
  'unsafeAllowRenames',
  'unsafeSkipStorageCheck',
  'unsafeAllowCustomTypes',
  'unsafeAllowLinkedLibraries',
] as const;

export const DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS = [
  ...HANDLE_OPTION_KEYS,
  'kind',
  'constructorArgs',
  'unsafeAllow',
  'unsafeAllowRenames',
  'unsafeSkipStorageCheck',
  'unsafeAllowCustomTypes',
  'unsafeAllowLinkedLibraries',
  'redeployImplementation',
  'useDeployedImplementation',
  'timeout',
  'pollingInterval',
] as const;

function nameOf(contract: ContractAbstraction, operation: string): string {
  const name = (contract as { contractName?: unknown }).contractName;
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      `${operation} needs the contract abstraction from artifacts.require(...)`,
    );
  }
  return name;
}

/** Scenario 1: an unsafe pattern refuses with the violations named; nothing is sent. */
export async function runValidateImplementation(
  context: OperationContext,
  contract: ContractAbstraction,
): Promise<ValidationOutcome> {
  const { toolkit, resolved } = context;
  await toolkit.validateImplementation(
    nameOf(contract, 'validateImplementation'),
    resolved,
  );
  return Object.freeze({ notes: operationNotes(toolkit.channel.recorded) });
}

export async function validateImplementation(
  contract: ContractAbstraction,
  options: ValidateImplementationOptions & MigrationHandles = {},
): Promise<ValidationOutcome> {
  return serializeOperation('validateImplementation', options.deployer, async () => {
    const context = await createOperationToolkit({
      handles: handlesFrom(options),
      rawOptions: options,
      acceptedOptions: VALIDATE_ACCEPTED_OPTIONS,
      mode: 'validate-only',
    });
    return runValidateImplementation(context, contract);
  });
}

/**
 * Name-versus-name upgrade validation, with the kind-inference rule the
 * sibling adaptation measured: an omitted `kind` is inferred from the
 * REFERENCE contract, never the candidate — a candidate that dropped its
 * upgrade entry point would self-infer `transparent`, which makes the engine
 * suppress exactly the missing-entry-point error that matters.
 */
export async function runValidateUpgrade(
  context: OperationContext,
  from: ContractAbstraction,
  to: ContractAbstraction,
): Promise<ValidationOutcome> {
  const { toolkit, resolved } = context;
  const reference = await toolkit.validateImplementation(
    nameOf(from, 'validateUpgrade'),
    resolved,
  );
  const kind = resolved.kind ?? (await toolkit.inferKind(reference));
  const candidate = await toolkit.validateImplementation(
    nameOf(to, 'validateUpgrade'),
    { ...resolved, kind },
  );
  await toolkit.assertStorageCompatible(reference.layout, candidate, resolved);
  return Object.freeze({ notes: operationNotes(toolkit.channel.recorded) });
}

export async function validateUpgrade(
  from: ContractAbstraction,
  to: ContractAbstraction,
  options: ValidateUpgradeOptions & MigrationHandles = {},
): Promise<ValidationOutcome> {
  return serializeOperation('validateUpgrade', options.deployer, async () => {
    const context = await createOperationToolkit({
      handles: handlesFrom(options),
      rawOptions: options,
      acceptedOptions: VALIDATE_ACCEPTED_OPTIONS,
      mode: 'validate-only',
    });
    return runValidateUpgrade(context, from, to);
  });
}

async function deployImplementationThroughQueue(
  context: OperationContext,
  contract: ContractAbstraction,
  operation: string,
): Promise<ImplementationDeployment> {
  const { toolkit, resolved } = context;
  const validated = await toolkit.validateImplementation(
    nameOf(contract, operation),
    resolved,
  );
  const deployer = toolkit.requireDeployer();

  const outcome = await toolkit.queue(deployer, async () => {
    let writeBack: { address: string; transactionHash: string } | null = null;
    // Captured before the deploy callback can run, so a reverted confirmation
    // has the pre-deploy write-back to put back.
    const priorWriteBack = readWriteBack(contract);
    const implementationAddress = await toolkit.fetchOrDeployImplementation(
      validated,
      resolved,
      async () => {
        writeBack = await toolkit.hostDeploy(contract, [
          ...resolved.constructorArgs,
        ]);
        return writeBack;
      },
    );
    if (writeBack !== null) {
      const fresh: { address: string; transactionHash: string } = writeBack;
      const verdict = await toolkit.confirm(fresh.transactionHash);
      if (verdict.kind === 'reverted') {
        // Nothing was deployed. The user's own artifact must not keep naming
        // this address — the host persists that entry after the migration.
        restoreWriteBack(contract, priorWriteBack);
        throw new TransactionRevertedError(verdict);
      }
      if (verdict.kind === 'indeterminate') {
        // The implementation may be live at `fresh.address`; the refusal names it
        // so the user can check rather than redeploy blind. Canonicalized like
        // every other `spent` construction — the host returns its own spelling,
        // and the structured field's contract is the canonical form (review
        // comment on #18).
        throw new ConfirmationIndeterminateError(verdict, {
          address: canonicalizeAddress(fresh.address),
          transactionHash: fresh.transactionHash,
        });
      }
      return { implementationAddress, transactionHash: fresh.transactionHash };
    }
    // Replay (scenario 4): the record vouched for an unchanged implementation,
    // nothing was deployed, and the identity reported is the recorded one.
    return {
      implementationAddress,
      transactionHash: readWriteBackHash(contract),
    };
  });

  return Object.freeze({
    address: outcome.implementationAddress,
    transaction: transactionIdentity(outcome.transactionHash, operation),
    notes: operationNotes(toolkit.channel.recorded),
  }) as unknown as ImplementationDeployment;
}

/** Deploys (or reuses) the implementation alone. The proxy layer is untouched. */
export async function runDeployImplementation(
  context: OperationContext,
  contract: ContractAbstraction,
): Promise<ImplementationDeployment> {
  return deployImplementationThroughQueue(context, contract, 'deployImplementation');
}

export async function deployImplementation(
  contract: ContractAbstraction,
  options: DeployImplementationOptions & MigrationHandles = {},
): Promise<ImplementationDeployment> {
  return serializeOperation('deployImplementation', options.deployer, async () => {
    const context = await createOperationToolkit({
      handles: handlesFrom(options),
      rawOptions: options,
      acceptedOptions: DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS,
    });
    return runDeployImplementation(context, contract);
  });
}

/**
 * Prepares an upgrade: validates the candidate against the layout of the
 * implementation CURRENTLY installed at the proxy (chain-read, never
 * name-guessed) and WITH that proxy's recorded kind (never inferred from
 * the candidate), deploys only the new implementation, and never touches the
 * proxy (scenario 2) — the switch stays a later governance action.
 */
export async function runPrepareUpgrade(
  context: OperationContext,
  proxyAddress: string,
  contract: ContractAbstraction,
): Promise<ImplementationDeployment> {
  const { toolkit, resolved } = context;
  const proxy = canonicalizeAddress(proxyAddress);

  // A caller-chosen kind is narrowed BEFORE any chain read: `'beacon'` is in
  // the option's closed set, and upstream filters the missing-entry-point
  // error for it exactly as for transparent (`dist/validate/overrides.js:
  // 86-88`) — honoring it would reopen the hole this kind resolution exists
  // to close. Same narrowing `deployProxy` applies to its own kind.
  if (resolved.kind !== undefined) {
    // Imported lazily, as `deployProxy` does: `options/resolve` reaches the
    // engine at import time, and this module sits in the entry's static
    // closure — a static import here would load the engine before the record
    // location is configured (the exact hazard the module header names).
    const { requireProxyKind } = await import('../options/resolve');
    requireProxyKind(resolved.kind, ['transparent', 'uups'], 'prepareUpgrade');
  }

  // Slots are read BEFORE validation — the reverse of `runUpgradeProxy`'s
  // ordering — because the kind must exist when `getErrors` judges the
  // candidate, and `processProxyKind` cannot run before the validation it
  // consumes. One non-raising slot read, as there: the per-slot readers
  // raise on an empty slot, measured live. The three refusals below are
  // chain facts no record can overrule.
  const slots = await toolkit.proxySlots(proxy);
  if (slots.kind === 'no-code') {
    throw new NothingToAdoptError(proxy);
  }
  if (slots.beacon !== null) {
    throw new BeaconProxyRefusedError(proxy, slots.beacon);
  }
  if (slots.implementation === null) {
    throw new NothingToAdoptError(
      proxy,
      'code with an empty 1967 implementation slot — not a proxy this plugin can prepare an upgrade for',
    );
  }
  // The kind comes from the proxy's own RECORD, the way upstream's
  // `setProxyKind` reads it — never inferred from the candidate (a candidate
  // that dropped its upgrade entry point self-infers `transparent`, which
  // makes the engine suppress exactly the missing-entry-point error that
  // matters; `runValidateUpgrade` above states the same rule for a contract
  // reference). Every proxy this plugin deploys or imports is recorded with
  // its kind, and this operation already requires registration — the layout
  // lookup below refuses unregistered references toward force-import — so a
  // record is not an extra demand. An omitted option uses the recorded kind;
  // an explicit option that contradicts the record REFUSES rather than
  // overriding it, because the override is itself the bricking path: kind
  // `transparent` against a uups proxy filters the missing-entry-point
  // judgement (review comment on #20).
  const record = await toolkit.session.getProxyRecord(proxy);
  if (record === undefined) {
    throw new Error(
      `No recorded proxy at ${proxy}. Register the deployment first with ` +
        'forceImport, or upgrade from the plugin that deployed it.',
    );
  }
  if (record.kind === 'beacon') {
    // Unreachable through this plugin's own writes (a beacon proxy is
    // recorded by its beacon, never as a proxy record), but the manifest is
    // a file a user can edit.
    throw new Error(
      `The recorded kind for ${proxy} is beacon — upgrade its beacon with ` +
        'upgradeBeacon instead.',
    );
  }
  if (resolved.kind !== undefined && resolved.kind !== record.kind) {
    throw new Error(
      `Requested an upgrade of kind ${resolved.kind} but proxy is ${record.kind}`,
    );
  }
  const kind = record.kind;
  // Threaded through the CONTEXT so the second validation inside
  // `deployImplementationThroughQueue` judges with the same kind.
  const bound: OperationContext = {
    ...context,
    resolved: { ...resolved, kind },
  };

  const validated = await toolkit.validateImplementation(
    nameOf(contract, 'prepareUpgrade'),
    bound.resolved,
  );
  toolkit.requireDeployer();

  // Scenario 3 rides storedLayoutFor's own refusal: an unregistered reference
  // names force-import as the escape hatch rather than failing opaquely.
  const currentLayout = await toolkit.storedLayoutFor(slots.implementation);
  await toolkit.assertStorageCompatible(currentLayout, validated, bound.resolved);

  return deployImplementationThroughQueue(bound, contract, 'prepareUpgrade');
}

export async function prepareUpgrade(
  proxyAddress: string,
  contract: ContractAbstraction,
  options: PrepareUpgradeOptions & MigrationHandles = {},
): Promise<ImplementationDeployment> {
  return serializeOperation('prepareUpgrade', options.deployer, async () => {
    const context = await createOperationToolkit({
      handles: handlesFrom(options),
      rawOptions: options,
      acceptedOptions: DEPLOY_IMPLEMENTATION_ACCEPTED_OPTIONS,
    });
    return runPrepareUpgrade(context, proxyAddress, contract);
  });
}
