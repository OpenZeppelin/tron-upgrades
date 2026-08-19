/**
 * The record layer's shared shapes.
 *
 * Type-only against the engine — `import type`, fully erased — so nothing in this
 * module can put `dist/manifest.js` into the entry module's static import closure.
 * That matters more here than it reads: the engine decides where the deployment
 * record lives from an environment variable it reads **once, at module load**, so a
 * single runtime import reaching it before the plugin has configured that variable
 * turns the configuration into a silent no-op.
 */

import type {
  ImplDeployment,
  ProxyDeployment,
} from '@openzeppelin/upgrades-core';
import type { AbsolutePath } from '../environment';
import type { ChainAccess, ChainInstanceIdentity } from '../chain';
import type { CanonicalAddress } from './address';
import type { FingerprintUnreadableCause } from './errors';

/**
 * The record layer's dependency-injection seam. Seams, not handles.
 *
 * No TronBox handle appears here and none can: the only host-derived values the
 * record layer consumes are the two the seam has already asserted, which is what
 * keeps the host reachable from `src/record/**` by no path at all — by
 * construction rather than by review.
 */
export interface RecordDeps {
  /**
   * The seam's asserted project root, and the anchor the record is placed under.
   *
   * Never a build directory. Under `tronbox test` the host relocates
   * `contracts_build_directory` to an ephemeral temporary directory outside the
   * project and discards it, so an anchor derived from it would put the deployment
   * record somewhere the host deletes — and the chain-instance check would then
   * report "no recorded identity" forever and never fire once. The other
   * `ProjectPaths` fields are deliberately absent from this interface, so the wrong
   * one has no typed route in.
   */
  readonly root: AbsolutePath;
  /**
   * The seam's environment view. **One view, threaded** — read here, written here,
   * and never re-read from the process's own environment.
   *
   * This is a correctness property rather than hygiene. The name the refusal message
   * cites and the file the engine actually writes agree only if both are derived
   * from the same view; a second read that a test harness or a `dotenv` load has
   * changed in between produces a refusal naming a file that does not exist.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The chain seam. Supplies the memoized identity and the code-presence read. */
  readonly chain: ChainAccess;
  /**
   * The addresses **this operation names** — the proxies it is about to act on, plus
   * any it wants a verdict for.
   *
   * The record layer cannot enumerate proxies it has no record of, and it does not
   * try: walking the chain looking for them is unbounded work on the critical path
   * of every migration, for an answer it has already declared it cannot produce
   * honestly. So a code-presence read happens once per address named here and
   * nowhere else, and the reconciliation report covers exactly these.
   */
  readonly addresses?: readonly NamedAddress[];
}

/** An address an operation names, with the kind the caller asserted for it if any. */
export interface NamedAddress {
  /** Any of the three accepted encodings; the session canonicalizes it. */
  readonly address: string;
  /**
   * A kind the caller asserted about their own proxy.
   *
   * The engine accepts an explicitly passed kind unchecked when no record
   * corroborates it. The record layer does not override that — it is a user
   * asserting something about their own proxy — but it stops being silent: the
   * verdict's provenance says so.
   */
  readonly assertedKind?: ProxyDeployment['kind'];
}

/** The schema discriminator this version of the fingerprint file writes. */
export const FINGERPRINT_SCHEMA = 1;

/**
 * The fingerprint file's contents, as written. **Exactly four keys, all required.**
 *
 * `firstBlockHash` is `string | null` and **required**, which is the strongest thing
 * the type system can carry here: `JSON.stringify` drops a key whose value is
 * `undefined`, so writing `undefined` and omitting the key are the same thing on
 * disk — and the comparator tests the *key*, not the value. An omitted key reads as
 * "written by a version that did not have this field", which never refuses, so the
 * next run would proceed and write the current chain's fingerprint over records
 * from a different one. A required field is what makes that unwritable.
 *
 * What is deliberately absent, and each omission is a decision: the **endpoint**,
 * because persisting one is a new exposure surface for zero comparison benefit; and
 * a **timestamp**, because it buys nothing the file's own mtime does not and is one
 * more field a future reader could mistake for a comparison operand.
 */
export interface FingerprintFile {
  readonly schema: typeof FINGERPRINT_SCHEMA;
  /** Hex quantity, as the chain seam's identity carries it. */
  readonly chainId: string;
  /** `0x` + 64 hex. Never truncated. */
  readonly genesisHash: string;
  /** `0x` + 64 hex, or `null` when the chain has no block 1 yet. Never omitted. */
  readonly firstBlockHash: string | null;
}

/**
 * A fingerprint file as **read**: validated, and deliberately looser than what this
 * version writes.
 *
 * Both hash fields are optional because a record written by an earlier version
 * legitimately omits one, and that state has a meaning the comparator understands.
 * What is *not* permitted is a field that is present and is not a hash: the
 * comparator tests `genesisHash` for `undefined` rather than for a string, so an
 * explicit `null` would reach a helper typed over `string` and raise a raw
 * `TypeError` from inside a dependency — no named cause, no remedy, and nothing
 * connecting it to the file the user just edited. Gating on the shape here is what
 * keeps that unreachable, and the key-presence distinction is preserved rather than
 * normalized away because the comparator depends on it.
 */
export interface RecordedFingerprint {
  readonly chainId: string;
  readonly genesisHash?: string;
  readonly firstBlockHash?: string | null;
}

/**
 * The outcome of reading the fingerprint file — three states, not two.
 *
 * "Absent" and "unusable" are separate members on purpose. Collapsing them into one
 * `undefined` is the one-line way to make a corrupt fingerprint indistinguishable
 * from a missing one in the only surface a user sees, which disables the check while
 * the check appears to be on.
 */
export type FingerprintRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly because: FingerprintUnreadableCause }
  | { readonly kind: 'record'; readonly record: RecordedFingerprint };

/** Where the deployment record is anchored. */
export interface RecordLocation {
  /** Absolute. The directory the manifest and the fingerprint both live in. */
  readonly dir: string;
}

/** What a stored proxy record turned out to be worth. */
export type ProxyRecordStatus =
  /** A record exists and the address holds code. */
  | 'authoritative'
  /**
   * A record exists and the address holds no code. **Reported, never deleted** — a
   * discarded record is the lost record of a live proxy whenever detection is wrong,
   * and detection has a legitimate false-positive path.
   */
  | 'no-code-at-address'
  /** The address holds code and nothing records it. */
  | 'unrecorded';

/** Where the kind used for a proxy came from. */
export type KindProvenance =
  /** A stored record matched and supplied it. */
  | 'from-record'
  /**
   * No record and no assertion, so the engine will derive it — from an ERC-1967
   * slot read or from the implementation's own validation data.
   */
  | 'inferred-by-engine'
  /** The caller passed it and **no record corroborated it**. */
  | 'asserted-by-caller';

export interface ProxyRecordVerdict {
  readonly address: CanonicalAddress;
  readonly status: ProxyRecordStatus;
  readonly kindProvenance: KindProvenance;
  /**
   * Absent exactly when `kindProvenance` is `'inferred-by-engine'` — nothing has
   * determined a kind yet at the point the preflight runs, and naming one would be
   * an invention. Optional rather than defaulted for that reason.
   */
  readonly kind?: ProxyDeployment['kind'];
}

/**
 * What the preflight found. Internal in this version: the plugin's result surface is
 * settled by the result surface itself, and adding a result type later is additive, whereas shipping
 * one now would pre-empt that contract on the basis of a shape no consumer has
 * asked for.
 *
 * Every field is a scalar or a readonly array of scalars — no handle, no endpoint,
 * no `Date`, nothing with a `toJSON`. And the same inputs produce an equal report:
 * no timestamp, no counter, and verdicts in sorted order rather than in manifest
 * order, so a re-serialization upstream cannot change it.
 */
/**
 * Why the instance check did not decide. **Three members where the comparator's own
 * union has two**, and the extra one is the point: an unusable fingerprint must not be
 * reported as an absent one.
 */
export type InstanceIndeterminateCause =
  | 'no-recorded-identity'
  | 'recorded-identity-incomplete'
  | 'fingerprint-unreadable'
  /**
   * Session-level, never the comparator's: the instance changed but the record
   * held zero deployments, so the gate re-armed instead of refusing.
   */
  | 'instance-changed-record-empty';

/** Which of the fingerprint's two hash fields was missing. */
export type IncompleteFingerprintField = 'genesisHash' | 'firstBlockHash';

export interface ReplayReconciliationReport {
  readonly chainId: string;
  /**
   * `'changed'` is unrepresentable here, and that is cheaper than documenting that
   * it cannot happen: a `changed` verdict refuses in the preflight, before any
   * report exists.
   */
  readonly instance: 'same' | 'indeterminate';
  readonly instanceBecause?: InstanceIndeterminateCause;
  /**
   * Which field the persisted fingerprint was missing, present only on
   * `'recorded-identity-incomplete'`.
   *
   * This report is the **only** surface that fires when a *field* rather than a
   * *file* goes missing — that state never refuses — so a report naming the cause
   * without naming the field leaves the user unable to tell their own hand-edit from
   * a record written by an older version, which are the two causes and only one of
   * them is theirs.
   */
  readonly incompleteField?: IncompleteFingerprintField;
  /**
   * How many stored addresses the load-time migration rewrote. Non-zero means **the
   * plugin modified the user's manifest**, which is not something to do silently.
   */
  readonly addressesMigrated: number;
  /**
   * How many stored addresses could not be brought to canonical form and were left
   * exactly as they are.
   *
   * Left rather than repaired or removed, for the same reason a stale record is
   * never deleted. Reported because a lookup for such a record will miss, and a miss
   * that nothing announced looks like an unregistered proxy — which is the input to
   * a force-import.
   */
  readonly addressesUnmigratable: number;
  readonly proxies: readonly ProxyRecordVerdict[];
}

/**
 * The one handle every operation uses to reach the deployment record.
 *
 * Nothing else touches it: no operation constructs the engine's `Manifest`, writes
 * the location variable, derives the fingerprint's path, or reads the process
 * environment. Every additional entry point is another place the preflight's order
 * can be skipped, and the order is the design.
 */
export interface RecordSession {
  /**
   * Absolute, and asserted to be — both that it is absolute and that it is under the
   * anchor this plugin resolved.
   *
   * Declared `string` rather than the seam's `AbsolutePath` because that brand is
   * mintable only inside the seam and is not on its face, so minting it here would
   * take a cast — and a cast that mints another module's brand is precisely what the
   * brand exists to prevent. The guarantee is carried by the refusal instead, which
   * is stronger for this value: it asserts agreement with the anchor as well as
   * absoluteness.
   */
  readonly manifestFile: string;
  /** Absolute. `<manifest stem>.instance.json`, beside the manifest. */
  readonly fingerprintFile: string;
  readonly identity: ChainInstanceIdentity;
  readonly report: ReplayReconciliationReport;
  /**
   * Takes any of the three accepted encodings and canonicalizes internally.
   *
   * Deliberately not typed over the brand. If it were, every operation would call
   * the mint itself — six more gates that could each be got wrong, which is the
   * five-comparison-sites problem reproduced on this side of the line.
   */
  getProxyRecord(address: string): Promise<ProxyDeployment | undefined>;
  getImplRecord(address: string): Promise<ImplDeployment | undefined>;
  addProxyRecord(record: {
    readonly address: string;
    readonly kind: ProxyDeployment['kind'];
  }): Promise<void>;
  /**
   * `proxies.length` + the number of `impls` keys + one if `admin` is present.
   *
   * The definition is fixed and written down because the number appears in a refusal
   * the user acts on: the message says how many deployment records are in a file it
   * is warning them not to delete. Any definition is arbitrary; an undocumented one
   * quietly means something else a release later, and a user with twelve
   * implementations told there are none deletes the file.
   */
  recordCount(): Promise<number>;
  /**
   * Runs an engine call that takes **this record's** lock, so contention arrives
   * as `RecordLockedError` instead of a raw `ELOCKED`.
   *
   * On the session rather than on the record layer's face, and that placement is
   * the argument: the lock belongs to this record, the session is already the one
   * handle every operation reaches the record through, and the face's guarantee
   * that it exports exactly five values is worth more than the convenience of a
   * sixth. Nothing here can skip the preflight order — it classifies an error and
   * changes no control flow — which is the risk that guarantee exists to bound.
   *
   * Lock contention only. Every other failure of `action` passes through as
   * itself, because `action` is the caller's own work: the engine's
   * implementation deploy, whose validation and deploy failures are not this
   * session's to rename.
   */
  throughLock<T>(action: () => Promise<T>): Promise<T>;
}
