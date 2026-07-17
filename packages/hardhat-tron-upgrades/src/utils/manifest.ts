import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import { providerOf } from './ethers';

// -- manifest (upstream schema, keyed by chain id) -------------------
//
// Uses @openzeppelin/upgrades-core's Manifest: implementations live in
// `impls` keyed by version.linkedWithoutMetadata and carry their storage
// layout; proxies live in `proxies[]` with their kind. The stored layouts
// are what upgrades validate against, so the manifest is a safety artifact:
// the current implementation is always read from the CHAIN and looked up
// here by address.

// The pre-manifest-v2 format lived at .openzeppelin/<network-name>.json and
// recorded contract NAMES, which is exactly the drift-prone baseline this
// schema replaces — refuse to run beside one rather than silently ignore it.
function checkNoLegacyManifest(hre: HardhatRuntimeEnvironment): void {
  const p = path.join(hre.config.paths.root, '.openzeppelin', `${hre.network.name}.json`);
  if (fs.existsSync(p)) {
    throw new Error(
      `Found a legacy deployment record at ${p}. This version stores storage layouts per ` +
        `implementation address (upstream manifest schema) and does not migrate name-based ` +
        `records. Move the file away, then re-register live proxies with ` +
        `upgrades.forceImport(proxyAddress, contractName).`,
    );
  }
}

export async function getManifest(hre: HardhatRuntimeEnvironment): Promise<any> {
  checkNoLegacyManifest(hre);
  const { Manifest } = core();
  const manifest = await Manifest.forNetwork(providerOf(hre));
  await canonicalizeStoredAddresses(manifest);
  return manifest;
}

// Migrate a manifest written before addresses were canonicalized. Records from
// such a deployment can hold lowercase addresses, and upgrades-core compares
// addresses with strict equality (Manifest.getProxyFromAddress /
// getDeploymentFromAddress), reading the file itself rather than through this
// plugin. A checksummed address arriving at a public entry point then misses a
// lowercase record — dropping the recorded proxy kind (routing a transparent
// proxy around its ProxyAdmin) and the recorded implementation layout. Rewrite
// stored addresses to their EIP-55 form on load so every lookup, ours and
// upstream's, matches. Only 0x-hex entries are touched, and only when a change
// is needed, so an already-canonical manifest is read but never rewritten.
async function canonicalizeStoredAddresses(manifest: any): Promise<void> {
  const { getAddress } = require('ethers');
  const canon = (a: any): any =>
    typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? getAddress(a) : a;

  const rewrite = (data: any): boolean => {
    let changed = false;
    const fixAddress = (entry: any): void => {
      if (entry && typeof entry.address === 'string') {
        const canonical = canon(entry.address);
        if (canonical !== entry.address) {
          entry.address = canonical;
          changed = true;
        }
      }
    };
    for (const proxy of data.proxies ?? []) fixAddress(proxy);
    for (const key of Object.keys(data.impls ?? {})) {
      const impl = data.impls[key];
      if (!impl) continue;
      fixAddress(impl);
      if (Array.isArray(impl.allAddresses)) {
        for (let i = 0; i < impl.allAddresses.length; i++) {
          const canonical = canon(impl.allAddresses[i]);
          if (canonical !== impl.allAddresses[i]) {
            impl.allAddresses[i] = canonical;
            changed = true;
          }
        }
      }
    }
    fixAddress(data.admin);
    return changed;
  };

  // Detect without holding the write lock; only rewrite (under lock, on a fresh
  // read) when the on-disk manifest actually needs canonicalizing.
  if (!rewrite(await manifest.read())) return;
  await manifest.lockedRun(async () => {
    const data = await manifest.read();
    if (rewrite(data)) await manifest.write(data);
  });
}

// Record an implementation deployment under its version key. Merge, never
// assign: a same-version redeploy keeps the existing primary address and
// unions into allAddresses — otherwise proxies still pointing at the earlier
// address would wrongly demand forceImport (upstream merge semantics).
export async function recordImpl(
  manifest: any,
  contract: any,
  address: string,
  txHash: string | undefined,
): Promise<void> {
  await manifest.lockedRun(async () => {
    const data = await manifest.read();
    const key = contract.version.linkedWithoutMetadata;
    const existing = data.impls[key];
    if (existing) {
      const merged = new Set([existing.address, address, ...(existing.allAddresses ?? [])]);
      data.impls[key] = { ...existing, allAddresses: [...merged] };
    } else {
      data.impls[key] = { address, txHash, layout: contract.layout };
    }
    await manifest.write(data);
  });
}

export async function proxyRecordOf(manifest: any, proxyAddress: string): Promise<any> {
  const data = await manifest.read();
  const target = proxyAddress.toLowerCase();
  return data.proxies.find((p: any) => p.address?.toLowerCase() === target);
}
