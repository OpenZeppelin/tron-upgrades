import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { ADMIN_SLOT, BEACON_SLOT, IMPL_SLOT, getSlot, slotToAddress } from './slots';

// Proxy artifacts come from the ported contracts library, compiled by the
// consumer project (see README). Fully-qualified names are required because
// the bridge's bare-name artifact index only covers local sources.
const PROXY_PKG = 'openzeppelin-tron-solidity/contracts/proxy';
const FQN = {
  transparent: `${PROXY_PKG}/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy`,
  proxyAdmin: `${PROXY_PKG}/transparent/ProxyAdmin.sol:ProxyAdmin`,
  trc1967: `${PROXY_PKG}/TRC1967/TRC1967Proxy.sol:TRC1967Proxy`,
  beacon: `${PROXY_PKG}/beacon/UpgradeableBeacon.sol:UpgradeableBeacon`,
  beaconProxy: `${PROXY_PKG}/beacon/BeaconProxy.sol:BeaconProxy`,
};

export type ProxyKind = 'transparent' | 'uups';
export type ValidationKind = ProxyKind | 'beacon';

export interface ValidationOptions {
  kind?: ValidationKind;
}
export interface DeployProxyOptions {
  kind?: ProxyKind;
  initializer?: string | false;
  initialOwner?: string;
}
export interface UpgradeProxyOptions {
  kind?: ProxyKind;
  from?: string;
  owner?: unknown; // a bridge signer (carries .tronWeb); default = deployer key
  call?: string;
}
export interface DeployBeaconOptions {
  initialOwner?: string;
}
export interface DeployBeaconProxyOptions {
  initializer?: string | false;
}
export interface UpgradeBeaconOptions {
  from?: string;
  owner?: unknown;
}

type AddressLike = string | { getAddress(): Promise<string> };

const KINDS: ProxyKind[] = ['transparent', 'uups'];
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

function checkKind(kind: string): asserts kind is ProxyKind {
  if (!KINDS.includes(kind as ProxyKind)) {
    throw new Error(`kind "${kind}" not supported (expected one of: ${KINDS.join(' | ')})`);
  }
}

function ethersOf(hre: HardhatRuntimeEnvironment): any {
  return (hre as any).ethers;
}

// -- validation (off-chain, over compiler build-info) ---------------

async function upgradeableContractFor(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions = {},
) {
  // lazy-require keeps `hardhat compile`-time loads cheap
  const { UpgradeableContract } = require('@openzeppelin/upgrades-core');
  const artifact = await hre.artifacts.readArtifact(contractName);
  const fqName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) {
    throw new Error(`No build-info for ${fqName}. Run \`hardhat compile\` first.`);
  }
  // `kind` matters: upgrades-core only surfaces the missing
  // upgradeTo/upgradeToAndCall error when validating as 'uups'.
  const validationOpts = { kind: opts.kind ?? 'transparent' };
  return {
    artifact,
    contract: new UpgradeableContract(
      artifact.contractName,
      buildInfo.input,
      buildInfo.output,
      validationOpts,
      (buildInfo as any).solcVersion,
    ),
  };
}

async function validateImplementation(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions = {},
): Promise<void> {
  const { contract } = await upgradeableContractFor(hre, contractName, opts);
  const report = contract.getErrorReport();
  if (!report.ok) {
    throw new Error(`${contractName} is not upgrade-safe:\n${report.explain()}`);
  }
}

async function validateUpgrade(
  hre: HardhatRuntimeEnvironment,
  fromContractName: string,
  toContractName: string,
  opts: ValidationOptions = {},
): Promise<void> {
  const from = await upgradeableContractFor(hre, fromContractName, opts);
  const to = await upgradeableContractFor(hre, toContractName, opts);
  const errors = to.contract.getErrorReport();
  if (!errors.ok) {
    throw new Error(`${toContractName} is not upgrade-safe:\n${errors.explain()}`);
  }
  const layout = from.contract.getStorageUpgradeReport(to.contract);
  if (!layout.ok) {
    throw new Error(
      `Storage layout of ${toContractName} is incompatible with ${fromContractName}:\n${layout.explain()}`,
    );
  }
}

// -- manifest (which proxy runs which contract, per network) --------
//
// Minimal deployment record so `upgradeProxy` can validate against the
// contract currently behind the proxy and route by proxy kind. Not yet
// compatible with the upstream .openzeppelin manifest schema.

interface ProxyRecord {
  kind: ProxyKind | 'beacon';
  contract?: string;
  implementation?: string;
  beacon?: string;
}
interface BeaconRecord {
  contract: string;
  implementation: string;
}
interface Manifest {
  proxies: Record<string, ProxyRecord>;
  beacons: Record<string, BeaconRecord>;
}

function manifestPath(hre: HardhatRuntimeEnvironment): string {
  return path.join(hre.config.paths.root, '.openzeppelin', `${hre.network.name}.json`);
}

function readManifest(hre: HardhatRuntimeEnvironment): Manifest {
  const p = manifestPath(hre);
  const manifest = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  manifest.proxies ??= {};
  manifest.beacons ??= {};
  return manifest;
}

function writeManifest(hre: HardhatRuntimeEnvironment, manifest: Manifest): void {
  const p = manifestPath(hre);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
}

// -- deploy / upgrade (on-chain, via the TronWeb bridge) ------------

// The deployer (network accounts[0]) as an EVM-style checksummed address.
// Deliberately avoids hre.ethers.getSigners(): the bridge's signer setup
// funds accounts via the tre_setAccountBalance cheatcode, which only exists
// on TRE — on public networks it hard-fails. Without an explicit signer,
// state-changing calls are signed by the deployer key anyway.
function deployerAddress(hre: HardhatRuntimeEnvironment): string {
  const { tronWeb, address } = (hre as any).tre.makeTronWeb();
  const hex21 = tronWeb.address.toHex(address);
  return ethersOf(hre).getAddress('0x' + hex21.slice(2));
}

async function resolveAddress(target: AddressLike): Promise<string> {
  return typeof target === 'string' ? target : await target.getAddress();
}

async function deployProxy(
  hre: HardhatRuntimeEnvironment,
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

  const initData =
    initializer === false ? '0x' : impl.interface.encodeFunctionData(initializer, args);

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
}

async function upgradeProxy(
  hre: HardhatRuntimeEnvironment,
  proxy: AddressLike,
  newContractName: string,
  opts: UpgradeProxyOptions = {},
): Promise<any> {
  const ethers = ethersOf(hre);
  const proxyAddress = await resolveAddress(proxy);

  const manifest = readManifest(hre);
  const record = manifest.proxies[proxyAddress.toLowerCase()];
  if (record && opts.kind && record.kind !== opts.kind) {
    throw new Error(
      `Proxy ${proxyAddress} is recorded as "${record.kind}" but opts.kind says "${opts.kind}"`,
    );
  }
  const kind = record?.kind ?? opts.kind ?? 'transparent';
  if (kind === 'beacon') {
    throw new Error(
      `Proxy ${proxyAddress} is a beacon proxy — its implementation lives on the beacon. ` +
        `Call upgradeBeacon(${record?.beacon ?? '<beaconAddress>'}, ...) instead.`,
    );
  }
  checkKind(kind);

  const fromContractName = opts.from ?? record?.contract;
  if (!fromContractName) {
    throw new Error(
      `No deployment record for proxy ${proxyAddress} on network "${hre.network.name}" — pass opts.from with the current implementation's contract name (and opts.kind for non-transparent proxies).`,
    );
  }

  await validateUpgrade(hre, fromContractName, newContractName, { kind });

  // Resolve the upgrade authority BEFORE deploying the new implementation,
  // so a mis-routed proxy (e.g. a UUPS proxy taken down the transparent
  // path) fails without leaving an orphan implementation on the chain.
  // Without opts.owner, calls are signed by the deployer key.
  const withOwner = (contract: any) => (opts.owner ? contract.connect(opts.owner) : contract);
  let admin: any = null;
  if (kind === 'transparent') {
    const adminAddress = slotToAddress(await getSlot(hre, proxyAddress, ADMIN_SLOT));
    if (adminAddress === ZERO_ADDRESS) {
      throw new Error(
        `Proxy ${proxyAddress} has no admin in the 1967 admin slot — not a transparent proxy? For UUPS proxies pass opts.kind: "uups".`,
      );
    }
    admin = await ethers.getContractAt(FQN.proxyAdmin, ethers.getAddress(adminAddress));
  }

  const newImpl = await ethers.deployContract(newContractName);
  const newImplAddress = await newImpl.getAddress();

  if (kind === 'uups') {
    // The upgrade function lives in the CURRENT implementation and is
    // reached through the proxy (delegatecall), so it mutates the proxy's
    // own 1967 slot.
    const proxyAsImpl = await ethers.getContractAt(fromContractName, proxyAddress);
    await withOwner(proxyAsImpl).upgradeToAndCall(newImplAddress, opts.call ?? '0x');
  } else {
    await withOwner(admin).upgradeAndCall(proxyAddress, newImplAddress, opts.call ?? '0x');
  }

  // trust, but verify: the implementation slot must now hold the new address
  const current = slotToAddress(await getSlot(hre, proxyAddress, IMPL_SLOT)).toLowerCase();
  if (current !== newImplAddress.toLowerCase()) {
    throw new Error(
      `Upgrade transaction succeeded but the implementation slot holds ${current}, expected ${newImplAddress}`,
    );
  }

  manifest.proxies[proxyAddress.toLowerCase()] = {
    kind,
    contract: newContractName,
    implementation: newImplAddress,
  };
  writeManifest(hre, manifest);

  return ethers.getContractAt(newContractName, proxyAddress);
}

// -- beacons ---------------------------------------------------------

async function deployBeacon(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: DeployBeaconOptions = {},
): Promise<any> {
  const ethers = ethersOf(hre);
  await validateImplementation(hre, contractName, { kind: 'beacon' });

  const impl = await ethers.deployContract(contractName);
  const implAddress = await impl.getAddress();

  const owner = opts.initialOwner ?? deployerAddress(hre);
  const beacon = await ethers.deployContract(FQN.beacon, [implAddress, owner]);
  const beaconAddress = await beacon.getAddress();

  const manifest = readManifest(hre);
  manifest.beacons[beaconAddress.toLowerCase()] = {
    contract: contractName,
    implementation: implAddress,
  };
  writeManifest(hre, manifest);

  return beacon;
}

async function deployBeaconProxy(
  hre: HardhatRuntimeEnvironment,
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
  const initData = initializer === false ? '0x' : iface.encodeFunctionData(initializer, args);

  const proxy = await ethers.deployContract(FQN.beaconProxy, [beaconAddress, initData]);
  const proxyAddress = await proxy.getAddress();

  const manifest = readManifest(hre);
  manifest.proxies[proxyAddress.toLowerCase()] = {
    kind: 'beacon',
    beacon: beaconAddress,
  };
  writeManifest(hre, manifest);

  return ethers.getContractAt(contractName, proxyAddress);
}

async function upgradeBeacon(
  hre: HardhatRuntimeEnvironment,
  beacon: AddressLike,
  newContractName: string,
  opts: UpgradeBeaconOptions = {},
): Promise<any> {
  const ethers = ethersOf(hre);
  const beaconAddress = await resolveAddress(beacon);

  const manifest = readManifest(hre);
  const record = manifest.beacons[beaconAddress.toLowerCase()];
  const fromContractName = opts.from ?? record?.contract;
  if (!fromContractName) {
    throw new Error(
      `No deployment record for beacon ${beaconAddress} on network "${hre.network.name}" — pass opts.from with the current implementation's contract name.`,
    );
  }

  await validateUpgrade(hre, fromContractName, newContractName, { kind: 'beacon' });

  const beaconContract = await ethers.getContractAt(FQN.beacon, beaconAddress);
  const newImpl = await ethers.deployContract(newContractName);
  const newImplAddress = await newImpl.getAddress();

  const withOwner = (c: any) => (opts.owner ? c.connect(opts.owner) : c);
  await withOwner(beaconContract).upgradeTo(newImplAddress);

  // trust, but verify: the beacon must now point at the new implementation
  const current = (await beaconContract.implementation()).toLowerCase();
  if (current !== newImplAddress.toLowerCase()) {
    throw new Error(
      `Beacon upgrade transaction succeeded but the beacon points at ${current}, expected ${newImplAddress}`,
    );
  }

  manifest.beacons[beaconAddress.toLowerCase()] = {
    contract: newContractName,
    implementation: newImplAddress,
  };
  writeManifest(hre, manifest);

  return beaconContract;
}

// -- public API ------------------------------------------------------

export interface UpgradesAPI {
  deployProxy(name: string, args?: unknown[], opts?: DeployProxyOptions): Promise<any>;
  upgradeProxy(proxy: AddressLike, name: string, opts?: UpgradeProxyOptions): Promise<any>;
  deployBeacon(name: string, opts?: DeployBeaconOptions): Promise<any>;
  deployBeaconProxy(
    beacon: AddressLike,
    name: string,
    args?: unknown[],
    opts?: DeployBeaconProxyOptions,
  ): Promise<any>;
  upgradeBeacon(beacon: AddressLike, name: string, opts?: UpgradeBeaconOptions): Promise<any>;
  validateImplementation(name: string, opts?: ValidationOptions): Promise<void>;
  validateUpgrade(from: string, to: string, opts?: ValidationOptions): Promise<void>;
  erc1967: {
    getImplementationAddress(proxy: AddressLike): Promise<string>;
    getAdminAddress(proxy: AddressLike): Promise<string>;
    getBeaconAddress(proxy: AddressLike): Promise<string>;
  };
  beacon: {
    getImplementationAddress(beacon: AddressLike): Promise<string>;
  };
  trc1967: { IMPL_SLOT: string; ADMIN_SLOT: string; BEACON_SLOT: string };
}

export function makeUpgrades(hre: HardhatRuntimeEnvironment): UpgradesAPI {
  const slotAddress = async (target: AddressLike, slot: string) =>
    ethersOf(hre).getAddress(slotToAddress(await getSlot(hre, await resolveAddress(target), slot)));
  return {
    deployProxy: (name, args, opts) => deployProxy(hre, name, args, opts),
    upgradeProxy: (proxy, name, opts) => upgradeProxy(hre, proxy, name, opts),
    deployBeacon: (name, opts) => deployBeacon(hre, name, opts),
    deployBeaconProxy: (beacon, name, args, opts) =>
      deployBeaconProxy(hre, beacon, name, args, opts),
    upgradeBeacon: (beacon, name, opts) => upgradeBeacon(hre, beacon, name, opts),
    validateImplementation: (name, opts) => validateImplementation(hre, name, opts),
    validateUpgrade: (from, to, opts) => validateUpgrade(hre, from, to, opts),
    erc1967: {
      getImplementationAddress: (proxy) => slotAddress(proxy, IMPL_SLOT),
      getAdminAddress: (proxy) => slotAddress(proxy, ADMIN_SLOT),
      getBeaconAddress: (proxy) => slotAddress(proxy, BEACON_SLOT),
    },
    beacon: {
      getImplementationAddress: async (beacon) => {
        const b = await ethersOf(hre).getContractAt(FQN.beacon, await resolveAddress(beacon));
        return b.implementation();
      },
    },
    trc1967: { IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT },
  };
}
