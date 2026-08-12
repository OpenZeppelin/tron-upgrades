/**
 * The record layer — non-vacuity fixtures for six guards whose violation
 * still type-checks.
 *
 * Every property below shares one hazard shape: **the wrong behaviour is
 * indistinguishable from the right one at every surface a naive test looks at.** A
 * truncated hash is a valid string. An omitted key is valid JSON. A non-atomic write
 * usually succeeds. A message missing a sentence is still a message. So a test that
 * only checks the happy path passes just as well with the guard deleted, and a suite
 * of those is a suite that measures nothing.
 *
 * Each section therefore does two things rather than one: it exercises the guard, and
 * it **induces the violation the guard exists for** and pins what the violation does.
 * The second half is what makes the first half worth having — remove a guard and the
 * section goes red at a named assertion, rather than staying green.
 *
 * Covered: never-truncated hashes, `firstBlockHash` (explicit, never
 * omitted), the atomic sidecar write, `indeterminate` (never refuses, three
 * causes), refusal preceding any write, and the refusal that names both
 * files — plus the sidecar read gate, asserted from both sides, and the
 * gate's own refusal: a corrupt fingerprint refuses, before any write and
 * with both exits named, while an absent one still proceeds.
 *
 * Every induced failure is restored in a `finally`, and the sections run serially:
 * two concurrent induction batches clobber each other's restores and both results
 * become untrustworthy.
 */

import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ManifestData } from '@openzeppelin/upgrades-core';

import type { AbsolutePath } from '../src/environment';
import type { ChainAccess } from '../src/chain';
import { ChainInstanceChangedError } from '../src/chain/errors';
import type { ChainInstanceChange } from '../src/chain/errors';
import {
  blockHashHexChars,
  compareChainInstance,
  type ChainInstanceIdentity,
  type RecordedChainInstance,
} from '../src/chain/instance';
import { canonicalizeStoredAddresses } from '../src/record/manifest';
import {
  instanceOutcomeOf,
  incompleteFieldOf,
  type SettledInstanceComparison,
} from '../src/record/reconcile';
import {
  fingerprintFor,
  fingerprintHashHexChars,
  fingerprintKeys,
  fingerprintPathFor,
  readFingerprint,
  writeFingerprint,
} from '../src/record/sidecar';
import {
  canonicalizeAddress,
  isCanonicalAddress,
  openRecord,
  type RecordDeps,
} from '../src/record';
import {
  RecordFingerprintUnreadableError,
  recordRemedyTables,
  type FingerprintUnreadableCause,
} from '../src/record/errors';
import {
  RecordFingerprintUnreadableError as RootRecordFingerprintUnreadableError,
} from '../src';
import {
  FINGERPRINT_SCHEMA,
  type FingerprintFile,
  type FingerprintRead,
  type InstanceIndeterminateCause,
} from '../src/record/types';
import {
  MAINNET_CHAIN_ID,
  mainnetFirstBlockHash,
  mainnetGenesisHash,
} from './helpers/chain-fixtures';

// ── The record's directory, fixed before anything can load the engine ────────────
//
// The engine reads this variable **once**, at module load of its own manifest module,
// and the record layer reaches that module only by dynamic import. So a module-scope
// assignment here is ordered ahead of the first load by construction rather than by
// hook ordering — which is the same property the entry module relies on in
// production, and the reason `set-too-late` is a named cause at all.
const RECORD_DIR = mkdtempSync(path.join(os.tmpdir(), 'tron-sf3-record-'));
const PREVIOUS_MANIFEST_DIR = process.env['MANIFEST_DEFAULT_DIR'];
process.env['MANIFEST_DEFAULT_DIR'] = RECORD_DIR;

afterAll(async () => {
  try {
    if (PREVIOUS_MANIFEST_DIR === undefined) {
      delete process.env['MANIFEST_DEFAULT_DIR'];
    } else {
      process.env['MANIFEST_DEFAULT_DIR'] = PREVIOUS_MANIFEST_DIR;
    }
  } finally {
    await fs.rm(RECORD_DIR, { recursive: true, force: true });
  }
});

/** The name the engine composes for a chain id it has no entry for. */
const MANIFEST_FILE = path.join(
  RECORD_DIR,
  `unknown-${String(Number.parseInt(MAINNET_CHAIN_ID.slice(2), 16))}.json`,
);
const SIDECAR_FILE = fingerprintPathFor(MANIFEST_FILE);

/** Scrubbed, and diagnostic only — never a comparison operand. */
const OBSERVED_THROUGH = 'http://127.0.0.1:9090/jsonrpc';

/** `0x` + the 8-byte block height. Every chain's block 1 hash begins the same way. */
const HEIGHT_PREFIX_CHARS = 2 + 16;

/**
 * A second boot's block 1: the **same** 8-byte height prefix, different trailing 24
 * bytes. Built from the measured hash rather than invented, so the shared prefix is a
 * property of the fixture rather than a coincidence.
 */
const REBOOTED_FIRST_BLOCK_HASH = assertFullWidth(
  'the rebooted chain\'s block-1 hash',
  `${mainnetFirstBlockHash.slice(0, HEIGHT_PREFIX_CHARS)}${'1a2b3c4d'.repeat(6)}`,
);

/**
 * A fixture hash that is not full width would make every width assertion built on it
 * vacuous, so the fixtures check themselves before any test runs.
 */
function assertFullWidth(label: string, value: string): string {
  if (!new RegExp(`^0x[0-9a-f]{${String(blockHashHexChars)}}$`).test(value)) {
    throw new Error(
      `${label} is not a full-width block hash (${String(value.length - 2)} hex ` +
        `characters, expected ${String(blockHashHexChars)}), so every width ` +
        'assertion built on it would be vacuous',
    );
  }
  return value;
}

/** Keeps the leading `bytes` bytes and drops the rest — the shape the truncation guard forbids. */
function truncatedTo(hash: string, bytes: number): string {
  return `0x${hash.slice(2).slice(0, bytes * 2)}`;
}

function identityFor(firstBlockHash: string | null): ChainInstanceIdentity {
  return Object.freeze({
    chainId: MAINNET_CHAIN_ID,
    genesisHash: mainnetGenesisHash,
    firstBlockHash,
    observedThrough: OBSERVED_THROUGH,
  });
}

/** Creates a directory, runs, and removes it — every induction restores in `finally`. */
async function inTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tron-sf3-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('truncation refuses on a chain that did not change, and blames the one signal a wipe cannot move', () => {
  it('is refused by the writer, so a truncated fingerprint cannot be persisted', async () => {
    await inTempDir(async dir => {
      const file = path.join(dir, 'fingerprint.instance.json');
      const truncated = {
        schema: FINGERPRINT_SCHEMA,
        chainId: MAINNET_CHAIN_ID,
        genesisHash: truncatedTo(mainnetGenesisHash, 8),
        firstBlockHash: truncatedTo(mainnetFirstBlockHash, 8),
      } as FingerprintFile;

      await expect(writeFingerprint(file, truncated)).rejects.toThrow(
        /not two full 32-byte hashes/,
      );
      // Nothing was created, so the refusal is not a half-write with a message.
      await expect(fs.readFile(file, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // Non-vacuity: the same writer accepts the full-width record, so the rejection
      // above is about the width and not about the fixture or the path.
      await writeFingerprint(file, fingerprintFor(identityFor(mainnetFirstBlockHash)));
      const read = await readFingerprint(file);
      expect(read.kind).toBe('record');
    });
  });

  it('is refused by the reader, so a truncated file hand-written into place is named rather than compared', async () => {
    await inTempDir(async dir => {
      const file = path.join(dir, 'fingerprint.instance.json');
      await fs.writeFile(
        file,
        `${JSON.stringify({
          schema: FINGERPRINT_SCHEMA,
          chainId: MAINNET_CHAIN_ID,
          genesisHash: truncatedTo(mainnetGenesisHash, 8),
          firstBlockHash: truncatedTo(mainnetFirstBlockHash, 8),
        })}\n`,
        'utf8',
      );
      expect(await readFingerprint(file)).toEqual({
        kind: 'unreadable',
        because: 'hash-field-unusable',
      });
    });
  });

  it('produces a false refusal on an unwiped chain, and names the signal that is constant across a wipe', () => {
    // The chain has not changed: this is the identity the record was written from.
    const observed = identityFor(mainnetFirstBlockHash);

    const full: RecordedChainInstance = {
      chainId: MAINNET_CHAIN_ID,
      genesisHash: mainnetGenesisHash,
      firstBlockHash: mainnetFirstBlockHash,
    };
    const truncated: RecordedChainInstance = {
      chainId: MAINNET_CHAIN_ID,
      genesisHash: truncatedTo(mainnetGenesisHash, 8),
      firstBlockHash: truncatedTo(mainnetFirstBlockHash, 8),
    };

    // Green: recorded at full width, the same chain is the same chain. This is what
    // makes the next assertion attributable to the truncation and to nothing else.
    expect(compareChainInstance(full, observed)).toEqual({ kind: 'same' });

    // Red: recorded truncated, the same chain is refused.
    const verdict = compareChainInstance(truncated, observed);
    expect(verdict.kind).toBe('changed');
    const change = verdict as ChainInstanceChange;

    // **The signal is wrong, and wrong in the direction that contradicts itself.**
    // A truncated record stops the comparator at `genesisHash`, so a run whose only
    // real difference could ever be block 1 is told the *genesis* hash disagrees —
    // and the genesis hash is constant across a wipe, so the message diagnoses "a
    // different instance of the same chain" by way of the one signal a restart
    // cannot move.
    expect(change.signal).toBe('genesis-hash');
    expect(change.recorded).toBe(truncated.genesisHash);
    expect(change.observed).toBe(mainnetGenesisHash);

    const rendered = new ChainInstanceChangedError(change, {
      manifestFile: MANIFEST_FILE,
      recordCount: 3,
      endpoint: OBSERVED_THROUGH,
      sidecarFile: SIDECAR_FILE,
    }).message;
    expect(rendered).toContain("genesis block's hash");
    expect(rendered).not.toContain("first block's hash");

    // The one fixture that is **unconstructible**, pinned so nobody reintroduces it:
    // a truncated record cannot produce a false `same`. `canonicalHash` preserves
    // leading zeros and every comparison is a whole-string `!==`, so a shorter
    // recorded string can never equal a full observed one.
    expect(truncated.genesisHash).not.toBe(observed.genesisHash);
    expect(compareChainInstance(truncated, observed).kind).not.toBe('same');

    // And what a truncated record loses is the *entire* discriminating material: two
    // different boots' block-1 hashes are byte-identical for their leading 8 bytes,
    // because those bytes are the block height.
    expect(truncatedTo(REBOOTED_FIRST_BLOCK_HASH, 8)).toBe(
      truncatedTo(mainnetFirstBlockHash, 8),
    );
    expect(REBOOTED_FIRST_BLOCK_HASH).not.toBe(mainnetFirstBlockHash);
  });

  it('pins the sidecar width against the chain seam\'s own, so the two cannot drift apart', () => {
    expect(fingerprintHashHexChars).toBe(blockHashHexChars);
    expect(mainnetGenesisHash).toHaveLength(2 + blockHashHexChars);
  });
});

// ── `firstBlockHash` never omitted ───────────────────────────────────────────────

/**
 * Writes a sidecar's bytes from a plain object as well as from the writer's own record
 * type, so a fixture with a key **omitted** is expressible — which is the whole point
 * of the section below, and is not expressible through `FingerprintFile`.
 */
async function writeRawSidecar(
  file: string,
  raw: Readonly<Record<string, unknown>> | FingerprintFile,
): Promise<string> {
  const bytes = `${JSON.stringify(raw, null, 2)}\n`;
  await fs.writeFile(file, bytes, 'utf8');
  return bytes;
}

function recordOf(read: Awaited<ReturnType<typeof readFingerprint>>) {
  return read.kind === 'record' ? read.record : undefined;
}

describe('`firstBlockHash` is written as an explicit `null`; omitting it turns the guard off rather than weakening it', () => {
  it('round-trips through JSON with the key present when the chain has no block 1', () => {
    const record = fingerprintFor(identityFor(null));
    expect(record.firstBlockHash).toBeNull();

    const parsed = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    // The comparator tests the **key**, not the value, so this is the assertion that
    // matters and `toBeNull` on the in-memory object is not a substitute for it.
    expect('firstBlockHash' in parsed).toBe(true);
    expect(parsed['firstBlockHash']).toBeNull();
    expect(Object.keys(parsed).sort()).toEqual([...fingerprintKeys].sort());
  });

  it('shows that writing `undefined` and omitting the key are the same bytes', async () => {
    await inTempDir(async dir => {
      const written = fingerprintFor(identityFor(mainnetFirstBlockHash));

      // The two routes by which the field goes missing. They are indistinguishable
      // once serialized, which is why the type carries the field as required: an
      // `undefined` here is not a weaker record, it is an absent key.
      const viaUndefined: Record<string, unknown> = {
        ...written,
        firstBlockHash: undefined,
      };
      const viaDeletion: Record<string, unknown> = { ...written };
      delete viaDeletion['firstBlockHash'];
      expect(JSON.stringify(viaUndefined)).toBe(JSON.stringify(viaDeletion));

      const omitted = path.join(dir, 'omitted.instance.json');
      const bytes = await writeRawSidecar(omitted, viaUndefined);
      expect(bytes).not.toContain('firstBlockHash');

      // Still valid JSON, still an accepted record — an older writer legitimately
      // omits the field, so the reader cannot refuse it and the absence survives the
      // read rather than being normalized away.
      const read = await readFingerprint(omitted);
      expect(read.kind).toBe('record');
      expect('firstBlockHash' in (recordOf(read) ?? {})).toBe(false);
    });
  });

  it('non-vacuity: on a wiped chain the present field refuses and the omitted key proceeds', async () => {
    await inTempDir(async dir => {
      // Recorded on the first boot; observed after the node was wiped and restarted.
      const observed = identityFor(REBOOTED_FIRST_BLOCK_HASH);
      const written = fingerprintFor(identityFor(mainnetFirstBlockHash));

      const explicitFile = path.join(dir, 'explicit.instance.json');
      const omittedFile = path.join(dir, 'omitted.instance.json');
      await writeRawSidecar(explicitFile, written);
      const omittedRaw: Record<string, unknown> = { ...written };
      delete omittedRaw['firstBlockHash'];
      await writeRawSidecar(omittedFile, omittedRaw);

      const explicitRead = await readFingerprint(explicitFile);
      const omittedRead = await readFingerprint(omittedFile);
      expect(explicitRead.kind).toBe('record');
      expect(omittedRead.kind).toBe('record');

      // Red — the guard fires: the wipe is caught and the run is refused.
      const refusing = compareChainInstance(recordOf(explicitRead), observed);
      expect(refusing.kind).toBe('changed');
      expect((refusing as ChainInstanceChange).signal).toBe('first-block-hash');

      // Green in the worst sense — the guard has **stopped firing**: the same wipe,
      // the same reader, one key's absence, and the run proceeds. It will then write
      // this chain's fingerprint over records written against the other one, which is
      // the failure the required field exists to make unwritable.
      const proceeding = compareChainInstance(recordOf(omittedRead), observed);
      expect(proceeding).toEqual({
        kind: 'indeterminate',
        because: 'recorded-identity-incomplete',
      });
      expect(proceeding.kind).not.toBe('changed');

      const outcome = instanceOutcomeOf(
        omittedRead,
        proceeding as SettledInstanceComparison,
      );
      expect(outcome.instance).toBe('indeterminate');
      // The report is the **only** surface that fires when a field rather than a file
      // goes missing, so it has to name the field or the user cannot tell their own
      // hand-edit from a record written by an older version.
      expect(outcome.incompleteField).toBe('firstBlockHash');
    });
  });

  it('distinguishes a `null` that is present from a key that is absent', () => {
    // Present and `null` means the chain had no block 1 when the record was written.
    // That is a fact, not a gap, and naming it as missing would be an invention.
    expect(
      incompleteFieldOf({
        chainId: MAINNET_CHAIN_ID,
        genesisHash: mainnetGenesisHash,
        firstBlockHash: null,
      }),
    ).toBeUndefined();
    expect(
      incompleteFieldOf({
        chainId: MAINNET_CHAIN_ID,
        genesisHash: mainnetGenesisHash,
      }),
    ).toBe('firstBlockHash');
  });
});

// ── the atomic sidecar write ──────────────────────────────────────────────────────

/**
 * The temporary file the writer uses, restated here because it is not on the module's
 * face — and the restatement is **self-checking**: if the two ever drift apart the
 * injection stops landing, the write succeeds, and the byte-unchanged assertion built
 * on it goes red rather than passing while measuring nothing.
 */
function tempPathFor(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${String(process.pid)}.tmp`,
  );
}

/** How much of the record an interrupted write is modelled as having emitted. */
const TORN_PREFIX_CHARS = 40;

/** Emits the leading bytes of the record and then fails, as a crash mid-write does. */
async function tornWrite(target: string, bytes: string): Promise<never> {
  await fs.writeFile(target, bytes.slice(0, TORN_PREFIX_CHARS), 'utf8');
  throw new Error('injected failure partway through the fingerprint write');
}

/** Temp-plus-rename, with the failure injected exactly where a crash lands. */
async function atomicWriteWithInjectedFailure(
  file: string,
  bytes: string,
): Promise<void> {
  const temp = tempPathFor(file);
  await tornWrite(temp, bytes);
  // Not reached, and that is the property: the target is never a participant in a
  // write that failed.
  await fs.rename(temp, file);
}

/** The same failure, against a writer that has no intermediate file. */
async function inPlaceWriteWithInjectedFailure(
  file: string,
  bytes: string,
): Promise<void> {
  await tornWrite(file, bytes);
}

function serialized(record: FingerprintFile): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

describe('the sidecar write is atomic, so no partial file is ever observable', () => {
  it('leaves the target byte-unchanged when the real writer fails mid-write', async () => {
    await inTempDir(async dir => {
      const file = path.join(dir, 'fingerprint.instance.json');
      const before = serialized(fingerprintFor(identityFor(mainnetFirstBlockHash)));
      await fs.writeFile(file, before, 'utf8');

      // The injection: a **directory** at the exact path the writer uses for its
      // temporary file, so the write fails with EISDIR after the `mkdir` has
      // succeeded and before any rename can happen.
      const temp = tempPathFor(file);
      await fs.mkdir(temp);
      try {
        const failure = await writeFingerprint(
          file,
          fingerprintFor(identityFor(REBOOTED_FIRST_BLOCK_HASH)),
        ).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(failure).toMatchObject({ code: 'EISDIR' });

        expect(await fs.readFile(file, 'utf8')).toBe(before);
        const read = await readFingerprint(file);
        expect(read.kind).toBe('record');
        expect(recordOf(read)?.firstBlockHash).toBe(mainnetFirstBlockHash);
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }

      // Non-vacuity: with the injection removed the same call does replace the file,
      // so the assertion above measures a failure path rather than an inert writer.
      await writeFingerprint(
        file,
        fingerprintFor(identityFor(REBOOTED_FIRST_BLOCK_HASH)),
      );
      expect(await fs.readFile(file, 'utf8')).not.toBe(before);
      expect(recordOf(await readFingerprint(file))?.firstBlockHash).toBe(
        REBOOTED_FIRST_BLOCK_HASH,
      );
    });
  });

  it('non-vacuity: a write-in-place implementation leaves an observable partial file under the same injection', async () => {
    await inTempDir(async dir => {
      const original = serialized(fingerprintFor(identityFor(mainnetFirstBlockHash)));
      const intended = serialized(
        fingerprintFor(identityFor(REBOOTED_FIRST_BLOCK_HASH)),
      );

      const atomicTarget = path.join(dir, 'atomic.instance.json');
      const inPlaceTarget = path.join(dir, 'in-place.instance.json');
      await fs.writeFile(atomicTarget, original, 'utf8');
      await fs.writeFile(inPlaceTarget, original, 'utf8');

      // One injected failure, two write strategies — so the difference between the
      // two outcomes below is the strategy and nothing else.
      await expect(
        atomicWriteWithInjectedFailure(atomicTarget, intended),
      ).rejects.toThrow(/injected failure partway/);
      await expect(
        inPlaceWriteWithInjectedFailure(inPlaceTarget, intended),
      ).rejects.toThrow(/injected failure partway/);

      // Temp-plus-rename: the target never participated.
      expect(await fs.readFile(atomicTarget, 'utf8')).toBe(original);
      expect((await readFingerprint(atomicTarget)).kind).toBe('record');

      // Write-in-place: the target now holds a **prefix of the intended bytes** — a
      // partial file, observable by the very reader that decides whether to refuse.
      const partial = await fs.readFile(inPlaceTarget, 'utf8');
      expect(partial).not.toBe(original);
      expect(intended.startsWith(partial)).toBe(true);
      expect(await readFingerprint(inPlaceTarget)).toEqual({
        kind: 'unreadable',
        because: 'not-json',
      });

      // The leftover temporary file is left in place deliberately — and it is not a
      // fingerprint, so nothing downstream can mistake it for one.
      const leftovers = await fs.readdir(dir);
      expect(leftovers).toContain(path.basename(tempPathFor(atomicTarget)));
      expect(await readFingerprint(tempPathFor(atomicTarget))).toEqual({
        kind: 'unreadable',
        because: 'not-json',
      });
    });
  });
});

// ── `indeterminate` never refuses ────────────────────────────────────────────────

/**
 * One cause, one on-disk state that produces it. Three routes rather than three
 * spellings of one route: a table whose entries all reach the same state would report
 * three-cause coverage while covering one.
 */
interface IndeterminateRoute {
  readonly label: string;
  readonly cause: InstanceIndeterminateCause;
  readonly readKind: FingerprintRead['kind'];
  place(file: string): Promise<void>;
}

const indeterminateRoutes: readonly IndeterminateRoute[] = Object.freeze([
  {
    label:
      'no fingerprint file at all — the state every existing project is in on its first run',
    cause: 'no-recorded-identity',
    readKind: 'absent',
    // The route *is* the absence, so nothing is placed.
    place: () => Promise.resolve(),
  },
  {
    label:
      'a fingerprint written by a version that recorded no genesis hash — a file, missing a field',
    cause: 'recorded-identity-incomplete',
    readKind: 'record',
    place: async (file: string) => {
      await writeRawSidecar(file, {
        schema: FINGERPRINT_SCHEMA,
        chainId: MAINNET_CHAIN_ID,
      });
    },
  },
  {
    label:
      'a fingerprint that is not JSON — a half-resolved merge conflict in a committed file',
    cause: 'fingerprint-unreadable',
    readKind: 'unreadable',
    place: async (file: string) => {
      await fs.writeFile(
        file,
        '<<<<<<< HEAD\n{ "schema": 1, "chainId": "0x2b6653dc"\n',
        'utf8',
      );
    },
  },
] as const satisfies readonly IndeterminateRoute[]);

/**
 * **What this section is now a fixture for, and what it is not.** `instanceOutcomeOf`
 * is kept total over `read.kind === 'unreadable'` — it is a pure function, and a pure
 * function with a case it refuses to answer is a worse thing than one whose answer is
 * simply never consulted. So the loop below still drives all three routes through it
 * directly and still gets `indeterminate` back for the third. What changed is who
 * calls it: `openRecord` never reaches this classification for the third route, because
 * its session gate refuses on `read.kind === 'unreadable'` before comparing anything —
 * see "refuses a non-JSON sidecar" below, which drives the *same* on-disk bytes through
 * `openRecord` itself and gets a refusal, not a report.
 */
describe('`indeterminate` never refuses, and its three causes are reached by three distinct routes', () => {
  const observed = identityFor(mainnetFirstBlockHash);

  for (const route of indeterminateRoutes) {
    it(`the pure classifier reports ${route.cause} on ${route.label}`, async () => {
      await inTempDir(async dir => {
        const file = path.join(dir, 'fingerprint.instance.json');
        await route.place(file);

        const read = await readFingerprint(file);
        expect(read.kind).toBe(route.readKind);

        const comparison = compareChainInstance(recordOf(read), observed);
        // The refusal is reachable from exactly one verdict, and this is not it.
        expect(comparison.kind).not.toBe('changed');
        expect(comparison.kind).toBe('indeterminate');

        const outcome = instanceOutcomeOf(
          read,
          comparison as SettledInstanceComparison,
        );
        expect(outcome.instance).toBe('indeterminate');
        expect(outcome.instanceBecause).toBe(route.cause);
      });
    });
  }

  it('non-vacuity: the three causes come from three distinct on-disk states, not three paths into one', async () => {
    await inTempDir(async dir => {
      const seen: { readKind: string; cause: string | undefined }[] = [];
      for (const [index, route] of indeterminateRoutes.entries()) {
        const file = path.join(dir, `route-${String(index)}.instance.json`);
        await route.place(file);
        const read = await readFingerprint(file);
        const outcome = instanceOutcomeOf(
          read,
          compareChainInstance(
            recordOf(read),
            observed,
          ) as SettledInstanceComparison,
        );
        seen.push({ readKind: read.kind, cause: outcome.instanceBecause });
      }

      // Three different read outcomes, so the routes really are three states.
      expect(seen.map(entry => entry.readKind)).toEqual([
        'absent',
        'record',
        'unreadable',
      ]);
      // And three different causes, so no two collapse into one.
      expect(new Set(seen.map(entry => entry.cause)).size).toBe(
        indeterminateRoutes.length,
      );
      expect(seen.map(entry => entry.cause)).toEqual([
        'no-recorded-identity',
        'recorded-identity-incomplete',
        'fingerprint-unreadable',
      ]);
    });
  });

  it('names the missing field on the incomplete route, since that report is the only surface that fires', async () => {
    await inTempDir(async dir => {
      const file = path.join(dir, 'fingerprint.instance.json');
      await writeRawSidecar(file, {
        schema: FINGERPRINT_SCHEMA,
        chainId: MAINNET_CHAIN_ID,
      });
      const read = await readFingerprint(file);
      const outcome = instanceOutcomeOf(
        read,
        compareChainInstance(recordOf(read), observed) as SettledInstanceComparison,
      );
      // Both hash fields are absent and the comparator stops at the first, so this is
      // `genesisHash` — the field that actually turned the guard off.
      expect(outcome.incompleteField).toBe('genesisHash');
    });
  });

  it('non-vacuity: an unreadable fingerprint is widened, never passed through as "no record"', async () => {
    await inTempDir(async dir => {
      const file = path.join(dir, 'fingerprint.instance.json');
      await fs.writeFile(file, 'not json at all\n', 'utf8');

      const read = await readFingerprint(file);
      expect(read).toEqual({ kind: 'unreadable', because: 'not-json' });

      // What the comparator is handed on this route is `undefined`, so its own answer
      // is "no recorded identity" — true of what it was given, false about what is on
      // disk. Pinned, because it is exactly the value a pass-through would report.
      const comparison = compareChainInstance(recordOf(read), observed);
      const comparatorCause =
        comparison.kind === 'indeterminate' ? comparison.because : undefined;
      expect(comparatorCause).toBe('no-recorded-identity');

      // The report widens it instead. A corrupt fingerprint reported as an absent one
      // is a corrupt fingerprint silently ignored, which disables the check while the
      // check appears to be on.
      const outcome = instanceOutcomeOf(
        read,
        comparison as SettledInstanceComparison,
      );
      expect(outcome.instanceBecause).toBe('fingerprint-unreadable');
      expect(outcome.instanceBecause).not.toBe(comparatorCause);
    });
  });

  it('non-vacuity: a complete, matching fingerprint is `same`, so the routes above are not "everything is indeterminate"', async () => {
    await inTempDir(async dir => {
      const file = path.join(dir, 'fingerprint.instance.json');
      await writeRawSidecar(file, fingerprintFor(observed));

      const read = await readFingerprint(file);
      const comparison = compareChainInstance(recordOf(read), observed);
      expect(comparison).toEqual({ kind: 'same' });
      expect(
        instanceOutcomeOf(read, comparison as SettledInstanceComparison),
      ).toEqual({ instance: 'same' });
    });
  });
});

// ── refusal precedes any write ───────────────────────────────────────────────────

/** All-lowercase, so the spelling asserts no checksum and is not the canonical form. */
const STORED_PROXY = '0xabcdef1234567890abcdef1234567890abcdef12';
const CANONICAL_PROXY = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const STORED_IMPL = '0x1234567890abcdef1234567890abcdef12345678';
const STORED_ADMIN = '0xfedcba0987654321fedcba0987654321fedcba09';
const FIXTURE_TX_HASH = `0x${'11'.repeat(32)}`;

/**
 * A manifest whose stored addresses are **not** canonical.
 *
 * That is what makes the byte-unchanged assertions below measure anything: the
 * load-time migration *would* have rewritten this file, so a refusal that happened
 * after it would be visible in the bytes. Against an already-canonical fixture the
 * same assertions pass whether or not the refusal precedes the write.
 */
const NON_CANONICAL_MANIFEST = {
  manifestVersion: '3.2',
  admin: { address: STORED_ADMIN, txHash: FIXTURE_TX_HASH },
  proxies: [
    { address: STORED_PROXY, txHash: FIXTURE_TX_HASH, kind: 'transparent' },
  ],
  impls: {
    [`${'0'.repeat(63)}1`]: {
      address: STORED_IMPL,
      txHash: FIXTURE_TX_HASH,
      layout: { storage: [], types: {} },
    },
  },
};

/** Three stored address strings, none of them in a spelling the engine can match. */
const PENDING_REWRITES = 3;
/** `proxies.length` + `impls` keys + one for `admin` — the number the refusal cites. */
const FIXTURE_RECORD_COUNT = 3;

/**
 * The chain seam, as seams rather than handles.
 *
 * `provider` is a **throwing getter** rather than a stub: nothing on these paths may
 * hand the engine a provider, and a getter is what makes "may not" measurable instead
 * of merely unasserted.
 */
function seamFor(identity: ChainInstanceIdentity): ChainAccess {
  return {
    get provider(): ChainAccess['provider'] {
      throw new Error(
        'the preflight reached for the engine provider on a path that has none',
      );
    },
    endpoint: Object.freeze({
      describe: identity.observedThrough,
      origin: 'derived' as const,
    }),
    identity: () => Promise.resolve(identity),
    // `deps.chain.read` is dereferenced on every path, so it has to be a value. The
    // one method a named address would reach refuses, and no address is named here.
    read: {
      hasCode: () =>
        Promise.reject(
          new Error('no address was named, so no code-presence read may happen'),
        ),
    } as unknown as ChainAccess['read'],
  };
}

function depsFor(identity: ChainInstanceIdentity): RecordDeps {
  return {
    root: RECORD_DIR as AbsolutePath,
    // One environment view, threaded — the same object the record's directory was
    // fixed in, so the file the engine writes and the file a message names agree.
    env: process.env,
    chain: seamFor(identity),
  };
}

async function placeRecordFixtures(
  recordedFirstBlockHash: string | null,
): Promise<{ readonly manifest: string; readonly sidecar: string }> {
  await fs.mkdir(RECORD_DIR, { recursive: true });
  const manifest = `${JSON.stringify(NON_CANONICAL_MANIFEST, null, 2)}\n`;
  const sidecar = serialized(fingerprintFor(identityFor(recordedFirstBlockHash)));
  await fs.writeFile(MANIFEST_FILE, manifest, 'utf8');
  await fs.writeFile(SIDECAR_FILE, sidecar, 'utf8');
  return { manifest, sidecar };
}

async function clearRecordFixtures(): Promise<void> {
  await fs.rm(MANIFEST_FILE, { force: true });
  await fs.rm(SIDECAR_FILE, { force: true });
}

describe('the refusal happens before any write, with both files byte-unchanged', () => {
  it('refuses with a migration pending, and touches neither file', async () => {
    const before = await placeRecordFixtures(mainnetFirstBlockHash);
    try {
      // Asserted rather than assumed. If any of these four went the other way the
      // byte assertions further down would be vacuous.
      expect(isCanonicalAddress(STORED_PROXY)).toBe(false);
      expect(isCanonicalAddress(STORED_IMPL)).toBe(false);
      expect(isCanonicalAddress(STORED_ADMIN)).toBe(false);
      expect(canonicalizeAddress(STORED_PROXY)).toBe(CANONICAL_PROXY);

      const pending = canonicalizeStoredAddresses(
        // Cast because the engine's own `StorageLayout` carries fields this fixture
        // has no reason to invent; only the address strings are under test.
        NON_CANONICAL_MANIFEST as unknown as ManifestData,
      );
      expect(pending.rewritten).toBe(PENDING_REWRITES);
      expect(pending.unmigratable).toBe(0);

      // The node was wiped and restarted: same chain id, same genesis hash, a
      // different block 1.
      const failure = await openRecord(
        depsFor(identityFor(REBOOTED_FIRST_BLOCK_HASH)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(ChainInstanceChangedError);
      const refusal = failure as ChainInstanceChangedError;
      expect(refusal.comparison.signal).toBe('first-block-hash');
      expect(refusal.context.manifestFile).toBe(MANIFEST_FILE);
      expect(refusal.context.sidecarFile).toBe(SIDECAR_FILE);
      // Truthful about a file it did not touch — the count is what the user acts on.
      expect(refusal.context.recordCount).toBe(FIXTURE_RECORD_COUNT);

      expect(await fs.readFile(MANIFEST_FILE, 'utf8')).toBe(before.manifest);
      expect(await fs.readFile(SIDECAR_FILE, 'utf8')).toBe(before.sidecar);
    } finally {
      await clearRecordFixtures();
    }
  });

  it('non-vacuity: with the refusal removed and nothing else changed, the same run does rewrite the manifest', async () => {
    const before = await placeRecordFixtures(mainnetFirstBlockHash);
    try {
      const session = await openRecord(depsFor(identityFor(mainnetFirstBlockHash)));
      expect(session.manifestFile).toBe(MANIFEST_FILE);
      expect(session.fingerprintFile).toBe(SIDECAR_FILE);
      expect(session.report.instance).toBe('same');
      expect(session.report.addressesMigrated).toBe(PENDING_REWRITES);
      expect(session.report.addressesUnmigratable).toBe(0);

      // The write the refusal withheld happens here. That is what proves the previous
      // test measured the ordering rather than an inert code path.
      const after = await fs.readFile(MANIFEST_FILE, 'utf8');
      expect(after).not.toBe(before.manifest);
      const rewritten = JSON.parse(after) as {
        readonly proxies: readonly { readonly address: string }[];
      };
      expect(rewritten.proxies[0]?.address).toBe(CANONICAL_PROXY);

      // The fingerprint already matched, so nothing was written to it and no second
      // divergence was manufactured.
      expect(await fs.readFile(SIDECAR_FILE, 'utf8')).toBe(before.sidecar);
    } finally {
      await clearRecordFixtures();
    }
  });
});

// ── obeying the printed remedy recovers ──────────────────────────────────────────

describe('obeying the printed remedy recovers — measured, not assumed', () => {
  it('the deletions the message names, performed verbatim, leave the next run proceeding and re-armed', async () => {
    await placeRecordFixtures(mainnetFirstBlockHash);
    try {
      const failure = await openRecord(
        depsFor(identityFor(REBOOTED_FIRST_BLOCK_HASH)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(ChainInstanceChangedError);
      const message = (failure as ChainInstanceChangedError).message;

      // The remedy names BOTH files, together. Measured from a consumer
      // project against a restarted TRE: the manifest alone leaves the
      // surviving fingerprint refusing the next run over zero records.
      expect(message).toContain(
        `delete ${MANIFEST_FILE} together with its fingerprint file ${SIDECAR_FILE}`,
      );
      // And the third place that remembers the old chain — TronBox's
      // per-network write-backs in the build artifacts — with its command.
      expect(message).toContain('tronbox compile --all');

      // Obey it: exactly the two files the message names, nothing else.
      await fs.rm(MANIFEST_FILE, { force: true });
      await fs.rm(SIDECAR_FILE, { force: true });

      // The re-run proceeds on first-run semantics and re-arms against the
      // chain that is actually answering.
      const session = await openRecord(
        depsFor(identityFor(REBOOTED_FIRST_BLOCK_HASH)),
      );
      expect(session.fingerprintFile).toBe(SIDECAR_FILE);
      const rearmed = JSON.parse(await fs.readFile(SIDECAR_FILE, 'utf8')) as {
        readonly firstBlockHash: string;
      };
      expect(rearmed.firstBlockHash).toBe(REBOOTED_FIRST_BLOCK_HASH);
    } finally {
      await clearRecordFixtures();
    }
  });

  it('non-vacuity: the manifest alone — the remedy as previously worded — still refuses, over zero records', async () => {
    await placeRecordFixtures(mainnetFirstBlockHash);
    try {
      await fs.rm(MANIFEST_FILE, { force: true });

      const failure = await openRecord(
        depsFor(identityFor(REBOOTED_FIRST_BLOCK_HASH)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      // The gate runs on the fingerprint, so the deletion the old wording
      // prescribed changes nothing — and the refusal now guards a manifest
      // with nothing in it. This is the loop the reworded remedy exits.
      expect(failure).toBeInstanceOf(ChainInstanceChangedError);
      expect((failure as ChainInstanceChangedError).context.recordCount).toBe(0);
    } finally {
      await clearRecordFixtures();
    }
  });
});

// ── the refusal names both files ─────────────────────────────────────────────────

/** The clause's opening words, and the remedy paragraph it has to precede. */
const CLAUSE_OPENING = 'The chain fingerprint these records were checked against';
const REMEDY_OPENING = 'Nothing has been changed or removed';

/**
 * A real refusal message, rendered from a real comparison rather than a hand-built
 * change object, so the text under test is the text a user gets.
 */
function refusalMessage(sidecarFile?: string): string {
  const change = compareChainInstance(
    {
      chainId: MAINNET_CHAIN_ID,
      genesisHash: mainnetGenesisHash,
      firstBlockHash: mainnetFirstBlockHash,
    },
    identityFor(REBOOTED_FIRST_BLOCK_HASH),
  ) as ChainInstanceChange;
  const base = {
    manifestFile: MANIFEST_FILE,
    recordCount: FIXTURE_RECORD_COUNT,
    endpoint: OBSERVED_THROUGH,
  };
  // Two branches rather than `sidecarFile: undefined`, because the package compiles
  // with exact optional property types and an explicit `undefined` is not an omission.
  return new ChainInstanceChangedError(
    change,
    sidecarFile === undefined ? base : { ...base, sidecarFile },
  ).message;
}

describe('the refusal names both files, and says that neither deletion alone resets anything', () => {
  it('names both files, so the remedy cannot be read as "delete the unfamiliar one"', () => {
    const message = refusalMessage(SIDECAR_FILE);
    expect(message).toContain(MANIFEST_FILE);
    expect(message).toContain(SIDECAR_FILE);
  });

  it('states that deleting the fingerprint and removing a field from it both reset nothing', () => {
    const message = refusalMessage(SIDECAR_FILE);
    // Both prohibitions in one clause, because they are one hazard reachable two ways.
    expect(message).toContain(
      'Deleting that file — or removing a field from it — resets nothing',
    );
    expect(message).toContain(
      'nothing can tell a cleared fingerprint from a first run',
    );
    expect(message).toContain('do not delete the fingerprint on its own');
  });

  it('places the clause ahead of the remedy, since a clause after "delete X and run again" is read by a user who has already decided', () => {
    const message = refusalMessage(SIDECAR_FILE);
    const clauseAt = message.indexOf(CLAUSE_OPENING);
    const remedyAt = message.indexOf(REMEDY_OPENING);
    expect(clauseAt).toBeGreaterThanOrEqual(0);
    expect(remedyAt).toBeGreaterThan(clauseAt);
  });

  it('non-vacuity: with no sidecar path the clause disappears, so a grep for it is not a grep for boilerplate', () => {
    const withClause = refusalMessage(SIDECAR_FILE);
    const withoutClause = refusalMessage();

    expect(withoutClause).not.toContain(SIDECAR_FILE);
    expect(withoutClause).not.toContain(CLAUSE_OPENING);
    expect(withoutClause).not.toContain('resets nothing');
    expect(withoutClause).not.toContain('do not delete the fingerprint on its own');
    // Still names the manifest, so what vanished above is the clause and not the
    // message.
    expect(withoutClause).toContain(MANIFEST_FILE);

    // And the two differ in exactly two sidecar-shaped places: the clause, and
    // the remedy's deletion target ("together with its fingerprint file …").
    // The artifacts sentence — the third place that remembers the old chain —
    // is present in BOTH branches, because the write-backs exist whether or
    // not a fingerprint sidecar does.
    expect(withoutClause).not.toContain('together with its fingerprint file');
    expect(withClause).toContain('together with its fingerprint file');
    expect(withClause).toContain('tronbox compile --all');
    expect(withoutClause).toContain('tronbox compile --all');
  });
});

// ── The sidecar read gate ───────────────────────────────────────────────────────

/**
 * The shape the gate exists for: both hash fields **present** and holding `null`.
 *
 * Reachable by hand-editing, and by any well-meaning script that "clears" a field.
 */
const CORRUPT_SIDECAR: Readonly<Record<string, unknown>> = Object.freeze({
  schema: FINGERPRINT_SCHEMA,
  chainId: MAINNET_CHAIN_ID,
  genesisHash: null,
  firstBlockHash: null,
});

describe('the sidecar read gate — both halves, because a bypass never shown to fail is not evidence', () => {
  it('half one: the ungated shape really does throw a raw TypeError inside the comparator', () => {
    const observed = identityFor(mainnetFirstBlockHash);
    // The comparator tests `genesisHash` for `undefined` rather than for a string, so
    // an explicit `null` falls straight through into a helper typed over `string`.
    expect(() =>
      compareChainInstance(
        CORRUPT_SIDECAR as unknown as RecordedChainInstance,
        observed,
      ),
    ).toThrow(TypeError);
  });

  it('half two: the gate intercepts those same bytes, and never launders them into "no record"', async () => {
    await inTempDir(async dir => {
      const file = path.join(dir, 'fingerprint.instance.json');
      await writeRawSidecar(file, CORRUPT_SIDECAR);

      const read = await readFingerprint(file);
      expect(read).toEqual({ kind: 'unreadable', because: 'hash-field-unusable' });
      // A file that exists and cannot be used is its own state, not an absent one.
      expect(read.kind).not.toBe('absent');

      const observed = identityFor(mainnetFirstBlockHash);
      // The same bytes, now through the gate: the comparator receives `undefined`
      // rather than the corrupt record, and the TypeError above is unreachable.
      expect(() => compareChainInstance(recordOf(read), observed)).not.toThrow();

      const outcome = instanceOutcomeOf(
        read,
        compareChainInstance(recordOf(read), observed) as SettledInstanceComparison,
      );
      expect(outcome.instanceBecause).toBe('fingerprint-unreadable');
      expect(outcome.instanceBecause).not.toBe('no-recorded-identity');

      // This is the classifier's answer in isolation, and it is unchanged: the
      // classifier is still total. `openRecord` never puts these exact bytes in
      // front of it — its session gate refuses on `read.kind === 'unreadable'`
      // first. The describe block below drives the same shape of bytes through
      // `openRecord` itself and pins the refusal, not this report.
    });
  });
});

/**
 * **The property this section pins: corrupt refuses, absent proceeds.** Both are
 * fingerprints `instanceOutcomeOf` would call `indeterminate` if it were ever asked —
 * but only one of them is ever asked. `openRecord`'s session gate reads the sidecar
 * before it compares anything, and it refuses on `read.kind === 'unreadable'` — a file
 * that exists and cannot be used — while letting `read.kind === 'absent'` fall through
 * to the classifier exactly as before. The two are not the same evidence: absence says
 * nothing has happened yet, and every existing project is in that state on its first
 * run; corruption says something already went wrong with a file this plugin owns, and
 * a chain that wiped and restarted is one candidate explanation among others. Proceeding
 * past that — reporting it honestly, but proceeding — is the silent continue this
 * section used to pin as correct and now pins as fixed.
 */
describe('the session gate refuses a corrupt fingerprint before any write, naming both exits — and still proceeds on an absent one', () => {
  it('refuses a non-JSON sidecar, naming both exits, and touches neither file', async () => {
    await fs.mkdir(RECORD_DIR, { recursive: true });
    const bytes = 'not json at all\n';
    await fs.writeFile(SIDECAR_FILE, bytes, 'utf8');
    try {
      const failure = await openRecord(
        depsFor(identityFor(mainnetFirstBlockHash)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(RecordFingerprintUnreadableError);
      expect((failure as Error).constructor).toBe(
        RootRecordFingerprintUnreadableError,
      );
      const refusal = failure as RecordFingerprintUnreadableError;
      expect(refusal.because).toBe('not-json');
      expect(refusal.file).toBe(SIDECAR_FILE);

      // Both exits, in the readable-mismatch refusal's own wording: same chain,
      // delete the fingerprint file and re-run; node wiped, delete the record
      // and the fingerprint and redeploy.
      expect(refusal.message).toContain('delete the fingerprint file and re-run');
      expect(refusal.message).toContain(
        'delete the record file and the fingerprint',
      );
      expect(refusal.message).toContain('redeploy');

      // Nothing was written: the sidecar is exactly the bytes this test wrote, and
      // no manifest was ever created to write it into.
      expect(await fs.readFile(SIDECAR_FILE, 'utf8')).toBe(bytes);
      await expect(fs.readFile(MANIFEST_FILE, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await clearRecordFixtures();
    }
  });

  it('refuses on a hash-field-unusable sidecar too, so the gate is not specific to one cause', async () => {
    await fs.mkdir(RECORD_DIR, { recursive: true });
    const bytes = await writeRawSidecar(SIDECAR_FILE, CORRUPT_SIDECAR);
    try {
      const failure = await openRecord(
        depsFor(identityFor(mainnetFirstBlockHash)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(RecordFingerprintUnreadableError);
      expect((failure as RecordFingerprintUnreadableError).because).toBe(
        'hash-field-unusable',
      );

      // Never rewritten: what the old behaviour did here — proceed, and rewrite
      // the sidecar at full width — is exactly what this refusal withholds.
      expect(await fs.readFile(SIDECAR_FILE, 'utf8')).toBe(bytes);
      expect(await readFingerprint(SIDECAR_FILE)).toEqual({
        kind: 'unreadable',
        because: 'hash-field-unusable',
      });
    } finally {
      await clearRecordFixtures();
    }
  });

  it('refuses ahead of the canonicalization migration too, leaving a manifest with pending rewrites byte-unchanged', async () => {
    await fs.mkdir(RECORD_DIR, { recursive: true });
    const manifestBytes = `${JSON.stringify(NON_CANONICAL_MANIFEST, null, 2)}\n`;
    await fs.writeFile(MANIFEST_FILE, manifestBytes, 'utf8');
    const sidecarBytes = await writeRawSidecar(SIDECAR_FILE, CORRUPT_SIDECAR);
    try {
      const failure = await openRecord(
        depsFor(identityFor(mainnetFirstBlockHash)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(RecordFingerprintUnreadableError);

      // The migration that would have rewritten the stored addresses to their
      // canonical form never runs: both files are exactly what this test wrote,
      // which is what "before any write" has to mean when a rewrite is pending.
      expect(await fs.readFile(MANIFEST_FILE, 'utf8')).toBe(manifestBytes);
      expect(await fs.readFile(SIDECAR_FILE, 'utf8')).toBe(sidecarBytes);
    } finally {
      await clearRecordFixtures();
    }
  });

  it('non-vacuity: an absent sidecar still proceeds, so the refusal above is about corruption and not mere absence', async () => {
    await fs.mkdir(RECORD_DIR, { recursive: true });
    try {
      await expect(fs.readFile(SIDECAR_FILE, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const session = await openRecord(depsFor(identityFor(mainnetFirstBlockHash)));
      expect(session.report.instance).toBe('indeterminate');
      expect(session.report.instanceBecause).toBe('no-recorded-identity');

      // Proceeding means writing the current chain's fingerprint, so the guard has
      // something to compare against on the next run.
      const written = await readFingerprint(SIDECAR_FILE);
      expect(written.kind).toBe('record');
      expect(recordOf(written)?.genesisHash).toBe(mainnetGenesisHash);
    } finally {
      await clearRecordFixtures();
    }
  });
});

describe('the fingerprint remedy table names both exits for every cause', () => {
  const causes = Object.keys(
    recordRemedyTables.fingerprint,
  ) as FingerprintUnreadableCause[];

  it('has seven causes, so the audit below is not vacuously short', () => {
    expect(causes).toHaveLength(7);
  });

  it('names both exits in every cause\'s remedy, in the readable-mismatch refusal\'s own wording', () => {
    for (const because of causes) {
      const remedy = recordRemedyTables.fingerprint[because];
      expect(remedy, `remedy for ${because}`).toContain(
        'delete the fingerprint file and re-run',
      );
      expect(remedy, `remedy for ${because}`).toContain(
        'delete the record file and the fingerprint',
      );
      expect(remedy, `remedy for ${because}`).toContain('redeploy');
    }
  });

  it('renders a distinct message per cause, so the audit is not passing by coincidence', () => {
    const messages = new Set(
      causes.map(
        because =>
          new RecordFingerprintUnreadableError(SIDECAR_FILE, because).message,
      ),
    );
    expect(messages.size).toBe(causes.length);
  });
});
