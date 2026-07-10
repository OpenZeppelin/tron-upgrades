import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import { txHashOf } from './deploy';
import { ethersOf, providerOf } from './ethers';
import { getManifest } from './manifest';
import type { ImplementationOptions } from './options';
import { validateImplementation } from './validate-impl';

export async function resolveImplementation(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ImplementationOptions,
  validated?: any,
): Promise<{ address: string; contract: any; txResponse?: any }> {
  await getManifest(hre); // legacy-format preflight before any deployment
  const contract = validated ?? (await validateImplementation(hre, contractName, opts));
  const mode = opts.redeployImplementation ?? 'onchange';
  const deploy = async () => {
    if (mode === 'never') {
      throw new Error(
        `The implementation contract ${contractName} was not previously deployed on this network`,
      );
    }
    const impl = await ethersOf(hre).deployContract(contractName, opts.constructorArgs ?? []);
    return {
      address: await impl.getAddress(),
      txHash: txHashOf(impl),
      layout: contract.layout,
      txResponse: impl.deploymentTransaction?.() ?? undefined,
    };
  };
  const deployOpts = { timeout: opts.timeout, pollingInterval: opts.pollingInterval };
  const fetch = () =>
    core().fetchOrDeployGetDeployment(
      contract.version,
      providerOf(hre),
      deploy,
      deployOpts,
      mode === 'always',
    );

  let deployment;
  try {
    deployment = await fetch();
  } catch (error) {
    // upgrades-core removes an invalid cached deployment but deliberately
    // throws on non-EVM dev networks. Retry once after that removal so
    // onchange/always retain their documented stale-record behavior on TRE.
    if (!(error as any)?.removed || mode === 'never') throw error;
    deployment = await fetch();
  }
  return { address: deployment.address, contract, txResponse: deployment.txResponse };
}
