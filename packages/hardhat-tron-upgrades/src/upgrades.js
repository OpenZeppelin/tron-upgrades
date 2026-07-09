'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ADMIN_SLOT, BEACON_SLOT, IMPL_SLOT, getSlot, slotToAddress } = require('./slots');

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

const KINDS = ['transparent', 'uups'];
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

function checkKind(kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(`kind "${kind}" not supported (expected one of: ${KINDS.join(' | ')})`);
  }
}

// -- validation (off-chain, over compiler build-info) ---------------

async function upgradeableContractFor(hre, contractName, opts = {}) {
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
      buildInfo.solcVersion,
    ),
  };
}

async function validateImplementation(hre, contractName, opts = {}) {
  const { contract } = await upgradeableContractFor(hre, contractName, opts);
  const report = contract.getErrorReport();
  if (!report.ok) {
    throw new Error(`${contractName} is not upgrade-safe:\n${report.explain()}`);
  }
}

async function validateUpgrade(hre, fromContractName, toContractName, opts = {}) {
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

function manifestPath(hre) {
  return path.join(hre.config.paths.root, '.openzeppelin', `${hre.network.name}.json`);
}

function readManifest(hre) {
  const p = manifestPath(hre);
  const manifest = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  manifest.proxies ??= {};
  manifest.beacons ??= {};
  return manifest;
}

function writeManifest(hre, manifest) {
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
function deployerAddress(hre) {
  const { tronWeb, address } = hre.tre.makeTronWeb();
  const hex21 = tronWeb.address.toHex(address);
  return hre.ethers.getAddress('0x' + hex21.slice(2));
}

async function deployProxy(hre, contractName, args = [], opts = {}) {
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

  const impl = await hre.ethers.deployContract(contractName);
  const implAddress = await impl.getAddress();

  const initData =
    initializer === false ? '0x' : impl.interface.encodeFunctionData(initializer, args);

  let proxy;
  if (kind === 'transparent') {
    const owner = opts.initialOwner ?? deployerAddress(hre);
    proxy = await hre.ethers.deployContract(FQN.transparent, [implAddress, owner, initData]);
  } else {
    proxy = await hre.ethers.deployContract(FQN.trc1967, [implAddress, initData]);
  }
  const proxyAddress = await proxy.getAddress();

  const manifest = readManifest(hre);
  manifest.proxies[proxyAddress.toLowerCase()] = {
    kind,
    contract: contractName,
    implementation: implAddress,
  };
  writeManifest(hre, manifest);

  return hre.ethers.getContractAt(contractName, proxyAddress);
}

async function upgradeProxy(hre, proxy, newContractName, opts = {}) {
  const proxyAddress = typeof proxy === 'string' ? proxy : await proxy.getAddress();

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

  const fromContractName = opts.from ?? (record && record.contract);
  if (!fromContractName) {
    throw new Error(
      `No deployment record for proxy ${proxyAddress} on network "${hre.network.name}" — pass opts.from with the current implementation's contract name (and opts.kind for non-transparent proxies).`,
    );
  }

  await validateUpgrade(hre, fromContractName, newContractName, { kind });

  // Resolve the upgrade authority BEFORE deploying the new implementation,
  // so a mis-routed proxy (e.g. a UUPS proxy taken down the transparent
  // path) fails without leaving an orphan implementation on the chain.
  // Without opts.owner, calls are signed by the deployer key (no signer
  // machinery needed — see deployerAddress).
  const withOwner = (contract) => (opts.owner ? contract.connect(opts.owner) : contract);
  let admin = null;
  if (kind === 'transparent') {
    const adminAddress = slotToAddress(await getSlot(hre, proxyAddress, ADMIN_SLOT));
    if (adminAddress === ZERO_ADDRESS) {
      throw new Error(
        `Proxy ${proxyAddress} has no admin in the 1967 admin slot — not a transparent proxy? For UUPS proxies pass opts.kind: "uups".`,
      );
    }
    admin = await hre.ethers.getContractAt(FQN.proxyAdmin, hre.ethers.getAddress(adminAddress));
  }

  const newImpl = await hre.ethers.deployContract(newContractName);
  const newImplAddress = await newImpl.getAddress();

  if (kind === 'uups') {
    // The upgrade function lives in the CURRENT implementation and is
    // reached through the proxy (delegatecall), so it mutates the proxy's
    // own 1967 slot.
    const proxyAsImpl = await hre.ethers.getContractAt(fromContractName, proxyAddress);
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

  return hre.ethers.getContractAt(newContractName, proxyAddress);
}


// -- beacons ---------------------------------------------------------

async function resolveAddress(target) {
  return typeof target === 'string' ? target : await target.getAddress();
}

async function deployBeacon(hre, contractName, opts = {}) {
  await validateImplementation(hre, contractName, { kind: 'beacon' });

  const impl = await hre.ethers.deployContract(contractName);
  const implAddress = await impl.getAddress();

  const owner = opts.initialOwner ?? deployerAddress(hre);
  const beacon = await hre.ethers.deployContract(FQN.beacon, [implAddress, owner]);
  const beaconAddress = await beacon.getAddress();

  const manifest = readManifest(hre);
  manifest.beacons[beaconAddress.toLowerCase()] = {
    contract: contractName,
    implementation: implAddress,
  };
  writeManifest(hre, manifest);

  return beacon;
}

async function deployBeaconProxy(hre, beacon, contractName, args = [], opts = {}) {
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

  const proxy = await hre.ethers.deployContract(FQN.beaconProxy, [beaconAddress, initData]);
  const proxyAddress = await proxy.getAddress();

  const manifest = readManifest(hre);
  manifest.proxies[proxyAddress.toLowerCase()] = {
    kind: 'beacon',
    beacon: beaconAddress,
  };
  writeManifest(hre, manifest);

  return hre.ethers.getContractAt(contractName, proxyAddress);
}

async function upgradeBeacon(hre, beacon, newContractName, opts = {}) {
  const beaconAddress = await resolveAddress(beacon);

  const manifest = readManifest(hre);
  const record = manifest.beacons[beaconAddress.toLowerCase()];
  const fromContractName = opts.from ?? (record && record.contract);
  if (!fromContractName) {
    throw new Error(
      `No deployment record for beacon ${beaconAddress} on network "${hre.network.name}" — pass opts.from with the current implementation's contract name.`,
    );
  }

  await validateUpgrade(hre, fromContractName, newContractName, { kind: 'beacon' });

  const beaconContract = await hre.ethers.getContractAt(FQN.beacon, beaconAddress);
  const newImpl = await hre.ethers.deployContract(newContractName);
  const newImplAddress = await newImpl.getAddress();

  const withOwner = (c) => (opts.owner ? c.connect(opts.owner) : c);
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

function makeUpgrades(hre) {
  const slotAddress = async (target, slot) =>
    hre.ethers.getAddress(slotToAddress(await getSlot(hre, await resolveAddress(target), slot)));
  return {
    deployProxy: (name, args, opts) => deployProxy(hre, name, args, opts),
    upgradeProxy: (proxy, name, opts) => upgradeProxy(hre, proxy, name, opts),
    deployBeacon: (name, opts) => deployBeacon(hre, name, opts),
    deployBeaconProxy: (beacon, name, args, opts) => deployBeaconProxy(hre, beacon, name, args, opts),
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
        const b = await hre.ethers.getContractAt(FQN.beacon, await resolveAddress(beacon));
        return b.implementation();
      },
    },
    trc1967: { IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT },
  };
}

module.exports = { makeUpgrades };
