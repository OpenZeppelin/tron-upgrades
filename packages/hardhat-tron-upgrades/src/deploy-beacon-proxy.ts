import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  type DeployBeaconProxyOptions,
  FQN,
  ethersOf,
  getInitializerData,
  readManifest,
  resolveAddress,
  writeManifest,
} from './utils';

export function makeDeployBeaconProxy(hre: HardhatRuntimeEnvironment) {
  return async function deployBeaconProxy(
    beacon: AddressLike,
    contractName: string,
    args: unknown[] = [],
    opts: DeployBeaconProxyOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const beaconAddress = await resolveAddress(beacon);

    // Preflight the implementation ABI before ANY chain interaction — a bad
    // contract name must fail here, not after a proxy is deployed and recorded.
    const { Interface } = require('ethers');
    const artifact = await hre.artifacts.readArtifact(contractName);
    const iface = new Interface(artifact.abi);

    // Unlike the ported TRC1967Proxy, BeaconProxy accepts empty constructor
    // data — initializer: false deploys an uninitialized proxy (upstream parity).
    const initializer = opts.initializer ?? 'initialize';
    const initData = getInitializerData(iface, initializer, args);

    const proxy = await ethers.deployContract(FQN.beaconProxy, [beaconAddress, initData]);
    const proxyAddress = await proxy.getAddress();

    const manifest = readManifest(hre);
    manifest.proxies[proxyAddress.toLowerCase()] = {
      kind: 'beacon',
      beacon: beaconAddress,
    };
    writeManifest(hre, manifest);

    return ethers.getContractAt(contractName, proxyAddress);
  };
}
