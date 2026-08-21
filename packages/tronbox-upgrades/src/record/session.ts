/**
 * The preflight, and **the order is the design.**
 *
 * Every step sits where it does because of a measured fact about what happens if it
 * runs later:
 *
 * 1. **Configure the location first.** The engine reads the record's directory from the
 *    environment once, at module load. After that, setting it is a silent no-op.
 * 2. **Resolve the chain identity.** Memoized by the chain seam, so it is one round
 *    trip per session however many times it is asked for.
 * 3. **Assert the resolved path** — absolute, and under the directory this plugin
 *    resolved. Trusting step 1 is precisely the failure mode: a record in the wrong
 *    directory with no error.
 * 4. **Read the fingerprint and compare, before the engine has probed anything.** The
 *    engine's own probes are what delete a record: on a wiped chain its implementation
 *    store clears the entry and writes the manifest *before* rethrowing. So the
 *    comparison has to precede the first of those, and it is cheap to arrange because
 *    the comparator is pure and total. **A file that exists and cannot be used refuses
 *    right here, before the comparison it would otherwise feed.** An unusable
 *    fingerprint is not an absent one — absence is the state every existing project is
 *    in on its first run, and must never refuse; corruption is evidence something has
 *    already gone wrong with a file this plugin owns, and proceeding past it is exactly
 *    the silent continue this refusal exists to close. The refusal carries a diagnosis
 *    — do the recorded proxies exist at this endpoint? — so it reads the manifest and
 *    asks the chain for code before throwing: reads only, failure-tolerant, and still
 *    ahead of every write.
 * 5. **Refuse on a changed instance, before any write** — unless the record holds
 *    zero deployments, where the gate re-arms the fingerprint instead (the
 *    emptiness is re-checked under step 6's lock before the write). The refusal
 *    message promises *"Nothing has been changed or removed."* If the refusal came after step 6 it would
 *    already have rewritten the manifest's address casing and the promise would be
 *    false. The chain seam could not have guaranteed this — it has no filesystem access
 *    at all — which is why the guarantee is this module's.
 * 6. **One lock, and only when there is something to write: fingerprint first, then the
 *    address migration.** The engine writes the manifest inside its *own* lock and a
 *    nested lock throws, so these two writes cannot be made atomic with the engine's; a
 *    crash can always land between them. The choice is not whether a divergence exists
 *    but which one. Fingerprint-first leaves *fingerprint present, manifest absent* — a
 *    fingerprint that guards nothing, rewritten on the next run at no cost. The other
 *    order leaves *manifest present, fingerprint absent*, whose correct disposition is
 *    never to refuse — which is exactly what turns a crash window into a silent
 *    blessing of records from a chain that no longer exists. The ordering *within* the
 *    lock matters for the same reason: migrating first and then failing to write the
 *    fingerprint would have the preflight manufacture the bad divergence itself.
 * 7. **Return.** The lock is released before the session exists, so the engine's own
 *    lock cannot nest inside it.
 */

import { ChainInstanceChangedError, compareChainInstance } from '../chain';
import type {
  ImplDeployment,
  ProxyDeployment,
} from '@openzeppelin/upgrades-core';
import { canonicalizeAddress } from './address';
import {
  RecordFingerprintUnreadableError,
  type FingerprintRefusalDiagnosis,
} from './errors';
import { assertRecordLocation, configureRecordLocation } from './location';
import {
  canonicalizeStoredAddresses,
  openRecordManifest,
  recordCount,
  type RecordManifest,
} from './manifest';
import {
  buildReport,
  instanceOutcomeOf,
  reconcileProxies,
  type CodePresence,
  type SettledInstanceComparison,
} from './reconcile';
import {
  fingerprintFor,
  fingerprintPathFor,
  readFingerprint,
  writeFingerprint,
} from './sidecar';
import { throughRecordLock, throughRecordRead } from './refusals';
import type { RecordDeps, RecordSession } from './types';

/**
 * Anchors the deployment record, verifies the chain instance against the persisted
 * fingerprint, migrates stored addresses to the canonical form, and returns the one
 * handle every operation uses to reach the record.
 *
 * @throws {RecordLocationUnusableError} the anchor is not absolute, or the resolved
 *   record path is not under it — including the case where something loaded the engine
 *   before the anchor was set, which is otherwise silent.
 * @throws {RecordFingerprintUnreadableError} the fingerprint sidecar exists and cannot
 *   be used — corrupt, not merely absent. Still the earliest of this function's
 *   refusals and still ahead of every write, but no longer the cheapest: it carries a
 *   diagnosis of whether the recorded proxies exist at this endpoint, which reads the
 *   manifest (through the engine's own reader, transient lock and all) and asks the
 *   chain for code — reads only, and failure-tolerant, so a manifest or chain that
 *   cannot answer degrades the diagnosis to `indeterminate` rather than masking this
 *   refusal. An absent sidecar is a different state and never reaches this throw.
 * @throws {ChainInstanceChangedError} the chain reports a different instance than the
 *   records were written against AND the record holds at least one deployment. The
 *   chain seam owns that message and never throws it; deciding that refusal is the
 *   policy is this layer's act. **Nothing has been written when it is raised**,
 *   from either throw site — the unlocked routing read or the locked re-check.
 *   Over an empty record the gate re-arms the fingerprint instead, reports
 *   `instance: 're-armed'`, and discloses through `deps.disclose`.
 * @throws {AddressNotCanonicalizableError} an address the operation named is not a
 *   usable TRON address. An address already *stored* in the manifest is never a reason
 *   to refuse — it is left as it is and reported.
 * @throws {ChainResultShapeError} the chain reports a chain id that is not a hex
 *   quantity parsing to a positive integer.
 * @throws {RecordUnreadableError} the deployment record exists and cannot be read —
 *   not JSON, or contents the engine refuses. Replaces the engine's bare
 *   `SyntaxError`, which named neither the file nor a way out.
 * @throws {RecordLockedError} another run holds the record's lock. Raised after the
 *   engine's own retries, so it is a real race rather than a timing hiccup, and
 *   **nothing has been written** when it is raised from this function.
 */
export async function openRecord(deps: RecordDeps): Promise<RecordSession> {
  // Step 1. Idempotent, and called again here on purpose: the entry module has already
  // called it before its first engine-touching import, and a second call must leave the
  // same value in force rather than overwrite a user's own.
  const location = configureRecordLocation(deps.root, deps.env);

  // Step 2.
  const identity = await deps.chain.identity();

  // Step 3. The assertion is on the **outcome** — the path the engine produced — never
  // on the assignment, because three reachable states make the assignment succeed while
  // the location is still wrong and only the outcome catches all three.
  const manifest = await openRecordManifest(identity.chainId);
  const manifestFile = assertRecordLocation(location, manifest.file);
  const fingerprintFile = fingerprintPathFor(manifestFile);

  // Step 4.
  const read = await readFingerprint(fingerprintFile);

  // A file that exists and cannot be used is refused here, ahead of every write and
  // of the comparison itself. The refusal answers its own question first (review
  // r3787429147): with the manifest handle and the chain reader both already in
  // hand, it checks whether the recorded proxies exist at this endpoint and reports
  // THE case instead of listing possibilities. That diagnosis is reads only — the
  // manifest through the engine's own reader (whose transient lock is the same
  // unavoidable nuance the step-5 comment below documents) and one `hasCode` per
  // recorded proxy until the first hit — and failure-tolerant by design: a manifest
  // that cannot be read either, or a chain that does not answer, degrades it to
  // `indeterminate` rather than masking this refusal with a different error. An
  // absent fingerprint is not this: `read.kind` is `'record'` or `'absent'` from
  // here on, and both still reach the comparator.
  if (read.kind === 'unreadable') {
    throw new RecordFingerprintUnreadableError(
      fingerprintFile,
      read.because,
      await diagnoseFingerprintRefusal(manifest, deps.chain.read),
    );
  }

  const comparison = compareChainInstance(
    read.kind === 'record' ? read.record : undefined,
    identity,
  );

  // One read of the record, used for the refusal's count and for the decision about
  // whether anything needs migrating. Through the engine's own reader, so the manifest
  // version migration and the refusal of an older CLI-format file both still apply.
  //
  // **One precision about what "before any write" can mean.** The engine's `read`
  // acquires and releases its own lock internally, and acquiring that lock creates the
  // record directory if it is absent. There is no unlocked read on its public surface,
  // and the refusal has to carry a truthful record count, so a transient lock on the
  // refusal path is unavoidable rather than a choice. What the refusal's promise —
  // *"Nothing has been changed or removed"* — is about is preserved exactly: no
  // `lockedRun` is entered, neither the manifest nor the fingerprint is created or
  // modified, and in particular the address migration below has not run.
  const data = await throughRecordRead(manifestFile, () => manifest.read());

  // Step 5. The refusal, before any write — unless the record guards NOTHING.
  // A fingerprint over zero deployments blocks the printed remedy's own next run
  // (the manifest is deleted, the sidecar survives) while protecting no record,
  // so with zero records the gate re-arms instead: the fingerprint is rewritten
  // to the live instance under the step-6 lock, and the report names the cause.
  // The precedent is half-supportive and says so: upstream's engine silently
  // deletes invalid deployments and redeploys, but only behind its
  // `isDevelopmentNetwork` gate, which is false on TRON (`chain/errors.ts`) —
  // so this re-arm can fire on any network. What justifies proceeding anyway
  // is that the record guards nothing AND the re-arm is disclosed, never
  // silent. The emptiness seen here is re-checked under the lock below.
  const rearmOverEmptyRecord =
    comparison.kind === 'changed' && recordCount(data) === 0;
  if (comparison.kind === 'changed' && !rearmOverEmptyRecord) {
    throw new ChainInstanceChangedError(comparison, {
      manifestFile,
      recordCount: recordCount(data),
      // Passed through already scrubbed. Never reconstructed from this layer's own view
      // of the network configuration: that is how an API key in a query string ends up
      // in a CI log.
      endpoint: identity.observedThrough,
      // Names the second file the user can see, so the remedy cannot be read as
      // "delete the unfamiliar one".
      sidecarFile: fingerprintFile,
    });
  }
  // `settled` is undefined exactly on the re-arm path: `changed` stays
  // unrepresentable in the report (reconcile.ts's rule), so that path reports
  // itself as `re-armed` below instead of flowing the comparison through.
  const settled: SettledInstanceComparison | undefined =
    comparison.kind === 'changed' ? undefined : comparison;
  const changedComparison = comparison.kind === 'changed' ? comparison : undefined;

  // Step 6. Nothing at all on the steady-state path: comparator says the same
  // instance, so the fingerprint on disk already matches and there is nothing to
  // write; if the stored addresses are already canonical there is nothing to migrate
  // either, and no lock is taken.
  const needsFingerprint =
    settled === undefined || settled.kind === 'indeterminate';
  let migration = canonicalizeStoredAddresses(data);
  let addressesMigrated = 0;

  if (needsFingerprint || migration.rewritten > 0) {
    // Lock-only wrapping here, never the wide read arm: this callback runs code
    // of ours — the fingerprint write and the address migration — and their
    // refusals must reach the caller as themselves rather than be reinterpreted
    // as "the record file cannot be read".
    const written = await throughRecordLock(manifestFile, () =>
      manifest.lockedRun(async () => {
        // Re-read FIRST, inside the lock: the snapshot from before it was
        // unsynchronized, so another process may have written since.
        const locked = canonicalizeStoredAddresses(await manifest.read());
        if (changedComparison !== undefined && recordCount(locked.data) > 0) {
          // The emptiness that routed here is stale: a record was written
          // between the read and the lock, so the guard has something to
          // protect after all — the refusal revives, with the locked count,
          // and nothing has been written on this path either.
          throw new ChainInstanceChangedError(changedComparison, {
            manifestFile,
            recordCount: recordCount(locked.data),
            endpoint: identity.observedThrough,
            sidecarFile: fingerprintFile,
          });
        }
        if (needsFingerprint) {
          await writeFingerprint(fingerprintFile, fingerprintFor(identity));
        }
        if (locked.rewritten > 0) {
          await manifest.write(locked.data);
        }
        return locked;
      }),
    );
    migration = written;
    addressesMigrated = written.rewritten;

    if (changedComparison !== undefined) {
      // Persisted, so say so: a silent retarget of the guard is invisible
      // exactly when it matters.
      deps.disclose('chain fingerprint re-armed', [
        `The chain at ${identity.observedThrough} is a different instance ` +
          `of chain ${identity.chainId} than the fingerprint remembered.`,
        'The record held no deployments, so the fingerprint was rewritten ' +
          'to the live chain instead of refusing.',
      ]);
    }
  }

  const verdicts = await reconcileProxies(
    deps.addresses ?? [],
    // Taken against the migrated snapshot, so a record this run has just brought to
    // canonical form is found by this run rather than only by the next one.
    migration.data.proxies,
    deps.chain.read,
  );

  const report = buildReport({
    chainId: identity.chainId,
    outcome:
      settled === undefined
        ? Object.freeze({ instance: 're-armed' } as const)
        : instanceOutcomeOf(read, settled),
    addressesMigrated,
    addressesUnmigratable: migration.unmigratable,
    proxies: verdicts,
  });

  // Step 7.
  return Object.freeze({
    manifestFile,
    fingerprintFile,
    identity,
    report,
    // Every accessor goes through the record-file wrapper. Each one is a bare
    // engine call whose whole throw surface is the record file and its lock, so
    // the wide arm is precise here for the same reason it is at the read above —
    // and a caller that reaches one of these mid-migration is exactly who must
    // not receive a bare `SyntaxError` or a raw `ELOCKED`. The address
    // canonicalization runs OUTSIDE the wrapper: its refusal is its own.
    getProxyRecord: (address: string): Promise<ProxyDeployment | undefined> => {
      const key = canonicalizeAddress(address);
      return throughRecordRead(manifestFile, () => manifest.proxyRecord(key));
    },
    getImplRecord: (address: string): Promise<ImplDeployment | undefined> => {
      const key = canonicalizeAddress(address);
      return throughRecordRead(manifestFile, () => manifest.implRecord(key));
    },
    addProxyRecord: (record: {
      readonly address: string;
      readonly kind: ProxyDeployment['kind'];
    }): Promise<void> => {
      const key = canonicalizeAddress(record.address);
      return throughRecordRead(manifestFile, () =>
        manifest.addProxyRecord({ address: key, kind: record.kind }),
      );
    },
    recordCount: async (): Promise<number> =>
      recordCount(await throughRecordRead(manifestFile, () => manifest.read())),
    throughLock: <T,>(action: () => Promise<T>): Promise<T> =>
      throughRecordLock(manifestFile, action),
  });
}

/**
 * The corrupt-fingerprint refusal's diagnosis: do the recorded PROXIES exist
 * at this endpoint? Proxies only, never implementations — a manifest holding
 * implementations but no proxies has nothing this check can vouch for, and
 * that is the `no-proxies` answer, not a live one.
 *
 * Read-only, and failure-tolerant BY DESIGN: this runs inside a refusal whose
 * text promises nothing has been changed or removed, so it may read the
 * manifest (the engine's `read` takes and releases its own transient lock —
 * the same unavoidable nuance `openRecord`'s step-5 comment documents) and
 * ask the chain for code, and nothing else. Any failure inside the diagnosis
 * — the manifest unreadable too, the chain unreachable — answers
 * `indeterminate` rather than masking the fingerprint refusal this decorates.
 * The loop stops at the first live proxy: one hit is enough for the one
 * conclusion the disposition draws from it — deleting the record file RISKS
 * abandoning a real deployment. Code presence cannot prove chain identity
 * (a reset node or another endpoint can hold other code at the same
 * address), and the `proxies-live` disposition says so rather than claiming
 * more than the evidence supports.
 */
async function diagnoseFingerprintRefusal(
  manifest: RecordManifest,
  read: CodePresence,
): Promise<FingerprintRefusalDiagnosis> {
  try {
    // Deliberately NOT through `throughRecordRead`: that wide arm converts a
    // failed read into `RecordUnreadableError`, and raising here would mask
    // the fingerprint refusal this diagnosis decorates with a different
    // error about a different file. The catch below is this call's whole
    // contract — any failure is the `indeterminate` diagnosis, never a throw.
    const proxies = (await manifest.read()).proxies ?? [];
    if (proxies.length === 0) {
      return 'no-proxies';
    }
    for (const proxy of proxies) {
      if (await read.hasCode(proxy.address)) {
        return 'proxies-live';
      }
    }
    return 'proxies-absent';
  } catch {
    return 'indeterminate';
  }
}
