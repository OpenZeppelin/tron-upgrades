import fs from 'node:fs';
import hre from 'hardhat';

import { manifestForHre } from '../src/utils/manifest';

// Helpers for the upstream-schema manifest: impls keyed by version hash
// (with storage layouts), proxies as an array with kinds. The FILE is
// resolved through the plugin's own Manifest.forNetwork path — on a TRE
// that reports an instance id the manifest is keyed chain+instance and
// lives in the OS temp dir, so a hardcoded
// `.openzeppelin/unknown-<chainId>.json` reads a file the plugin never
// writes (the bridge gained the instance-id seam; 29 tests broke on the
// stale assumption).


export async function manifestFile() {
  const manifest = await manifestForHre(hre);
  return manifest.file as string;
}

export async function readManifest() {
  return JSON.parse(fs.readFileSync(await manifestFile(), 'utf8'));
}

export async function writeManifest(manifest: any) {
  fs.writeFileSync(await manifestFile(), JSON.stringify(manifest, null, 2) + '\n');
}

export function proxyRecord(manifest: any, address: string): any {
  return manifest.proxies.find((p: any) => p.address.toLowerCase() === address.toLowerCase());
}

// Finds the impls entry covering an address — primary or allAddresses.
export function implEntry(manifest: any, address: string): any {
  const target = address.toLowerCase();
  return Object.values<any>(manifest.impls).find(
    (i) =>
      i.address.toLowerCase() === target ||
      (i.allAddresses ?? []).some((a: string) => a.toLowerCase() === target),
  );
}

