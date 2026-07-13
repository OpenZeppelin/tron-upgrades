import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import { deployContractWithOptions, txHashOf } from './deploy';
import { providerOf } from './ethers';
import { getManifest } from './manifest';
import { type ImplementationOptions, txOverridesOf } from './options';
import { validateImplementation } from './validate-impl';

export async function resolveImplementation(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ImplementationOptions & { getTxResponse?: boolean },
  validated?: any,
): Promise<{ address: string; contract: any; txResponse?: any }> {
  txOverridesOf(opts);
  if (opts.useDeployedImplementation && opts.redeployImplementation !== undefined) {
    throw new Error(
      'The useDeployedImplementation and redeployImplementation options cannot both be set at the same time',
    );
  }
  await getManifest(hre); // legacy-format preflight before any deployment
  const contract = validated ?? (await validateImplementation(hre, contractName, opts));
  const mode = opts.redeployImplementation ?? (opts.useDeployedImplementation ? 'never' : 'onchange');
  const deploy = async () => {
    if (mode === 'never') {
      throw new Error(
        opts.useDeployedImplementation
          ? `The useDeployedImplementation option was set to true but the implementation contract ${contractName} was not previously deployed on this network`
          : `The implementation contract ${contractName} was not previously deployed on this network`,
      );
    }
    const impl = await deployContractWithOptions(
      hre,
      contractName,
      opts.constructorArgs ?? [],
      opts,
    );
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
  let txResponse = deployment.txResponse;
  if (!txResponse && opts.getTxResponse && deployment.txHash) {
    const provider = providerOf(hre);
    const tx = await provider.send('eth_getTransactionByHash', [deployment.txHash]);
    if (tx) {
      txResponse = {
        ...tx,
        hash: tx.hash ?? deployment.txHash,
        wait: () => provider.send('eth_getTransactionReceipt', [deployment.txHash]),
      };
    }
  }
  return { address: deployment.address, contract, txResponse };
}
