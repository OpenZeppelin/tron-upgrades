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
  recordImpl,
  txHashOf,
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
    const contract = await validateImplementation(hre, contractName, { kind });

    const impl = await ethers.deployContract(contractName);
    const implAddress = await impl.getAddress();
    // Register BEFORE the proxy exists: if anything below fails, the manifest
    // must already know the implementation the chain will end up pointing at —
    // otherwise the plugin manufactures its own drift (upstream ordering).
    await recordImpl(manifest, contract, implAddress, txHashOf(impl));

    const initData = getInitializerData(impl.interface, initializer, args);

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
