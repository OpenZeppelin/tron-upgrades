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
 *    the comparator is pure and total.
 * 5. **Refuse here, before any write.** The refusal message promises *"Nothing has been
 *    changed or removed."* If the refusal came after step 6 it would already have
 *    rewritten the manifest's address casing and the promise would be false. The chain
 *    seam could not have guaranteed this — it has no filesystem access at all — which
 *    is why the guarantee is this module's.
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
import { assertRecordLocation, configureRecordLocation } from './location';
import {
  canonicalizeStoredAddresses,
  openRecordManifest,
  recordCount,
} from './manifest';
import {
  buildReport,
  instanceOutcomeOf,
  reconcileProxies,
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
