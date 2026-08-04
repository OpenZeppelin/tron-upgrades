import type { SolcStandardOutput } from './solc-input';

/*
 * ============================================================================
 * WHAT THIS MODULE MEASURES, AND THE TWO INVERSIONS IT WAS REWRITTEN TO FIX.
 * ============================================================================
 *
 * It answers one question about one produced validation input: **which storage
 * positions will the layout `upgrades-core` builds from this input actually
 * carry?** Positions, not layouts-we-requested. That distinction is the whole
 * rework, and the record of getting it wrong is kept here rather than deleted,
 * because both instruments below were *confidently* wrong in opposite
 * directions and whoever reads them next has to know which way each one failed.
 *
 * **The retired premise.** This module was first written when the plugin always
 * ran its own compile and always asked for `storageLayout`, so "the key is
 * present" and "positions are available" were the same statement. Validation is
 * now lazy: AST-only when the host's build record content-verifies against the
 * artifact, and a single-contract compile only when the record is stale, absent,
 * or when an AST-only refusal needs slot positions to decide. Under an input the
 * plugin did not compile, the two original instruments inverted:
 *
 *   • `detectFidelity` returned `{kind:'slot-level'}` for EVERY contract,
 *     because it skipped contracts whose `storageLayout` key was absent — and on
 *     an AST-only input *every* contract's key is absent. A permissive mislabel:
 *     full slot fidelity claimed for an input that has none.
 *
 *   • `isLayoutVacuous` returned `true` for EVERY contract, for the same reason,
 *     firing cause 9 (`layout-vacuous`, "report a bug, this is ours") on every
 *     validation.
 *
 * **Two instruments inverting in opposite directions is worse than either
 * alone, because whoever resurrects the module will trust one of them.** One
 * said everything was fine; the other said everything was broken.
 *
 * **The fix, in one sentence:** both instruments now take the basis that
 * produced the output, and both read the *produced* layout's own positions
 * (`slot`, `offset`) rather than the presence of a key we asked for.
 *
 * ── Three measured facts the implementation below rests on ───────────────────
 *
 * 1. **A field's position is unresolvable when EITHER coordinate is missing.**
 *    `dist/storage/compare.js:storageFieldBegin` returns `undefined` whenever
 *    `slot` or `offset` is undefined, so `slot !== undefined` alone is not the
 *    predicate — both are read here.
 *
 * 2. **`flat` is not a reliable "was a layout supplied" signal.**
 *    `dist/storage/extract.js:extractStorageLayout` sets `layout.flat = true`
 *    *inside* the loop over `storageLayout.storage`, so a contract whose storage
 *    lives entirely in namespaces reports `flat: false` even when a full
 *    `storageLayout` was supplied. It is read as a corroborating signal only,
 *    and only where the storage list is non-empty.
 *
 * 3. **BOTH lists have to be interrogated, and upstream interrogates one.**
 *    `dist/storage/index.js:getStorageUpgradeReport`'s only slot-absence branch
 *    asks `original.storage.some(item => item.slot === undefined)`. A purely
 *    namespaced contract has `storage: []`, so that branch never fires — while
 *    every member of every namespace carries `slot: undefined`, measured in both
 *    modes (`evidence/namespaced-without-second-compile.log`). Every OZ 5.x
 *    contract takes that path. {@link positionShortfall} asks the same question
 *    of `namespaces`, so the shortfall is stated instead of silent.
 * ============================================================================
 */

/**
 * Which step produced the `solcOutput` a fidelity question is being asked about.
 *
 * Not an implementation detail of the pipeline: it is *the* input to both
 * instruments here, because the same output shape means different things
 * depending on who compiled it. An absent `storageLayout` key is expected on
 * `'build-record-ast'` (the host never requests one) and is a surprise on
 * `'plugin-compile'` (we always do).
 */
export type LayoutBasis = 'build-record-ast' | 'plugin-compile';

/**
 * What the produced layout can support: full positions, or declaration order.
 *
 * Reported per input and asserted against the basis that produced it — the
 * biconditional lives at the pipeline's return boundary, because the claim being
 * checked is *"the fidelity reported equals the fidelity this step can deliver"*
 * and only the pipeline knows the step.
 */
export type LayoutFidelity =
  | { readonly kind: 'slot-level' }
  | {
      readonly kind: 'declaration-order-only';
      /** Fully-qualified names whose layout carries no positions. Never empty. */
      readonly missingFor: readonly string[];
    };

/**
 * A layout as `upgrades-core` produces it — the subject of {@link positionShortfall}.
 *
 * Declared structurally, every field optional and `unknown`-typed, for two
 * reasons. It has to accept both an `upgrades-core` `StorageLayout` (which a
 * consumer holds after `validate()`) and solc's own `storageLayout` object
 * (which this sub-feature holds before anyone has called `validate`), and
 * neither `@openzeppelin/upgrades-core`'s `StorageLayout` nor `solidity-ast`'s
 * types may be imported here — the first would make this module a runtime
 * importer of the engine for a shape check, and the second is a transitive
 * dependency of the engine rather than a declared dependency of this package,
 * so importing it would make compilation depend on hoisting.
 */
export interface ProducedLayout {
  readonly storage?: readonly LayoutMember[];
  readonly namespaces?: Readonly<Record<string, readonly LayoutMember[]>>;
  readonly flat?: unknown;
}

export interface LayoutMember {
  readonly label?: unknown;
  readonly slot?: unknown;
  readonly offset?: unknown;
}

/**
 * Which members of a produced layout carry no position, in **both** lists.
 *
 * Empty on both lists means every member the layout declares can be compared by
 * position. A non-empty `namespaces` list with an empty `storage` list is the
 * exact state upstream's own check cannot see (§ fact 3 in the header), and it is
 * the state every namespaced contract is in whenever no namespaced compilation
 * was performed.
 */
export interface PositionShortfall {
  /** Labels of `storage` members with no resolvable position. */
  readonly storage: readonly string[];
  /** `<namespaceId>.<label>` for every namespace member with no position. */
  readonly namespaces: readonly string[];
  /**
   * `flat === false` over a non-empty storage list — corroboration that the
   * layout was reconstructed from the AST rather than read from a compile.
   * Never the primary signal (§ fact 2).
   */
  readonly reconstructed: boolean;
}

/** A member is comparable by position only if **both** coordinates resolve. */
function isPositioned(member: LayoutMember): boolean {
  return member.slot !== undefined && member.offset !== undefined;
}

function labelOf(member: LayoutMember, fallback: string): string {
  return typeof member.label === 'string' && member.label !== ''
    ? member.label
    : fallback;
}

export function positionShortfall(layout: ProducedLayout): PositionShortfall {
  const storage: string[] = [];
  const namespaces: string[] = [];

  const storageMembers = layout.storage ?? [];
  storageMembers.forEach((member, index) => {
    if (!isPositioned(member)) {
      storage.push(labelOf(member, `storage[${index}]`));
    }
  });

  for (const [id, members] of Object.entries(layout.namespaces ?? {})) {
    (members ?? []).forEach((member, index) => {
      if (!isPositioned(member)) {
        namespaces.push(`${id}.${labelOf(member, `[${index}]`)}`);
      }
    });
  }

  return Object.freeze({
    storage: Object.freeze(storage),
    namespaces: Object.freeze(namespaces),
    reconstructed: layout.flat === false && storageMembers.length > 0,
  });
}

/** Whether either list came back non-empty. The one place the two are OR-ed. */
export function hasPositionShortfall(shortfall: PositionShortfall): boolean {
  return shortfall.storage.length > 0 || shortfall.namespaces.length > 0;
}

interface StorageLayoutHolder {
  readonly storageLayout?: unknown;
}

function layoutOf(
  output: SolcStandardOutput,
  source: string,
  contract: string,
): ProducedLayout | undefined {
  const holder: StorageLayoutHolder | undefined =
    output.contracts?.[source]?.[contract];
  const layout: unknown = holder?.storageLayout;
  return typeof layout === 'object' && layout !== null
    ? (layout as ProducedLayout)
    : undefined;
}

/** Every `<source>:<contract>` the output carries, in a determined order. */
function fullyQualifiedNames(output: SolcStandardOutput): string[] {
  const names: string[] = [];
  for (const [source, contracts] of Object.entries(output.contracts ?? {})) {
    for (const contract of Object.keys(contracts)) {
      names.push(`${source}:${contract}`);
    }
  }
  return names.sort();
}

/**
 * Runs on **every** produced input, not only when degradation is suspected, and
 * exactly once per input.
 *
 * Calling it only where degradation is suspected would let a leniency flip pass
 * its test while production never ran the detector — and the day the policy table
 * flips, a reduced-fidelity input would ship reading `slot-level`.
 *
 * **`'build-record-ast'` is unconditional and needs no scan of the layouts.** The
 * host's `outputSelection` requests `'': ['ast']` plus ten contract-level outputs
 * and `storageLayout` is not among them, so no build record carries positions for
 * *any* contract, ever. `missingFor` is therefore the output's whole contract set
 * — which the caller asserts non-empty, since an output with no contracts is the
 * vacuous-pass hazard rather than a fidelity question.
 *
 * **`'plugin-compile'` scans the layouts that are present, and skips the ones
 * that are not.** That boundary is deliberate and survives the rework: on this
 * basis we requested layouts, and solc was measured to emit the key even when empty
 * (`{"storage":[],"types":null}` for a purely namespaced contract), and the
 * silent-omission hazard lives strictly below `0.5.13`, which the range gate
 * makes unreachable. Counting an absent key as missing here would turn an
 * unverified assumption about what solc emits for an interface into an invariant
 * error on every project. Absence for the contract *under validation* is not a
 * fidelity question at all — it is cause 9, decided by {@link isLayoutVacuous}.
 */
export function detectFidelity(
  output: SolcStandardOutput,
  basis: LayoutBasis,
): LayoutFidelity {
  if (basis === 'build-record-ast') {
    return {
      kind: 'declaration-order-only',
      missingFor: Object.freeze(fullyQualifiedNames(output)),
    };
  }

  const missingFor: string[] = [];
  for (const [source, contracts] of Object.entries(output.contracts ?? {})) {
    for (const contract of Object.keys(contracts)) {
      const layout = layoutOf(output, source, contract);
      if (layout === undefined) {
        continue;
      }
      if (positionShortfall(layout).storage.length > 0) {
        missingFor.push(`${source}:${contract}`);
      }
    }
  }

  return missingFor.length === 0
    ? { kind: 'slot-level' }
    : { kind: 'declaration-order-only', missingFor: Object.freeze(missingFor) };
}

/**
 * Whether the layout the consumer will hold for the contract under validation
 * says nothing at all.
 *
 * The hazard is the same on both bases and it is measured: an empty *original*
 * layout classifies every variable in the new contract as a safe append —
 * `getStorageUpgradeErrors(EMPTY_original, real_updated)` returns no errors and
 * `assertStorageUpgradeSafe(EMPTY, real)` does not throw. What differs is where
 * emptiness comes from.
 *
 * - **`'plugin-compile'`** — the consumer receives solc's layout verbatim, so
 *   absent or empty are the same answer and both are read here.
 * - **`'build-record-ast'`** — the consumer receives no layout and
 *   `dist/storage/extract.js:extractStorageLayout` reconstructs one from the
 *   contract's own AST, so an absent `storageLayout` key means nothing and the
 *   only way the layout can come back empty *against a contract that declares
 *   state* is for the AST not to be there to reconstruct from. That is what is
 *   checked, and it is why this arm is a build-record rejection rather than
 *   cause 9: a record whose sources do not cover the target is a record to stop
 *   using, not a bug to report.
 */
export function isLayoutVacuous(
  output: SolcStandardOutput,
  source: string,
  contract: string,
  basis: LayoutBasis,
): boolean {
  if (basis === 'plugin-compile') {
    const layout = layoutOf(output, source, contract);
    return layout === undefined || (layout.storage ?? []).length === 0;
  }
  return findContractDefinition(output, source, contract) === undefined;
}

/**
 * The AST shapes this module reads, declared structurally.
 *
 * Deliberately **not** imported from `solidity-ast`, even though upstream types
 * `SolcOutput.sources[file].ast` as its `SourceUnit`: that package is a
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
  readonly documentation?: unknown;
}

function astNodes(output: SolcStandardOutput, source: string): readonly AstNode[] {
  const ast: unknown = output.sources?.[source]?.ast;
  if (typeof ast !== 'object' || ast === null) {
    return [];
  }
  const nodes = (ast as AstNode).nodes;
  return Array.isArray(nodes) ? nodes : [];
}

/**
 * The contract's own definition node, or `undefined` when this output cannot
 * supply one.
 *
 * One function rather than two lookups, because {@link isLayoutVacuous}'s
 * AST arm and {@link countDeclaredStateVariables} must agree about what "the AST
 * is there" means: a vacuity check that says the definition is present while the
 * variable count reads it as absent would report zero declared variables on a
 * non-vacuous layout, which is the silent accept both exist to prevent.
 */
function findContractDefinition(
  output: SolcStandardOutput,
  source: string,
  contract: string,
): AstNode | undefined {
  return astNodes(output, source).find(
    node => node.nodeType === 'ContractDefinition' && node.name === contract,
  );
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
  const target = findContractDefinition(output, source, contract);
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

/**
 * The annotation that puts a contract's storage into a namespace rather than
 * into the flat layout.
 *
 * Read from the AST rather than from the source text so it cannot fire on a
 * mention inside a comment somewhere else in the file: only a struct's own
 * documentation node is inspected. The id capture reproduces what
 * `dist/storage/namespace.js:getStorageLocationAnnotation` reads.
 */
const NAMESPACE_ANNOTATION = /@custom:storage-location\s+(\S+)/;

function documentationText(node: AstNode): string {
  const documentation: unknown = node.documentation;
  if (typeof documentation === 'string') {
    return documentation;
  }
  if (typeof documentation === 'object' && documentation !== null) {
    const text: unknown = (documentation as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/**
 * Every namespaced storage group this contract declares, its bases included.
 *
 * **This is the whole of the namespaced degradation statement in v1, and it has
 * to be computed here because nothing downstream can see the shortfall.** The
 * plugin performs no namespaced compilation, so `upgrades-core` reconstructs
 * every namespace member from the AST with neither `slot` nor `offset`
 * (measured in both modes) — and its own slot-absence branch reads only the flat
 * `storage` list, which for a purely namespaced contract is empty. So the
 * condition is: *this contract declares namespaces* ∧ *no namespaced compilation
 * happened*. The second half is a constant in v1, which is what makes the first
 * half the whole predicate.
 *
 * Returns namespace ids where the annotation carries one, and
 * `<StructName>` where it does not, so the statement can name what it found.
 */
export function declaresNamespacedStorage(
  output: SolcStandardOutput,
  source: string,
  contract: string,
): readonly string[] {
  const definitions = contractDefinitions(output);
  const target = findContractDefinition(output, source, contract);
  if (target === undefined) {
    return Object.freeze([]);
  }

  const bases = Array.isArray(target.linearizedBaseContracts)
    ? target.linearizedBaseContracts
    : [target.id];

  const found: string[] = [];
  for (const baseId of bases) {
    const base = typeof baseId === 'number' ? definitions.get(baseId) : undefined;
    for (const member of base?.nodes ?? []) {
      if (member.nodeType !== 'StructDefinition') {
        continue;
      }
      const matched = NAMESPACE_ANNOTATION.exec(documentationText(member));
      if (matched === null) {
        continue;
      }
      const id = matched[1] ?? '';
      const named =
        id !== '' ? id : typeof member.name === 'string' ? member.name : '';
      if (named !== '' && !found.includes(named)) {
        found.push(named);
      }
    }
  }
  return Object.freeze(found.sort());
}
