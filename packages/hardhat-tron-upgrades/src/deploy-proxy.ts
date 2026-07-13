import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type DeployProxyOptions,
  FQN,
  checkKind,
  deployerAddress,
  ethersOf,
  getInitializerData,
  readManifest,
  validateImplementation,
  writeManifest,
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
    await validateImplementation(hre, contractName, { kind });

    const impl = await ethers.deployContract(contractName);
    const implAddress = await impl.getAddress();

    const initData = getInitializerData(impl.interface, initializer, args);

    let proxy;
    if (kind === 'transparent') {
      const owner = opts.initialOwner ?? deployerAddress(hre);
      proxy = await ethers.deployContract(FQN.transparent, [implAddress, owner, initData]);
    } else {
      proxy = await ethers.deployContract(FQN.trc1967, [implAddress, initData]);
    }
    const proxyAddress = await proxy.getAddress();

    const manifest = readManifest(hre);
    manifest.proxies[proxyAddress.toLowerCase()] = {
      kind,
      contract: contractName,
      implementation: implAddress,
    };
    writeManifest(hre, manifest);

    return ethers.getContractAt(contractName, proxyAddress);
  };
}
