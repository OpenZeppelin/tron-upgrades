/**
 * The record layer's face: **one** async entry point plus four named values.
 *
 * Everything else in this directory is internal, and the narrowness is the point. Every
 * operation obtains a session from {@link openRecord} and reaches the deployment record
 * through it — no operation constructs the engine's record handle, sets the location
 * variable, derives the fingerprint's path, or reads the process environment. The
 * preflight's *order* is what makes the record trustworthy, and every additional entry
 * point is another place that order can be skipped: a sub-feature that imported the
 * fingerprint's path helper "just to log the filename" would print a path from a
 * derivation that later moved, inside a message telling the user to delete it.
 *
 * **The reconciliation report is internal in this version.** The plugin's result
 * surface is owned elsewhere, and adding a result type later is additive, whereas
 * shipping one now would fix a shape no consumer has asked for. `toTronHex` is internal
 * for the same reason: it exists for correlating a record against an address the host
 * wrote in its own artifacts, and that diagnostic is itself internal.
 *
 * **This is the package-internal face, not the package's public API.** The entry module
 * exports the plugin's operations; nothing here is re-exported from it.
 */

export { openRecord } from './session';
export { configureRecordLocation } from './location';
export {
  canonicalizeAddress,
  isCanonicalAddress,
  toBase58,
  type CanonicalAddress,
} from './address';

export type {
  KindProvenance,
  NamedAddress,
  ProxyRecordStatus,
  ProxyRecordVerdict,
  RecordDeps,
  RecordLocation,
  RecordSession,
  ReplayReconciliationReport,
} from './types';

/**
 * The error surface, as **types**.
 *
 * Deliberately not as classes. A consumer distinguishes these by their `code` — the
 * discipline the rest of the package already follows — and exporting the constructors
 * would put four more values on a face whose whole guarantee is that it has five.
 */
export type {
  AddressNotCanonicalizableError,
  AddressRejectionCause,
  RecordFingerprintUnreadableError,
  RecordLocationCause,
  RecordLocationUnusableError,
  RecordLockedError,
  RecordUnreadableCause,
  RecordUnreadableError,
} from './errors';
