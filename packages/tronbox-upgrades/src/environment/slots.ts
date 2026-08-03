import type {
  HandleName,
  InvocationContextName,
  SlotName,
} from './types';

export interface SlotRequirement {
  readonly handles: readonly HandleName[];
  readonly providedIn: readonly InvocationContextName[];
  readonly absentIn: readonly InvocationContextName[];
}

export const slotNames = Object.freeze([
  'paths',
  'network',
  'artifacts',
  'chain',
  'receipts',
  'scheduling',
  'output',
  'compiler',
] as const satisfies readonly SlotName[]);

const allContexts = Object.freeze([
  'tronbox migrate',
  'tronbox test migration phase',
  'tronbox test mocha files',
  'tronbox console',
  'plain node',
] as const satisfies readonly InvocationContextName[]);

function contextsExcept(
  providedIn: readonly InvocationContextName[],
): readonly InvocationContextName[] {
  return Object.freeze(
    allContexts.filter(context => !providedIn.includes(context)),
  );
}

function requirement(
  handles: readonly HandleName[],
  providedIn: readonly InvocationContextName[],
): SlotRequirement {
  return Object.freeze({
    handles: Object.freeze([...handles]),
    providedIn: Object.freeze([...providedIn]),
    absentIn: contextsExcept(providedIn),
  });
}

const configContexts = Object.freeze([
  'tronbox migrate',
  'tronbox test migration phase',
  'tronbox test mocha files',
] as const satisfies readonly InvocationContextName[]);

const chainContexts = Object.freeze([
  'tronbox migrate',
  'tronbox test migration phase',
  'tronbox test mocha files',
  'tronbox console',
] as const satisfies readonly InvocationContextName[]);

const deployerContexts = Object.freeze([
  'tronbox migrate',
  'tronbox test migration phase',
] as const satisfies readonly InvocationContextName[]);

export const slotRequirements: Readonly<Record<SlotName, SlotRequirement>> =
  Object.freeze({
    paths: requirement(['deployer', 'artifacts'], configContexts),
    network: requirement(['deployer', 'artifacts'], configContexts),
    artifacts: requirement(['artifacts'], configContexts),
    chain: requirement(['tronWrap', 'tronWeb'], chainContexts),
    receipts: requirement(['waitForTransactionReceipt'], configContexts),
    scheduling: requirement(['deployer'], deployerContexts),

    // `output` is satisfied by *either* bearing handle, so its context set is
    // `paths`/`network`'s — mocha files included. It carried `deployerContexts`,
    // which contradicted its own `handles` list: no logger *global* is injected
    // under `tronbox test` mocha files, but the slot never needed one, because
    // `outputFromHandles` falls back to the `logger` on the Config lineage
    // reached through `artifacts`, and that Config is live there.
    //
    // Design revision 2, Decision 13: the table was internally inconsistent and
    // either edit would have restored consistency, so widening needed a reason.
    // The inconsistency is a *reporting* error, not a capability error — the
    // seam does construct the slot from either handle, and the table exists to
    // describe what the seam does. Narrowing `handles` to `['deployer']` was
    // rejected because it would have decided SF-4's open mocha-scope question by
    // omission: an operation wanting a channel there would have had no slot to
    // declare. `handles` is therefore unchanged.
    output: requirement(['deployer', 'artifacts'], configContexts),

    // Purely lineage-derived, so it reads `paths`/`network`'s row exactly: the
    // compiler configuration lives on the `Config`, and wherever a Config lineage
    // is reachable this slot is constructible. `tronbox console` is absent for the
    // same reason it is absent there — no lineage-bearing handle is injected —
    // even though a console session's own Config carries the same keys.
    compiler: requirement(['deployer', 'artifacts'], configContexts),
  });
