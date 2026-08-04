import { ValidationInputInvariantError } from './errors';
import type { SolcStandardOutput } from './solc-input';

/**
 * How much of the project goes into one solc invocation, and the memo over that
 * decision.
 *
 * **Separate from `import-graph.ts` because the graph is a fact about the project
 * and the partition is a policy about how much of it to hand the compiler at
 * once.** The wasm's memory ceiling is what makes that a decision rather than a
 * detail: `evidence/probe-wasm-memory-ceiling.js` measured it moving with the
 * *user's* optimizer settings by better than 2× on a fixed generator (optimizer
 * off, last N that compiled 360; optimizer on, 160), so any numeric batch size
 * would be tuned against a ceiling the plugin does not control.
 *
 * **The unit is therefore semantic: one contract's transitive import closure, and
 * no batch size exists** (INV-35). `PartitionRecord` carries no count, so there is
 * no field a threshold could be compared against, and `target` is **singular**, so
 * a multi-target partition is not representable (INV-38) — union-first is
 * specified and unbuilt, and that is deliberate rather than an oversight.
 */

export interface PartitionRecord {
  /**
   * The source key of the contract this partition was cut for.
   *
   * **A source key, not a contract name, and INV-4 is what decides it:**
   * *"`provenance.partition.closure` is non-empty and contains
   * `provenance.partition.target`"*, and `closure` is a set of source keys. The
   * original field comment read like a contract name; the containment assertion is the
   * testable statement, so the key wins. It also names something a user can open.
   */
  readonly target: string;
  /** Source keys in the target's transitive closure, including its own. */
  readonly closure: readonly string[];
}

export interface Partition {
  readonly record: PartitionRecord;
  /**
   * The sources solc receives, in the order `provenance.sourceKeys` reports
   * (INV-4).
   *
   * **Sorted, which is a deliberate choice rather than inherited.** The host
   * hands solc its `required_sources` map in graph-walk order. Nothing measured
   * says solc's output depends on the order of the `sources` map — F-6 measured
   * that the *content* of a key changes every identity, and solc keys its own
   * metadata `sources` map by name — so determinism is worth more here than
   * mimicry: a sorted order makes two calls over an unchanged tree byte-identical
   * inputs, which is what INV-21's referential transparency is asserted against.
   */
  readonly sources: Readonly<Record<string, string>>;
}

/**
 * Cuts the partition, or raises.
 *
 * The two assertions are INV-4's, and the violation they prevent is the worst
 * outcome in this sub-feature rather than a tidiness failure: an empty closure
 * reaches solc, the output has no contracts, `detectFidelity` sees nothing missing
 * and reports `slot-level`, the layout handed to upgrades-core is empty, and F-4's
 * measured vacuous pass fires — `getStorageUpgradeErrors(EMPTY, real)` returns no
 * errors, so every variable in the new contract is classified as a safe append.
 */
export function cutPartition(
  targetKey: string,
  sources: ReadonlyMap<string, string>,
): Partition {
  if (sources.size === 0) {
    throw new ValidationInputInvariantError(
      `the partition cut for "${targetKey}" has an empty closure, so the ` +
        `compiler would be handed no sources at all.`,
    );
  }
  if (!sources.has(targetKey)) {
    throw new ValidationInputInvariantError(
      `the partition cut for "${targetKey}" does not contain its own target ` +
        `among its ${sources.size} sources.`,
    );
  }

  const closure = [...sources.keys()].sort();
  const ordered: Record<string, string> = {};
  for (const key of closure) {
    ordered[key] = sources.get(key) as string;
  }

  return {
    record: Object.freeze({ target: targetKey, closure: Object.freeze(closure) }),
    sources: ordered,
  };
}

/**
 * The memo key: the **sorted** source-key set, the settings, and the compiler's
 * long version (INV-22).
 *
 * All three are needed and the second is the one that is easy to leave out. F-6
 * measured that `optimizer` *is* in solc metadata, so a memo keyed on sources
 * alone would hand a contract compiled under one optimizer profile the output of
 * another — surfacing as spurious staleness at best and a wrong-layout pass at
 * worst. The long version is in the key for F-7's reason: two compiler families
 * answer to the same version number.
 *
 * Settings are serialized with `JSON.stringify`, so two structurally equal
 * settings objects with different key order key differently. That direction is
 * safe — it produces a memo *miss*, never a wrong hit — and the seam hands the
 * same frozen object throughout one call, so it does not arise in practice.
 */
export function partitionIdentity(
  record: PartitionRecord,
  settings: Readonly<Record<string, unknown>>,
  compilerLongVersion: string,
): string {
  return JSON.stringify([
    [...record.closure].sort(),
    settings,
    compilerLongVersion,
  ]);
}

/**
 * A compile memo for the life of one call.
 *
 * **Call-scoped, and what that costs is stated rather than glossed.** INV-21
 * forbids module-level mutable state — a module-level cache of compiler identity
 * across calls is a correctness bug, not a speed-up — and INV-21's own allowance
 * is for *"the memo's own documented, call-scoped binding"*. But
 * `deriveValidationInput` derives exactly **one** contract per call, so a
 * call-scoped memo holds at most one entry and its *hit* path is unreachable
 * through the shipped API. The lookup runs on every compile; the hit does not.
 *
 * That is a gap between two specified requirements rather than a shortcut here: the
 * partitioning requirement describes the memo as amortising *"within one process"*,
 * INV-45 states it as *"within one call"*, and INV-22's and INV-38's tests speak of
 * *"two targets requested in one call"* — a request shape `ValidationInputRequest`
 * does not have. It is reported at close, with the two ways out named. The
 * mechanism ships because it is exactly the seam union-first needs, and because it
 * is directly testable at this module's own boundary.
 */
export interface CompileMemo {
  get(identity: string): SolcStandardOutput | undefined;
  set(identity: string, output: SolcStandardOutput): void;
}

export function createCompileMemo(): CompileMemo {
  const entries = new Map<string, SolcStandardOutput>();
  return {
    get(identity) {
      return entries.get(identity);
    },
    set(identity, output) {
      entries.set(identity, output);
    },
  };
}
