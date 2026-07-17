import type { HardhatRuntimeEnvironment } from 'hardhat/types';

export type AddressLike = string | { getAddress(): Promise<string> };

export const ZERO_ADDRESS = '0x' + '0'.repeat(40);

export function ethersOf(hre: HardhatRuntimeEnvironment): any {
  return (hre as any).ethers;
}

export function providerOf(hre: HardhatRuntimeEnvironment): any {
  return (hre as any).network.provider;
}

// The deployer (network accounts[0]) as an EVM-style checksummed address.
// Deliberately avoids hre.ethers.getSigners(): the bridge's signer setup
// funds accounts via the tre_setAccountBalance cheatcode, which only exists
// on TRE — on public networks it hard-fails. Without an explicit signer,
// state-changing calls are signed by the deployer key anyway.
export function deployerAddress(hre: HardhatRuntimeEnvironment): string {
  const { tronWeb, address } = (hre as any).tre.makeTronWeb();
  const hex21 = tronWeb.address.toHex(address);
  return ethersOf(hre).getAddress('0x' + hex21.slice(2));
}

// Canonicalize every address entering the plugin to its EIP-55 checksummed
// form. A TVM account has three interchangeable encodings — Base58Check
// (`T...`), TRON-hex (`41` + 20 bytes), and EVM-hex (`0x` + 20 bytes) — and any
// of them may reach a public entry point. ethers' getAddress only accepts the
// EVM-hex form, so the TRON encodings are first rehydrated to `0x`-hex through
// TronWeb (the same seam deployerAddress uses). Checksumming at the boundary
// also keeps the stored and looked-up forms identical: upgrades-core's manifest
// lookups compare address strings with `===`, so an address in a different
// casing than the manifest recorded would otherwise miss those lookups,
// dropping the recorded proxy kind and implementation layout.
export async function resolveAddress(
  hre: HardhatRuntimeEnvironment,
  target: AddressLike,
): Promise<string> {
  const { getAddress } = require('ethers');
  const raw = typeof target === 'string' ? target : await target.getAddress();
  if (raw.startsWith('0x') || raw.startsWith('0X')) {
    return getAddress('0x' + raw.slice(2));
  }
  if (/^[0-9a-fA-F]{42}$/.test(raw) && !/^41[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`Invalid TRON address ${raw}: native hex addresses must start with 41`);
  }
  const { tronWeb } = (hre as any).tre.makeTronWeb();
  const hex = tronWeb.address.toHex(raw);
  if (typeof hex !== 'string' || !/^41[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`Invalid TRON address: ${raw}`);
  }
  return getAddress('0x' + hex.slice(2));
}

// True when `target` denotes a DEPLOYED reference — a contract instance or an
// address in any of the three TVM encodings — rather than a contract-artifact
// name. This is the seam that lets one entry point accept either an address or
// a contract name in the same argument position. Address-bearing objects and
// the two hex forms are recognized without TronWeb; a Base58Check string is
// confirmed through TronWeb, the same seam resolveAddress rehydrates it with.
// A contract name matches none of these and routes to the name-based path.
export function looksLikeAddress(hre: HardhatRuntimeEnvironment, target: AddressLike): boolean {
  if (typeof target !== 'string') return true;
  if (/^0[xX][0-9a-fA-F]{40}$/.test(target)) return true;
  if (/^41[0-9a-fA-F]{40}$/.test(target)) return true;
  try {
    const { tronWeb } = (hre as any).tre.makeTronWeb();
    return tronWeb.isAddress(target) === true;
  } catch {
    return false;
  }
}
