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
 * 5. **Refuse on a changed instance, before any write.** The refusal message promises
 *    *"Nothing has been changed or removed."* If the refusal came after step 6 it would
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
 *   records were written against. The chain seam owns that message and never throws it;
 *   deciding that refusal is the policy is this layer's act. **Nothing has been written
 *   when it is raised.**
 * @throws {AddressNotCanonicalizableError} an address the operation named is not a
 *   usable TRON address. An address already *stored* in the manifest is never a reason
 *   to refuse — it is left as it is and reported.
 * @throws {ChainResultShapeError} the chain reports a chain id that is not a hex
 *   quantity parsing to a positive integer.
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
  const data = await manifest.read();

  // Step 5. The refusal, before any write.
  if (comparison.kind === 'changed') {
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
  const settled: SettledInstanceComparison = comparison;

  // Step 6. Nothing at all on the steady-state path: comparator says the same
  // instance, so the fingerprint on disk already matches and there is nothing to
  // write; if the stored addresses are already canonical there is nothing to migrate
  // either, and no lock is taken.
  const needsFingerprint = settled.kind === 'indeterminate';
  let migration = canonicalizeStoredAddresses(data);
  let addressesMigrated = 0;

  if (needsFingerprint || migration.rewritten > 0) {
    const written = await manifest.lockedRun(async () => {
      if (needsFingerprint) {
        await writeFingerprint(fingerprintFile, fingerprintFor(identity));
      }
      // Re-read inside the lock rather than reusing the snapshot from before it: that
      // read was unsynchronized, so another process may have written since.
      const locked = canonicalizeStoredAddresses(await manifest.read());
      if (locked.rewritten > 0) {
        await manifest.write(locked.data);
      }
      return locked;
    });
    migration = written;
    addressesMigrated = written.rewritten;
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
    outcome: instanceOutcomeOf(read, settled),
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
    getProxyRecord: (address: string): Promise<ProxyDeployment | undefined> =>
      manifest.proxyRecord(canonicalizeAddress(address)),
    getImplRecord: (address: string): Promise<ImplDeployment | undefined> =>
      manifest.implRecord(canonicalizeAddress(address)),
    addProxyRecord: (record: {
      readonly address: string;
      readonly kind: ProxyDeployment['kind'];
    }): Promise<void> =>
      manifest.addProxyRecord({
        address: canonicalizeAddress(record.address),
        kind: record.kind,
      }),
    recordCount: async (): Promise<number> => recordCount(await manifest.read()),
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
