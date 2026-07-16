import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { ethersOf } from './ethers';
import { type TxOverrides, txOverridesOf } from './options';

export function txHashOf(contract: any): string | undefined {
  try {
    return contract.deploymentTransaction?.()?.hash ?? undefined;
  } catch {
    return undefined;
  }
}

export async function deployContractWithOptions(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  args: unknown[],
  opts: { txOverrides?: TxOverrides },
): Promise<any> {
  const overrides = txOverridesOf(opts);
  return overrides
    ? ethersOf(hre).deployContract(contractName, args, overrides)
    : ethersOf(hre).deployContract(contractName, args);
}
