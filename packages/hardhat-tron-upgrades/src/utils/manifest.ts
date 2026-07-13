import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { ProxyKind } from './options';

// -- manifest (which proxy runs which contract, per network) --------
//
// Minimal deployment record so `upgradeProxy` can validate against the
// contract currently behind the proxy and route by proxy kind. Not yet
// compatible with the upstream .openzeppelin manifest schema.

export interface ProxyRecord {
  kind: ProxyKind | 'beacon';
  contract?: string;
  implementation?: string;
  beacon?: string;
}
export interface BeaconRecord {
  contract: string;
  implementation: string;
}
export interface Manifest {
  proxies: Record<string, ProxyRecord>;
  beacons: Record<string, BeaconRecord>;
}

function manifestPath(hre: HardhatRuntimeEnvironment): string {
  return path.join(hre.config.paths.root, '.openzeppelin', `${hre.network.name}.json`);
}

export function readManifest(hre: HardhatRuntimeEnvironment): Manifest {
  const p = manifestPath(hre);
  const manifest = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  manifest.proxies ??= {};
  manifest.beacons ??= {};
  return manifest;
}

export function writeManifest(hre: HardhatRuntimeEnvironment, manifest: Manifest): void {
  const p = manifestPath(hre);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
}
