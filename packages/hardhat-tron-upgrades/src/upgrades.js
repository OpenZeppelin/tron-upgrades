'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ADMIN_SLOT, IMPL_SLOT, getSlot, slotToAddress } = require('./slots');

// Proxy artifacts come from the ported contracts library, compiled by the
// consumer project (see README). Fully-qualified names are required because
// the bridge's bare-name artifact index only covers local sources.
const PROXY_PKG = 'openzeppelin-tron-solidity/contracts/proxy';
const FQN = {
  transparent: `${PROXY_PKG}/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy`,
  proxyAdmin: `${PROXY_PKG}/transparent/ProxyAdmin.sol:ProxyAdmin`,
  trc1967: `${PROXY_PKG}/TRC1967/TRC1967Proxy.sol:TRC1967Proxy`,
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
  if (!fs.existsSync(p)) return { proxies: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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

function makeUpgrades(hre) {
  return {
    deployProxy: (name, args, opts) => deployProxy(hre, name, args, opts),
    upgradeProxy: (proxy, name, opts) => upgradeProxy(hre, proxy, name, opts),
    validateImplementation: (name, opts) => validateImplementation(hre, name, opts),
    validateUpgrade: (from, to, opts) => validateUpgrade(hre, from, to, opts),
    trc1967: { IMPL_SLOT, ADMIN_SLOT },
  };
}

module.exports = { makeUpgrades };
