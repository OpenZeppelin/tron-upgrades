/**
 * The chain fingerprint file: its path, its schema, its atomic write and its
 * defensive read.
 *
 * The fingerprint lives **beside** the manifest, as `<manifest stem>.instance.json`,
 * so both move together when the record location moves and a user who relocates one
 * relocates both. It cannot live *inside* the manifest: the engine's writer
 * normalizes through a strict whitelist — `manifestVersion`, `admin`, `proxies`,
 * `impls`, with each deployment reduced to `address` / `txHash` /
 * `remoteDeploymentId` plus a per-lens include list — so any field this plugin added
 * would be silently dropped on the engine's next write. Measured against the pinned
 * version, on both a top-level key and per-entry fields.
 *
 * The consequence is that the fingerprint's lifetime cannot be made equal to the
 * manifest's, and that is a fact rather than a shortcoming to design around. What
 * *can* be done is to make every divergence named instead of silent, which is why
 * this module has three read outcomes rather than two and why the write is atomic.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChainInstanceIdentity } from '../chain';
import type { FingerprintUnreadableCause } from './errors';
import {
  FINGERPRINT_SCHEMA,
  type FingerprintFile,
  type FingerprintRead,
  type RecordedFingerprint,
} from './types';

/**
 * `0x` + 64 hex, leading zeros preserved.
 *
 * **Never truncated, and the width is the whole point.** A TRON block hash leads
 * with the 8-byte block height, so every chain's block 1 hash begins with the same
 * sixteen hex characters and the discriminating material is only the trailing 24
 * bytes. The file is about 200 bytes; there is nothing to save by shortening it, and
 * a shortened record fails in both directions — it refuses on a chain that has not
 * changed, and it names the genesis hash as the disagreeing signal for what is
 * actually a block-1 divergence, which is a diagnosis that contradicts itself
 * because the genesis hash is constant across a wipe.
 *
 * The width mirrors the chain seam's own `blockHashHexChars`, which that module
 * exports for the tests that pin it. It is restated rather than imported because it
 * is not on the seam's face; a test asserting the two agree is what keeps the
 * restatement honest.
 */
const HASH_HEX_CHARS = 64;
const BLOCK_HASH = new RegExp(`^0x[0-9a-fA-F]{${String(HASH_HEX_CHARS)}}$`);
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

/** The four keys, and only these four. */
const FINGERPRINT_KEYS: readonly string[] = Object.freeze([
  'schema',
  'chainId',
  'genesisHash',
  'firstBlockHash',
]);

const MANIFEST_EXTENSION = '.json';
const FINGERPRINT_SUFFIX = '.instance.json';

/**
 * The fingerprint's path, derived from the manifest's own.
 *
 * Derived rather than rebuilt from the chain id. The engine composes the manifest's
 * name itself, and a second derivation of the same name here is a duplicate that can
 * drift — with the failure mode that a refusal names a file the engine never wrote.
 * Taking the engine's own answer and changing only the extension makes the two agree
 * structurally.
 */
export function fingerprintPathFor(manifestFile: string): string {
  const stem = path.basename(manifestFile, MANIFEST_EXTENSION);
  return path.join(path.dirname(manifestFile), `${stem}${FINGERPRINT_SUFFIX}`);
}

/**
 * The fingerprint to persist for an observed chain.
 *
 * Built field by field rather than spread from the identity, deliberately: the
 * identity also carries the endpoint that answered, and `{...identity, schema}`
 * would put a URL into a file in the user's repository, which they will commit.
 */
export function fingerprintFor(
  identity: ChainInstanceIdentity,
): FingerprintFile {
  return Object.freeze({
    schema: FINGERPRINT_SCHEMA,
    chainId: identity.chainId,
    genesisHash: identity.genesisHash,
    // Written as an explicit `null` when the chain has no block 1 yet, and the key
    // is always present. `JSON.stringify` drops a key whose value is `undefined`,
    // and the comparator tests the key rather than the value — so omitting it does
    // not weaken the check, it turns the check off.
    firstBlockHash: identity.firstBlockHash,
  });
}

function assertPersistableWidth(record: FingerprintFile): void {
  const offending =
    !BLOCK_HASH.test(record.genesisHash) ||
    (record.firstBlockHash !== null && !BLOCK_HASH.test(record.firstBlockHash));
  if (offending) {
    // A defect in this plugin rather than a condition a user can produce: the chain
    // seam validates both hashes on the way in. Asserted anyway, because the value
    // has crossed a boundary and a fingerprint of the wrong width is the one shape
    // that fails silently in both directions.
    throw new Error(
      'the chain fingerprint being written is not two full 32-byte hashes, which ' +
        'is a defect in this plugin rather than a problem with your chain',
    );
  }
}

/**
 * Writes the fingerprint atomically: a temporary file in the **same directory**,
 * then `rename` over the target.
 *
 * Same directory is required rather than tidy — `rename` is atomic only within a
 * filesystem, and the record's anchor may be on a different mount from the system
 * temporary directory.
 *
 * What atomicity buys is precise. A partially written record is *representable* in
 * the comparator's input type, and it maps to "incomplete", which never refuses.
 * Making a torn write unreachable at the filesystem level leaves that verdict
 * meaning only what it was written to mean — a record from an older or foreign
 * writer — rather than doubling as a crash artifact this plugin produced itself.
 *
 * No cleanup on failure, and that is deliberate: if the write fails, the **target**
 * is untouched, which is the property that matters, and the leftover dot-prefixed
 * temporary file is not a fingerprint, is read by nothing, and is overwritten by the
 * next attempt. A cleanup path here would have to swallow its own failure to avoid
 * masking the original one.
 */
export async function writeFingerprint(
  file: string,
  record: FingerprintFile,
): Promise<void> {
  assertPersistableWidth(record);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  // The process id is enough to keep two processes apart, and two writes inside one
  // process are serialized by the manifest lock this write is performed under.
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${String(process.pid)}.tmp`,
  );
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

/**
 * Reads the fingerprint, and **never lets a failure escape**.
 *
 * This is the one place in the whole record layer where a caught error is not
 * rethrown, and the count is the invariant: the hazard is a second swallow appearing
 * somewhere unrelated, which is how a failed manifest write becomes a silent no-op.
 *
 * A file that exists and cannot be used is reported as its own state rather than as
 * an absent one. Those two have identical *behaviour* — both proceed, neither
 * refuses — but reporting them identically is what makes a corrupt fingerprint
 * invisible, and a silently ignored corrupt fingerprint disables the check while the
 * check appears to be on.
 */
export async function readFingerprint(file: string): Promise<FingerprintRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (cause) {
    // One `try` over both the read and the parse, so this module has exactly one
    // non-rethrowing `catch` rather than two.
    if (isFileAbsent(cause)) {
      return Object.freeze({ kind: 'absent' } as const);
    }
    return unreadable(cause instanceof SyntaxError ? 'not-json' : 'unreadable-file');
  }
  return validateFingerprint(parsed);
}

function isFileAbsent(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function unreadable(because: FingerprintUnreadableCause): FingerprintRead {
  return Object.freeze({ kind: 'unreadable', because } as const);
}

/**
 * Total, and pure. Every value a fingerprint file can carry resolves to one of the
 * three read outcomes; nothing here throws.
 *
 * **The gate this function exists for:** the comparator tests `genesisHash` for
 * `undefined` rather than for a string, so a field that is *present* and is not a
 * string — an explicit `null`, a number — falls straight through into a helper typed
 * over `string` and raises a raw `TypeError` from inside a dependency. No named
 * cause, no remedy, and nothing connecting it to the file the user just edited. The
 * neighbouring field is handled, by key presence and with `null` treated explicitly;
 * this one is not. So no value that could make the comparator throw is allowed to
 * reach it: an absent hash field is permitted, because an older writer legitimately
 * omits one and that state has a meaning, while a present one must be a hash.
 */
function validateFingerprint(parsed: unknown): FingerprintRead {
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return unreadable('not-an-object');
  }
  const raw = parsed as Readonly<Record<string, unknown>>;

  // The schema is checked **before** any hash field. The other order compares a
  // future schema's `genesisHash` as if it meant what it means today, and a false
  // "same" is the one verdict that must not be reachable by accident.
  if (raw['schema'] !== FINGERPRINT_SCHEMA) {
    return unreadable('unrecognised-schema');
  }

  // Exhaustive rather than a deny-list. A key nobody has thought of yet is what a
  // deny-list cannot catch, and a recognised schema carrying unrecognised fields
  // means the file was not written by this plugin.
  if (Object.keys(raw).some(key => !FINGERPRINT_KEYS.includes(key))) {
    return unreadable('unexpected-keys');
  }

  const chainId = raw['chainId'];
  if (typeof chainId !== 'string' || !HEX_QUANTITY.test(chainId)) {
    return unreadable('chain-id-unusable');
  }

  const record: {
    chainId: string;
    genesisHash?: string;
    firstBlockHash?: string | null;
  } = { chainId };

  if ('genesisHash' in raw) {
    const genesisHash = raw['genesisHash'];
    if (typeof genesisHash !== 'string' || !BLOCK_HASH.test(genesisHash)) {
      return unreadable('hash-field-unusable');
    }
    record.genesisHash = genesisHash;
  }

  if ('firstBlockHash' in raw) {
    const firstBlockHash = raw['firstBlockHash'];
    if (
      firstBlockHash !== null &&
      (typeof firstBlockHash !== 'string' || !BLOCK_HASH.test(firstBlockHash))
    ) {
      return unreadable('hash-field-unusable');
    }
    // Assigned whether it is `null` or a hash, because **key presence is the
    // signal** the comparator reads. Rebuilding the object without this branch
    // would erase the difference between "the chain had no block 1" and "an older
    // writer did not record one".
    record.firstBlockHash = firstBlockHash;
  }

  return Object.freeze({
    kind: 'record',
    record: Object.freeze(record) as RecordedFingerprint,
  } as const);
}

/** Exported so a test reads the key set rather than restating it. */
export const fingerprintKeys = FINGERPRINT_KEYS;
/** Exported so a test can pin it against the chain seam's own hash width. */
export const fingerprintHashHexChars = HASH_HEX_CHARS;
