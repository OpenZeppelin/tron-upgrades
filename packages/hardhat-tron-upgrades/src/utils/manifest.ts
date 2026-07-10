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
  return Manifest.forNetwork(providerOf(hre));
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
