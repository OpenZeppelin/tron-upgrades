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
// form. Hex addresses are case-insensitive, but upgrades-core's manifest
// lookups compare address strings with `===`: a proxy or implementation passed
// in a different casing than the manifest recorded would miss those lookups,
// dropping the recorded proxy kind and implementation layout. Checksumming at
// the boundary keeps the stored and looked-up forms identical.
export async function resolveAddress(target: AddressLike): Promise<string> {
  const { getAddress } = require('ethers');
  return getAddress(typeof target === 'string' ? target : await target.getAddress());
}
