import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  type DeployBeaconProxyOptions,
  FQN,
  assertIsBeacon,
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

    // Reject a non-beacon kind and confirm the target is a beacon before any
    // chain write — a bad kind or a non-beacon address must fail here, not
    // after a proxy is deployed.
    if (opts.kind !== undefined && opts.kind !== 'beacon') {
      throw new Error(
        `deployBeaconProxy deploys beacon proxies only, but kind '${opts.kind}' was requested. ` +
          `Use deployProxy for transparent or uups proxies.`,
      );
    }
    const beaconAddress = await resolveAddress(hre, beacon);
    await assertIsBeacon(hre, beaconAddress);
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
