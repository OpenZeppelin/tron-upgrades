/**
 * The typed, canonicalizing wrapper over the engine's deployment record.
 *
 * **The only module in the package that names the engine's `Manifest`**, and the only
 * one that calls its address-taking methods. That is what makes "one canonical form,
 * one entry point" enforceable by a scan rather than by review: a module elsewhere
 * that constructed its own record handle would get one whose directory depends on
 * whatever the location variable held at *its* module-load time, would query it with
 * an un-minted address, and — because the engine returns an empty record rather than
 * an error when the file is absent — would get a clean empty manifest back. Every
 * proxy would look unrecorded.
 *
 * The engine is reached by **dynamic** import, deliberately. Its manifest module reads
 * the record's directory from the environment once, at module load, so any *static*
 * import of the engine anywhere in the entry module's closure freezes that directory
 * before the plugin has a chance to set it. The types are imported statically because
 * `import type` is erased and cannot load anything.
 *
 * Writes go through the engine's **own** `write`, never around it. That is not
 * incidental: `write` is what applies the engine's normalization whitelist and its
 * manifest-version migration, including the refusal of an older CLI-format file by
 * version. Writing the file directly would fork the schema and skip the migration.
 */

import type {
  ImplDeployment,
  Manifest,
  ManifestData,
  ProxyDeployment,
} from '@openzeppelin/upgrades-core';
import { requireResultShape } from '../chain';
import {
  assertCanonicalAddress,
  tryCanonicalizeAddress,
  type CanonicalAddress,
} from './address';

/**
 * The record layer's view of the engine's record handle.
 *
 * The address-taking members are declared over {@link CanonicalAddress}, so the brand
 * is enforced one call earlier than the engine can enforce it — the engine's own
 * declarations take plain `string`, and no amount of type work on this side changes
 * that, which is exactly why this wrapper is the single choke point rather than a
 * convenience.
 */
export interface RecordManifest {
  /** The path the engine resolved. Asserted against the anchor by the caller. */
  readonly file: string;
  read(): Promise<ManifestData>;
  write(data: ManifestData): Promise<void>;
  /**
   * The only mutual-exclusion primitive shared between two plugin processes on one
   * project.
   *
   * Nested calls throw, and the engine performs its own operations inside its own
   * lock, so this may be taken in the preflight — before the engine's operation
   * begins — and nowhere else.
   */
  lockedRun<T>(cb: () => Promise<T>): Promise<T>;
  proxyRecord(address: CanonicalAddress): Promise<ProxyDeployment | undefined>;
  implRecord(address: CanonicalAddress): Promise<ImplDeployment | undefined>;
  addProxyRecord(record: {
    readonly address: CanonicalAddress;
    readonly kind: ProxyDeployment['kind'];
  }): Promise<void>;
}

/**
 * Opens the record for a chain id, constructing the engine's handle directly rather
 * than through its network-probing factory.
 *
 * `Manifest.forNetwork` would spend three more round trips — one to re-read the chain
 * id this function is given, and two on the Hardhat and Anvil dev-instance probes —
 * to arrive at the same object. Both probes are refused locally by the chain seam by
 * policy, and the engine's own metadata helper catches both failures and answers
 * "not a dev instance", so its non-dev branch is reached and that branch constructs
 * exactly this: `new Manifest(chainId)`. Taking the direct route keeps the record
 * layer's chain reads at the one memoized identity call plus one code read per
 * address an operation names.
 *
 * @throws {ChainResultShapeError} the chain id is not a hex quantity that parses to a
 *   positive integer — the condition that otherwise produces a record file named
 *   `unknown-NaN.json`, which no later run consults. The guard is the chain seam's
 *   own, re-applied here because the value has crossed a persistence boundary.
 */
export async function openRecordManifest(
  chainIdHex: string,
): Promise<RecordManifest> {
  const validated = requireResultShape('eth_chainId', chainIdHex);
  // The same parse the engine performs, because the file name has to match the file
  // the engine actually writes — not because the parse is a good one. The guard above
  // is what makes it safe.
  const chainId = Number.parseInt(validated.slice(2), 16);

  const engine = await import('@openzeppelin/upgrades-core');
  const manifest: Manifest = new engine.Manifest(chainId);
  const { DeploymentNotFound } = engine;

  /**
   * The engine signals "no such record" by throwing. Caught, and **rethrown unless it
   * is that exact class** — a blanket catch here would turn a genuine read failure,
   * or a corrupt file the version migration refused, into "this proxy is not
   * recorded", which is the input to a force-import.
   */
  const absentOrThrow = async <T>(
    lookup: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await lookup();
    } catch (cause) {
      if (cause instanceof DeploymentNotFound) {
        return undefined;
      }
      throw cause;
    }
  };

  return Object.freeze({
    file: manifest.file,
    read: () => manifest.read(),
    write: (data: ManifestData) => manifest.write(data),
    lockedRun: <T>(cb: () => Promise<T>) => manifest.lockedRun(cb),
    proxyRecord: (address: CanonicalAddress) =>
      absentOrThrow(() =>
        // Re-asserted rather than trusted. The parameter carries the brand, so this
        // is unreachable from TypeScript; it is reachable from JavaScript and through
        // a suppressed type error, and the failure it prevents is silent — an
        // un-minted address makes the lookup miss, which stops the engine's kind
        // cross-check from firing on a proxy that is both recorded and live.
        manifest.getProxyFromAddress(assertCanonicalAddress(address)),
      ),
    implRecord: (address: CanonicalAddress) =>
      absentOrThrow(() =>
        manifest.getDeploymentFromAddress(assertCanonicalAddress(address)),
      ),
    addProxyRecord: (record: {
      readonly address: CanonicalAddress;
      readonly kind: ProxyDeployment['kind'];
    }) =>
      manifest.addProxy({
        address: assertCanonicalAddress(record.address),
        kind: record.kind,
      }),
  });
}

/**
 * How many deployment records a manifest holds: `proxies.length` **plus** the number
 * of `impls` keys **plus** one if `admin` is present.
 *
 * Written down and given one call site because the number appears in a refusal a user
 * acts on — the message tells them how many records are in a file it is warning them
 * not to delete. Any definition is arbitrary; an undocumented one quietly means
 * something else a release later. Counting only proxies would tell a user with twelve
 * implementations and no proxies that there are none, and they would delete the file.
 */
export function recordCount(data: ManifestData): number {
  return (
    data.proxies.length +
    Object.keys(data.impls).length +
    (data.admin === undefined ? 0 : 1)
  );
}

export interface StoredAddressMigration {
  readonly data: ManifestData;
  /** How many stored address strings changed. Zero means: do not write. */
  readonly rewritten: number;
  /** How many could not be canonicalized and were left exactly as they are. */
  readonly unmigratable: number;
}

/**
 * Brings every stored address to the canonical form, in place in a copy.
 *
 * Needed because minting at the boundary fixes only what *enters* the record. A
 * manifest written before this plugin — or by the sibling plugin, which lower-cases —
 * holds addresses in another spelling, and the engine compares with exact string
 * equality, so a stored lower-case address never matches a canonicalized query.
 *
 * **Idempotent**: a second pass over an already-canonical manifest reports zero
 * rewrites, and the caller writes nothing and takes no lock. Without that, every
 * replay of every migration would rewrite the file and serialize on a lock neither
 * run needed — and `tronbox test` replays every migration on every run.
 *
 * **Field-preserving**: only `address` and `allAddresses` strings change, by spread,
 * so `layout`, `kind`, `txHash`, `manifestVersion` and anything else survive. Array
 * membership is never touched: no entry is added, removed, reordered or filtered.
 *
 * **An address that cannot be canonicalized is left exactly as it is, and counted.**
 * Refusing the whole run over one unrelated malformed record would make an unrelated
 * upgrade impossible, which is the granularity mistake the per-entry verdict exists
 * to avoid; repairing or removing it would destroy a record this plugin does not
 * understand. So it is left, and reported — a lookup for it will miss, and a miss
 * nothing announced looks like an unregistered proxy.
 */
export function canonicalizeStoredAddresses(
  data: ManifestData,
): StoredAddressMigration {
  let rewritten = 0;
  let unmigratable = 0;

  const migrate = (value: string): string => {
    const canonical = tryCanonicalizeAddress(value);
    if (canonical === undefined) {
      unmigratable += 1;
      return value;
    }
    if (canonical !== value) {
      rewritten += 1;
    }
    return canonical;
  };

  const impls: ManifestData['impls'] = { ...data.impls };
  for (const version of Object.keys(impls)) {
    const impl = impls[version];
    if (impl === undefined) {
      continue;
    }
    const address = migrate(impl.address);
    const allAddresses = impl.allAddresses?.map(entry => migrate(entry));
    impls[version] =
      allAddresses === undefined
        ? { ...impl, address }
        : { ...impl, address, allAddresses };
  }

  const proxies = data.proxies.map(proxy => ({
    ...proxy,
    address: migrate(proxy.address),
  }));

  const migrated: ManifestData = { ...data, impls, proxies };
  if (data.admin !== undefined) {
    migrated.admin = { ...data.admin, address: migrate(data.admin.address) };
  }

  return Object.freeze({ data: migrated, rewritten, unmigratable });
}
