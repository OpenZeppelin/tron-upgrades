/**
 * Per-entry verdicts on stored proxy records, and the report the preflight returns.
 *
 * **Only `proxies[]`, and that division of labour is measured rather than chosen.**
 * The engine already reconciles its `impls` and `admin` lenses against chain state,
 * inside its own manifest lock: a record carrying a transaction hash whose transaction
 * exists is resumed rather than redeployed. So this module adds **no** second probe for
 * either — a duplicate of a check that already exists emits a confidently wrong verdict
 * where a right one is already available, which is worse than an honest gap, and it
 * costs a round trip per record on a chain where round trips are the dominant cost.
 *
 * `proxies[]` is reconciled by nothing at all. Nothing in the engine reads it; its only
 * writer splices and pushes with no on-chain check of any kind, and the function that
 * adds a proxy record is called by *plugins*, never internally. So after a chain is
 * wiped the proxy records survive, pointing at addresses that hold no code — and those
 * are exactly the records the engine's proxy-kind cross-check consults. A stale proxy
 * record is not inert.
 *
 * **The verdict is per entry and the refusal is per operation**, which is the
 * granularity that matters: a run upgrading one proxy must not be refused because an
 * unrelated proxy's record went stale. This module produces verdicts and never refuses
 * and never deletes.
 */

import type { InstanceComparison } from '../chain';
import type { ProxyDeployment } from '@openzeppelin/upgrades-core';
import { canonicalizeAddress, type CanonicalAddress } from './address';
import type {
  FingerprintRead,
  IncompleteFingerprintField,
  InstanceIndeterminateCause,
  NamedAddress,
  ProxyRecordVerdict,
  RecordedFingerprint,
  ReplayReconciliationReport,
} from './types';

/**
 * A comparison that did **not** refuse.
 *
 * `'changed'` is excluded at the type level rather than handled: a report describing a
 * refused run cannot exist, because the refusal happens before any report is
 * constructed. Making the wrong answer unnameable is cheaper than documenting that it
 * cannot happen.
 */
export type SettledInstanceComparison = Exclude<
  InstanceComparison,
  { readonly kind: 'changed' }
>;

/** The instance half of the report. */
export interface InstanceOutcome {
  readonly instance: 'same' | 'indeterminate';
  readonly instanceBecause?: InstanceIndeterminateCause;
  readonly incompleteField?: IncompleteFingerprintField;
}

/**
 * Which field the **comparator** stopped on, derived with the comparator's own
 * predicates in the comparator's own order.
 *
 * The comparator returns a cause and no field name, so this has to be derived here —
 * and the derivation is a duplicate of a precedence rule that lives in another file,
 * which is why it is pinned to that rule explicitly rather than written the obvious
 * way. The two predicates are **different**:
 *
 * - `genesisHash` is tested **by value** (`=== undefined`), and it is tested **first**;
 * - `firstBlockHash` is tested **by key presence** (`'firstBlockHash' in recorded`),
 *   and it is tested second.
 *
 * So a shared helper over both fields is wrong even where it happens to agree, and
 * when **both** are absent the answer is `genesisHash` — the comparator stops there. A
 * derivation that iterated the record's own keys and named the first absent one would
 * report `firstBlockHash`, and the user would check a field that was not the one that
 * turned the guard off, unable to tell their own hand-edit from an older writer.
 *
 * Answers `undefined` for a **complete** record: a `firstBlockHash` that is present and
 * holds `null` is not missing — the chain had no block 1 when the record was written —
 * and naming it as missing would be an invention.
 */
export function incompleteFieldOf(
  recorded: RecordedFingerprint,
): IncompleteFingerprintField | undefined {
  if (recorded.genesisHash === undefined) {
    return 'genesisHash';
  }
  if (!('firstBlockHash' in recorded)) {
    return 'firstBlockHash';
  }
  return undefined;
}

/**
 * Maps a settled comparison onto the report's instance fields.
 *
 * **The unreadable case widens the comparator's answer rather than passing it
 * through.** On an unusable fingerprint the record layer hands the comparator
 * `undefined`, and the comparator answers "no recorded identity" — which is true of
 * what it was given and false about what is on disk. Reporting it verbatim makes a
 * corrupt fingerprint indistinguishable from an absent one in the only surface a user
 * sees, and a silently ignored corrupt fingerprint disables the check while the check
 * appears to be on. The report's cause union therefore has three members where the
 * comparator's has two, so the widening is expressed in the type and a pass-through is
 * visible as a narrowing.
 */
export function instanceOutcomeOf(
  read: FingerprintRead,
  comparison: SettledInstanceComparison,
): InstanceOutcome {
  if (comparison.kind === 'same') {
    return Object.freeze({ instance: 'same' } as const);
  }

  if (read.kind === 'unreadable') {
    return Object.freeze({
      instance: 'indeterminate',
      instanceBecause: 'fingerprint-unreadable',
    } as const);
  }

  if (
    comparison.because === 'recorded-identity-incomplete' &&
    read.kind === 'record'
  ) {
    const incompleteField = incompleteFieldOf(read.record);
    if (incompleteField !== undefined) {
      return Object.freeze({
        instance: 'indeterminate',
        instanceBecause: comparison.because,
        incompleteField,
      } as const);
    }
  }

  return Object.freeze({
    instance: 'indeterminate',
    instanceBecause: comparison.because,
  } as const);
}

/** The one chain read this module performs, injected so the module stays testable. */
export interface CodePresence {
  hasCode(address: string): Promise<boolean>;
}

/**
 * Verdicts for the addresses **this operation named**, and for no others.
 *
 * One code-presence read per named address, and nothing enumerated from the chain.
 * That bound is the honest statement of a limitation rather than an optimization: the
 * record layer cannot discover proxies it has no record of, so it does not claim to
 * find them — only to notice one when it is asked about it. Walking the chain looking
 * for them would be unbounded work on the critical path of every migration, for the
 * one answer this layer has already declared it cannot produce honestly.
 *
 * A named address that has **neither** a record **nor** code yields no verdict: there
 * is no record to reconcile and no deployment to reconcile it against, so any of the
 * three statuses would be a claim about a state that does not exist. The operation's
 * own validation is what refuses an address holding no code.
 *
 * Verdicts come back **sorted by address**, not in manifest order, so a
 * re-serialization of the record upstream cannot change the report.
 */
export async function reconcileProxies(
  named: readonly NamedAddress[],
  stored: readonly ProxyDeployment[],
  chain: CodePresence,
): Promise<readonly ProxyRecordVerdict[]> {
  const verdicts: ProxyRecordVerdict[] = [];

  for (const entry of named) {
    // Canonicalized here, once, at the boundary — so the operation cannot get it
    // wrong and does not have to know the form the record uses.
    const address = canonicalizeAddress(entry.address);
    const record = storedRecordFor(stored, address);
    const code = await chain.hasCode(address);

    if (record === undefined) {
      if (!code) {
        continue;
      }
      verdicts.push(unrecordedVerdict(address, entry.assertedKind));
      continue;
    }

    verdicts.push(
      Object.freeze({
        address,
        status: code ? 'authoritative' : 'no-code-at-address',
        // A record matched, so the kind is corroborated whatever the caller passed.
        // Where the caller passed a *different* one the engine itself refuses, and
        // that refusal is the engine's to own.
        kindProvenance: 'from-record',
        kind: record.kind,
      } as const),
    );
  }

  return Object.freeze(
    verdicts.sort((left, right) => left.address.localeCompare(right.address)),
  );
}

function unrecordedVerdict(
  address: CanonicalAddress,
  assertedKind: ProxyDeployment['kind'] | undefined,
): ProxyRecordVerdict {
  return assertedKind === undefined
    ? // Nothing has determined a kind at this point, and the engine will derive one —
      // from an ERC-1967 slot read or from the implementation's own validation data.
      // Naming a kind here would be an invention, so the field is absent.
      Object.freeze({
        address,
        status: 'unrecorded',
        kindProvenance: 'inferred-by-engine',
      } as const)
    : // The caller asserted a kind about their own proxy and **no record corroborated
      // it**. The engine accepts that unchecked and this layer does not override it —
      // it is the user's assertion about their own contract — but it stops being
      // silent.
      Object.freeze({
        address,
        status: 'unrecorded',
        kindProvenance: 'asserted-by-caller',
        kind: assertedKind,
      } as const);
}

/**
 * The engine's own lookup predicate — exact string equality on `address`, with no
 * normalization on either side — applied to a manifest already in hand.
 *
 * Restated at this **one** site rather than routed through the engine's own method,
 * and the trade is explicit: the engine's method re-reads the file and takes its lock
 * on every call, so routing a batch of verdicts through it would cost one file read and
 * one lock acquisition per named address. The session's single-address lookup *does* go
 * through the engine's method, so the engine remains the authority for lookups; this is
 * the batch pass over a snapshot.
 *
 * The equality is what makes canonicalization a correctness control rather than a
 * formatting preference: an address stored in another spelling does not match, and a
 * missed match stops the engine's proxy-kind cross-check from firing at all.
 */
function storedRecordFor(
  stored: readonly ProxyDeployment[],
  address: CanonicalAddress,
): ProxyDeployment | undefined {
  return stored.find(entry => entry.address === address);
}

/** Assembles the report. Pure: no clock, no counter, no ambient state. */
export function buildReport(input: {
  readonly chainId: string;
  readonly outcome: InstanceOutcome;
  readonly addressesMigrated: number;
  readonly addressesUnmigratable: number;
  readonly proxies: readonly ProxyRecordVerdict[];
}): ReplayReconciliationReport {
  const report: {
    chainId: string;
    instance: 'same' | 'indeterminate';
    instanceBecause?: InstanceIndeterminateCause;
    incompleteField?: IncompleteFingerprintField;
    addressesMigrated: number;
    addressesUnmigratable: number;
    proxies: readonly ProxyRecordVerdict[];
  } = {
    chainId: input.chainId,
    instance: input.outcome.instance,
    addressesMigrated: input.addressesMigrated,
    addressesUnmigratable: input.addressesUnmigratable,
    proxies: input.proxies,
  };
  // Assigned only when present: the package compiles with exact optional property
  // types, so an absent cause is an absent key rather than an explicit `undefined`.
  if (input.outcome.instanceBecause !== undefined) {
    report.instanceBecause = input.outcome.instanceBecause;
  }
  if (input.outcome.incompleteField !== undefined) {
    report.incompleteField = input.outcome.incompleteField;
  }
  return Object.freeze(report);
}
