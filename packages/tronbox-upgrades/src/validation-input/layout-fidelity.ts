import type { SolcStandardOutput } from './solc-input';

/*
 * ============================================================================
 * ⛔ BOTH INSTRUMENTS IN THIS MODULE ARE WRONG AS WRITTEN. DO NOT REUSE EITHER
 *    WITHOUT REWORKING IT. (Recorded 2026-08-03, when validation moved to lazy
 *    compilation and retired the premise both instruments were built on.)
 * ============================================================================
 *
 * This module was written when the plugin ALWAYS ran its own compile and always
 * asked for `storageLayout`. That premise is retired: validation now compiles
 * **lazily**, by design — AST-only when the host's build record is fresh, and
 * a single-contract compile only when it is stale, absent, or when AST-only
 * refuses on a shape needing slot positions.
 *
 * Under an input that was NOT produced by our own storageLayout-requesting
 * compile, the two functions below fail in OPPOSITE directions:
 *
 *   • `detectFidelity` returns `{kind:'slot-level'}` for EVERY contract — a
 *     permissive mislabel, and verbatim the violation scenario INV-49 exists to
 *     prevent. It reports full slot fidelity for an input that has none.
 *
 *   • `isLayoutVacuous` returns `true` for EVERY contract — firing cause 9
 *     (`layout-vacuous`, "report a bug, this is ours") on every validation.
 *
 * **Two instruments inverting in opposite directions is worse than either
 * alone, because whoever resurrects this module will trust one of them.** One
 * says everything is fine; the other says everything is broken; neither is
 * measuring what it claims.
 *
 * The root cause is a single retired premise, stated in the doc comment below:
 * "inside SUPPORTED_SOLC the key is always emitted." That was true only BECAUSE
 * WE ASKED. It says nothing about an artifact or build record we did not
 * produce.
 *
 * The correct subject is upgrades-core's PRODUCED layout, not our solc output:
 * `storage[].slot === undefined`, or `flat === false`. `dist/storage/extract.js`
 * reconstructs from the AST at :62-79 pushing no `slot` and no `offset` and
 * leaving `flat: false`, versus :58 which pushes `{label, offset, slot, …}` and
 * sets `flat = true`. INV-49 already names that shape.
 * ============================================================================
 */

/**
 * The hand-rolled `hasLayout` detector, and the vacuous-layout check.
 *
 * **Hand-rolled because upgrades-core does not expose the predicate.** C2
 * re-measured it: `'hasLayout' in require('@openzeppelin/upgrades-core')` is
 * `false`, while thirteen other names are `true`. The predicate exists internally
 * at `dist/storage/layout.js:6,49` (Research cited `dist/storage/extract.js:49`,
 * which is a different line) and is consumed at `dist/storage/compare.js:162`. So
 * this reads a field the package does not version-guarantee, which is why INV-49
 * pins the shape with a canary rather than trusting it.
 *
 * **And reduced fidelity is unobservable from the engine, which is the whole
 * reason this module exists** (G4). `dist/storage/index.js:57` notices the
 * condition — `original.storage.some(item => item.slot === undefined) || …` — and
 * its only action is `validateBaseSlotUnchanged`: no warning, no note, no flag on
 * the report. Measured, `getStorageUpgradeReport(thin, thin)` has one own key and
 * `explain()` returns `""`. If nothing here detected it, a leniency flip would
 * produce a plugin that proceeds silently, which is SC-003 violated by the flip
 * itself.
 */

/** Reads `storage[].slot === undefined` — pinned by test, not trusted (INV-49). */
export type LayoutFidelity =
  | { readonly kind: 'slot-level' }
  | {
      readonly kind: 'declaration-order-only';
      /** Fully-qualified names whose layout carried no slots. Never empty. */
      readonly missingFor: readonly string[];
    };

interface StorageItemShape {
  readonly slot?: unknown;
}

interface StorageLayoutShape {
  readonly storage?: readonly StorageItemShape[];
}

function layoutOf(
  output: SolcStandardOutput,
  source: string,
  contract: string,
): StorageLayoutShape | undefined {
  const layout: unknown = output.contracts?.[source]?.[contract]?.storageLayout;
  return typeof layout === 'object' && layout !== null
    ? (layout as StorageLayoutShape)
    : undefined;
}

/**
 * Runs on **every** produced input, not only when degradation is suspected
 * (D1 item 2, INV-3).
 *
 * This is the part that is easy to get backwards, and Design says why: *v1's
 * assertion is the thing a flip relaxes, not the thing a flip adds.* Calling this
 * only inside the `refused` branch as an optimisation would let the flip test pass
 * while production never ran the detector — and the day the table flips, a
 * reduced-fidelity input ships reading `slot-level`, silently.
 *
 * **Scope: layouts that are present.** A contract whose `storageLayout` key is
 * absent entirely is *not* counted here, and the boundary is deliberate. Inside
 * `SUPPORTED_SOLC` the key is always emitted — Research measured it present even
 * when empty, `{"storage":[],"types":null}` for a purely-namespaced contract — and
 * F-5's silent-omission hazard lives strictly below `0.5.13`, which INV-15's gate
 * makes unreachable. Absence for the **contract under validation** is not a
 * fidelity question at all: it is cause 9, decided by
 * {@link isLayoutVacuous} below. Counting absent layouts here instead would turn
 * an unverified assumption about what solc emits for interfaces into an invariant
 * error on every project.
 */
export function detectFidelity(output: SolcStandardOutput): LayoutFidelity {
  const missingFor: string[] = [];

  for (const [source, contracts] of Object.entries(output.contracts ?? {})) {
    for (const contract of Object.keys(contracts)) {
      const layout = layoutOf(output, source, contract);
      if (layout === undefined) {
        continue;
      }
      const storage = layout.storage ?? [];
      if (storage.some(item => item.slot === undefined)) {
        missingFor.push(`${source}:${contract}`);
      }
    }
  }

  return missingFor.length === 0
    ? { kind: 'slot-level' }
    : { kind: 'declaration-order-only', missingFor: Object.freeze(missingFor) };
}

/**
 * Whether the layout for the contract under validation says nothing.
 *
 * Absent or empty are the same answer here: both hand upgrades-core a reference
 * layout with no entries, and F-4 measured that an empty *original* layout
 * classifies every variable in the new contract as a safe append —
 * `getStorageUpgradeErrors(EMPTY_original, real_updated)` returns no errors and
 * `assertStorageUpgradeSafe(EMPTY, real)` does not throw.
 */
export function isLayoutVacuous(
  output: SolcStandardOutput,
  source: string,
  contract: string,
): boolean {
  const layout = layoutOf(output, source, contract);
  return layout === undefined || (layout.storage ?? []).length === 0;
}

/**
 * The AST shapes this module reads, declared structurally.
 *
 * Deliberately **not** imported from `solidity-ast`, even though upstream's
 * `SolcOutput.sources[file].ast` is typed as its `SourceUnit`: that package is a
 * transitive dependency of `@openzeppelin/upgrades-core` and not a declared
 * dependency of this one, so importing its types would make this package's
 * compilation depend on hoisting.
 */
interface AstNode {
  readonly nodeType?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly nodes?: readonly AstNode[];
  readonly linearizedBaseContracts?: readonly unknown[];
  readonly stateVariable?: unknown;
  readonly constant?: unknown;
  readonly mutability?: unknown;
}

function astNodes(output: SolcStandardOutput, source: string): readonly AstNode[] {
  const ast: unknown = output.sources?.[source]?.ast;
  if (typeof ast !== 'object' || ast === null) {
    return [];
  }
  const nodes = (ast as AstNode).nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function contractDefinitions(
  output: SolcStandardOutput,
): Map<number, AstNode> {
  const byId = new Map<number, AstNode>();
  for (const source of Object.keys(output.sources ?? {})) {
    for (const node of astNodes(output, source)) {
      if (node.nodeType === 'ContractDefinition' && typeof node.id === 'number') {
        byId.set(node.id, node);
      }
    }
  }
  return byId;
}

/**
 * How many state variables occupy storage in this contract, inherited ones
 * included.
 *
 * Cause 9's payload, and the count is what makes the cause honest rather than
 * paranoid: a contract that genuinely declares nothing has an empty layout
 * legitimately, so the refusal fires only when the layout is empty **and** the AST
 * says it should not be.
 *
 * Three exclusions, all because they occupy no slot: `constant` variables,
 * `immutable` ones, and anything that is not a state variable. Inheritance is
 * walked through `linearizedBaseContracts` because a contract with no variables of
 * its own inherits a non-empty layout, and counting only its own would let the
 * vacuous case through for every derived contract in the ecosystem.
 */
export function countDeclaredStateVariables(
  output: SolcStandardOutput,
  source: string,
  contract: string,
): number {
  const definitions = contractDefinitions(output);
  const target = astNodes(output, source).find(
    node => node.nodeType === 'ContractDefinition' && node.name === contract,
  );
  if (target === undefined) {
    return 0;
  }

  const bases = Array.isArray(target.linearizedBaseContracts)
    ? target.linearizedBaseContracts
    : [target.id];

  let count = 0;
  for (const baseId of bases) {
    const base = typeof baseId === 'number' ? definitions.get(baseId) : undefined;
    for (const member of base?.nodes ?? []) {
      if (
        member.nodeType === 'VariableDeclaration' &&
        member.stateVariable === true &&
        member.constant !== true &&
        member.mutability !== 'immutable'
      ) {
        count += 1;
      }
    }
  }
  return count;
}
