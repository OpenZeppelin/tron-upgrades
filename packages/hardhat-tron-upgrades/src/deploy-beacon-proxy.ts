import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  type DeployBeaconProxyOptions,
  FQN,
  core,
  deployContractWithOptions,
  ethersOf,
  getInitializerData,
  getManifest,
  resolveAddress,
  txOverridesOf,
} from './utils';

export function makeDeployBeaconProxy(hre: HardhatRuntimeEnvironment) {
  return async function deployBeaconProxy(
    beacon: AddressLike,
    contractName: string,
    args: unknown[] = [],
    opts: DeployBeaconProxyOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    txOverridesOf(opts);
    const beaconAddress = await resolveAddress(beacon);
    const manifest = await getManifest(hre);

    // Preflight the implementation ABI before ANY chain interaction — a bad
    // contract name must fail here, not after a proxy is deployed and recorded.
    const { Interface } = require('ethers');
    const artifact = await hre.artifacts.readArtifact(contractName);
    const iface = new Interface(artifact.abi);

    // Unlike the ported TRC1967Proxy, BeaconProxy accepts empty constructor
    // data — initializer: false (or a contract without an initializer)
    // deploys an uninitialized proxy (upstream parity).
    const initData = getInitializerData(iface, args, opts.initializer);

    const proxy = await deployContractWithOptions(
      hre,
      FQN.beaconProxy,
      [beaconAddress, initData],
      opts,
    );
    const proxyAddress = await proxy.getAddress();

    await core().addProxyToManifest('beacon', proxyAddress, manifest);

    return ethers.getContractAt(contractName, proxyAddress);
  };
}
