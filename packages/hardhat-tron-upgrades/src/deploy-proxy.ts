import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type DeployProxyOptions,
  FQN,
  checkKind,
  core,
  deployContractWithOptions,
  deployerAddress,
  ethersOf,
  getInitializerData,
  getManifest,
  isOptionalCallRevert,
  providerOf,
  resolveAddress,
  resolveImplementation,
  txOverridesOf,
  upgradeableContractFor,
  validateImplementation,
} from './utils';

export function makeDeployProxy(hre: HardhatRuntimeEnvironment) {
  return async function deployProxy(
    contractName: string,
    args: unknown[] = [],
    opts: DeployProxyOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const draft = await upgradeableContractFor(hre, contractName, opts);
    const kind = opts.kind ?? core().inferProxyKind(draft.validations, draft.version);
    checkKind(kind);
    txOverridesOf(opts);
    if (kind === 'uups' && opts.initialOwner !== undefined) {
      throw new Error(`initialOwner is not supported for kind "uups"`);
    }
    // Resolve the manifest before any chain write: a legacy manifest file is a
    // deterministic error and must fail here, not after deployments.
    const manifest = await getManifest(hre);
    const contract = await validateImplementation(hre, contractName, { ...opts, kind });

    // Deterministic option error — reject before anything reaches the chain.
    // The ported TRC1967Proxy (which the transparent proxy inherits) rejects
    // empty constructor data, so an uninitialized proxy cannot be deployed
    // for either kind — whether initialization was skipped explicitly or the
    // contract has no default initializer. Beacon proxies do support it.
    const { Interface } = require('ethers');
    const iface = new Interface(contract.artifact.abi);
    const initData = getInitializerData(iface, args, opts.initializer);
    if (initData === '0x') {
      throw new Error(
        opts.initializer === false
          ? `initializer: false is not supported for kind "${kind}" — the ported TRC1967Proxy rejects empty initialization data`
          : `Uninitialized deployment is not supported for kind "${kind}": the contract has no ` +
            `default initializer and the ported TRC1967Proxy rejects empty initialization data. ` +
            `Add an initializer function or use a beacon proxy.`,
      );
    }

    const implementation = await resolveImplementation(hre, contractName, opts, contract);
    const implAddress = implementation.address;

    let proxy;
    if (kind === 'transparent') {
      const owner =
        opts.initialOwner === undefined
          ? deployerAddress(hre)
          : await resolveAddress(hre, opts.initialOwner);
      // A ProxyAdmin as initialOwner is almost always a v4-era mistake: the
      // v5 transparent proxy deploys its OWN admin, owned by initialOwner.
      // The owner() probe rejects on TVM for EOAs (no-code call) — that
      // simply means "not a ProxyAdmin".
      let ownerIsProxyAdmin = false;
      if (!opts.unsafeSkipProxyAdminCheck) {
        try {
          ownerIsProxyAdmin = await core().inferProxyAdmin(providerOf(hre), owner);
        } catch (e) {
          if (!isOptionalCallRevert(e)) throw e;
        }
      }
      if (ownerIsProxyAdmin) {
        throw new Error(
          '`initialOwner` must not be a ProxyAdmin contract. If the contract at ' +
            `${owner} is able to call functions on an actual ProxyAdmin, skip this check ` +
            'with the `unsafeSkipProxyAdminCheck` option.',
        );
      }
      proxy = await deployContractWithOptions(
        hre,
        FQN.transparent,
        [implAddress, owner, initData],
        opts,
      );
    } else {
      proxy = await deployContractWithOptions(hre, FQN.trc1967, [implAddress, initData], opts);
    }
    const proxyAddress = await proxy.getAddress();

    await core().addProxyToManifest(kind, proxyAddress, manifest);

    return ethers.getContractAt(contractName, proxyAddress);
  };
}
