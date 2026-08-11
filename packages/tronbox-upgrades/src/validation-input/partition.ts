import { ValidationInputInvariantError } from './errors';

/**
 * The partition: which slice of the project one validation is about.
 *
 * **Separate from `import-graph.ts` because the graph is a fact about the project
 * and the partition is a policy about how much of it one validation reads.**
 * The unit is semantic: one contract's transitive import closure, and no batch
 * size exists. `PartitionRecord` carries no count, so there is no field a
 * threshold could be compared against, and `target` is **singular**, so a
 * multi-target partition is not representable.
 *
 * Under the Foundry model the closure is what the build record is **projected
 * onto**: the gate copies exactly these source keys' entries out of the
 * record's `contracts` and `sources` maps, and rejects any candidate whose
 * ASTs do not cover them. This module used to also order the source *contents*
 * for the plugin's own solc invocation and to key a compile memo — both left
 * with the embedded compiler, because the input a consumer receives is now the
 * record's own paired compiler input rather than anything assembled here.
 */

export interface PartitionRecord {
  /**
   * The source key of the contract this partition was cut for.
   *
   * **A source key, not a contract name, and the containment requirement is
   * what decides it:**
   * *"`provenance.partition.closure` is non-empty and contains
   * `provenance.partition.target`"*, and `closure` is a set of source keys. The
   * original field comment read like a contract name; the containment assertion is the
   * testable statement, so the key wins. It also names something a user can open.
   */
  readonly target: string;
  /** Source keys in the target's transitive closure, including its own. Sorted. */
  readonly closure: readonly string[];
}

/**
 * Cuts the partition, or raises.
 *
 * The two assertions are the containment requirement's, and the violation they
 * prevent is the worst outcome in this sub-feature rather than a tidiness
 * failure: an empty closure projects an empty output, nothing detects a
 * missing layout, and the measured vacuous pass fires —
 * `getStorageUpgradeErrors(EMPTY, real)` returns no errors, so every variable
 * in the new contract is classified as a safe append.
 *
 * The closure is **sorted**, which is a deliberate choice rather than
 * inherited: a determined order makes two calls over an unchanged tree produce
 * deep-equal provenance, which is what the referential-transparency
 * requirement is asserted against.
 */
export function cutPartition(
  targetKey: string,
  sources: ReadonlyMap<string, string>,
): PartitionRecord {
  if (sources.size === 0) {
    throw new ValidationInputInvariantError(
      `the partition cut for "${targetKey}" has an empty closure, so the ` +
        `build record would be projected onto no sources at all.`,
    );
  }
  if (!sources.has(targetKey)) {
    throw new ValidationInputInvariantError(
      `the partition cut for "${targetKey}" does not contain its own target ` +
        `among its ${sources.size} sources.`,
    );
  }

  const closure = [...sources.keys()].sort();
  return Object.freeze({ target: targetKey, closure: Object.freeze(closure) });
}
