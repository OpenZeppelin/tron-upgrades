/**
 * The public 1967-slot readers: `erc1967` and `beacon`, mirroring the
 * Hardhat plugin's own namespaces by name and by shape.
 *
 * These are readers only — no validation runs, no record opens, nothing is
 * queued and nothing is spent. Each takes an address and the same
 * migration-scope handles every operation takes (just `tronWrap`/`tronWeb`
 * is enough; the other four are accepted for symmetry with every other
 * public function's options object, but unused here), and returns a base58
 * TRON address — never the chain layer's own lowercase-hex form, which is
 * this surface's one deliberate divergence from Hardhat's checksummed-hex
 * return.
 *
 * Engine-free by construction: this module reaches only `./environment`
 * (`resolveEnvironment`), `./chain` (`createChainAccess`, the two 1967
 * reader errors), `./record` (`canonicalizeAddress`, `toBase58`) and
 * `./adopt/errors` (`NothingToAdoptError`, which itself imports only
 * `../proxy/errors` — a file with no imports at all) — none of which
 * value-import `@openzeppelin/upgrades-core` — so re-exporting it from the
 * package entry adds no engine-reaching module to the entry's static
 * value-closure.
 */

import { resolveEnvironment, type RawMigrationHandles } from './environment';
import { createChainAccess, type ChainAccess } from './chain';
import { canonicalizeAddress, toBase58 } from './record';
import { NothingToAdoptError } from './adopt/errors';

/** The migration-scope handles these readers need; nothing else is accepted. */
export type Erc1967ReadOptions = RawMigrationHandles;

/**
 * Builds a `ChainAccess` from the caller's handles, the way
 * `proxy/toolkit.ts:createOperationToolkit` does for every operation — minus
 * the slots no reader here needs (paths, network, artifacts, receipts,
 * scheduling, output). Shared by every function below so the recipe is
 * written once.
 */
async function chainAccessFrom(options: Erc1967ReadOptions): Promise<ChainAccess> {
  const env = resolveEnvironment(options, { require: ['chain'] });
  return createChainAccess(env.chain);
}

function toPublicAddress(hex: string): string {
  return toBase58(canonicalizeAddress(hex));
}

/**
 * Mirrors Hardhat's `erc1967` namespace: the three standard ERC-1967 proxy
 * slots, read directly from chain — never guessed from a contract name or a
 * deployment record.
 */
export const erc1967 = Object.freeze({
  /** @throws {ChainImplementationNotFoundError} both the modern and the legacy implementation slots are empty. */
  async getImplementationAddress(
    proxyAddress: string,
    options: Erc1967ReadOptions = {},
  ): Promise<string> {
    const chain = await chainAccessFrom(options);
    return toPublicAddress(await chain.read.readImplementationAddress(proxyAddress));
  },

  /** Never throws for an empty slot — returns the zero address, mirroring the engine's own asymmetry. */
  async getAdminAddress(
    proxyAddress: string,
    options: Erc1967ReadOptions = {},
  ): Promise<string> {
    const chain = await chainAccessFrom(options);
    return toPublicAddress(await chain.read.readAdminAddress(proxyAddress));
  },

  /** @throws {ChainBeaconNotFoundError} the beacon slot is empty (no legacy fallback exists for it). */
  async getBeaconAddress(
    proxyAddress: string,
    options: Erc1967ReadOptions = {},
  ): Promise<string> {
    const chain = await chainAccessFrom(options);
    return toPublicAddress(await chain.read.readBeaconAddress(proxyAddress));
  },
});

/**
 * Mirrors Hardhat's `beacon` namespace: the beacon's own `implementation()`,
 * as opposed to a proxy's ERC-1967 slot.
 */
export const beacon = Object.freeze({
  /** @throws {NothingToAdoptError} the address has no code, or does not answer `implementation()`. */
  async getImplementationAddress(
    beaconAddress: string,
    options: Erc1967ReadOptions = {},
  ): Promise<string> {
    const chain = await chainAccessFrom(options);
    const read = await chain.read.readBeaconImplementation(beaconAddress);
    if (read.kind !== 'implementation') {
      // Same class and same found-clause as `beacon/index.ts:requireBeacon`
      // for the same fact — but the reader arm, which drops the forceImport
      // remedy: adopting is an operation's prescription, not a read's.
      throw new NothingToAdoptError(
        beaconAddress,
        'an address that does not answer implementation() — not a beacon',
        'reader',
      );
    }
    return toPublicAddress(read.address);
  },
});
