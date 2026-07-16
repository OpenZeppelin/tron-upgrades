import fs from 'node:fs';
import hre from 'hardhat';
import path from 'node:path';

const { network, config } = hre;

// Helpers for the upstream-schema manifest (.openzeppelin/unknown-<chainId>.json):
// impls keyed by version hash (with storage layouts), proxies as an array
// with kinds. Chain id comes from the node, so the filename is discovered,
// not assumed.


export async function manifestFile() {
  const chainIdHex = await network.provider.send('eth_chainId', []);
  return path.join(config.paths.root, '.openzeppelin', `unknown-${parseInt(chainIdHex, 16)}.json`);
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

