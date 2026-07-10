import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type DeployProxyOptions,
  FQN,
  checkKind,
  core,
  deployerAddress,
  ethersOf,
  getInitializerData,
  getManifest,
  resolveImplementation,
  validateImplementation,
} from './utils';

export function makeDeployProxy(hre: HardhatRuntimeEnvironment) {
  return async function deployProxy(
    contractName: string,
    args: unknown[] = [],
    opts: DeployProxyOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const kind = opts.kind ?? 'transparent';
    checkKind(kind);
    const initializer = opts.initializer ?? 'initialize';
    if (kind === 'uups' && initializer === false) {
      // Deterministic option error — reject before anything reaches the
      // chain. (The ported TRC1967Proxy rejects empty constructor data, so
      // an uninitialized UUPS proxy cannot be deployed through this path.)
      throw new Error(`initializer: false is not supported for kind "uups"`);
    }
    // Resolve the manifest before any chain write: a legacy manifest file is a
    // deterministic error and must fail here, not after deployments.
    const manifest = await getManifest(hre);
    const contract = await validateImplementation(hre, contractName, { ...opts, kind });
    const implementation = await resolveImplementation(hre, contractName, opts, contract);
    const implAddress = implementation.address;

    const { Interface } = require('ethers');
    const iface = new Interface(contract.artifact.abi);
    const initData = getInitializerData(iface, initializer, args);

    let proxy;
    if (kind === 'transparent') {
      const owner = opts.initialOwner ?? deployerAddress(hre);
      proxy = await ethers.deployContract(FQN.transparent, [implAddress, owner, initData]);
    } else {
      proxy = await ethers.deployContract(FQN.trc1967, [implAddress, initData]);
    }
    const proxyAddress = await proxy.getAddress();

    await core().addProxyToManifest(kind, proxyAddress, manifest);

    return ethers.getContractAt(contractName, proxyAddress);
  };
}
