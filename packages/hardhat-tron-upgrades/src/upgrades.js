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

// -- validation (off-chain, over compiler build-info) ---------------

async function upgradeableContractFor(hre, contractName) {
  // lazy-require keeps `hardhat compile`-time loads cheap
  const { UpgradeableContract } = require('@openzeppelin/upgrades-core');
  const artifact = await hre.artifacts.readArtifact(contractName);
  const fqName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) {
    throw new Error(`No build-info for ${fqName}. Run \`hardhat compile\` first.`);
  }
  return {
    artifact,
    contract: new UpgradeableContract(
      artifact.contractName,
      buildInfo.input,
      buildInfo.output,
      {},
      buildInfo.solcVersion,
    ),
  };
}

async function validateImplementation(hre, contractName) {
  const { contract } = await upgradeableContractFor(hre, contractName);
  const report = contract.getErrorReport();
  if (!report.ok) {
    throw new Error(`${contractName} is not upgrade-safe:\n${report.explain()}`);
  }
}

async function validateUpgrade(hre, fromContractName, toContractName) {
  const from = await upgradeableContractFor(hre, fromContractName);
  const to = await upgradeableContractFor(hre, toContractName);
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
// contract currently behind the proxy. Not yet compatible with the
// upstream .openzeppelin manifest schema.

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

async function defaultOwner(hre) {
  const signers = await hre.ethers.getSigners();
  return signers[0];
}

async function deployProxy(hre, contractName, args = [], opts = {}) {
  const kind = opts.kind ?? 'transparent';
  if (kind !== 'transparent' && kind !== 'trc1967') {
    throw new Error(`kind "${kind}" not supported yet (transparent | trc1967)`);
  }
  await validateImplementation(hre, contractName);

  const impl = await hre.ethers.deployContract(contractName);
  const implAddress = await impl.getAddress();

  const initializer = opts.initializer ?? 'initialize';
  const initData =
    initializer === false ? '0x' : impl.interface.encodeFunctionData(initializer, args);

  let proxy;
  if (kind === 'transparent') {
    const owner = opts.initialOwner ?? (await defaultOwner(hre)).address;
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
  const fromContractName = opts.from ?? (record && record.contract);
  if (!fromContractName) {
    throw new Error(
      `No deployment record for proxy ${proxyAddress} on network "${hre.network.name}" — pass opts.from with the current implementation's contract name.`,
    );
  }
  if (record && record.kind !== 'transparent') {
    throw new Error(`upgradeProxy currently supports transparent proxies only (got "${record.kind}")`);
  }

  await validateUpgrade(hre, fromContractName, newContractName);

  const newImpl = await hre.ethers.deployContract(newContractName);
  const newImplAddress = await newImpl.getAddress();

  const adminAddress = hre.ethers.getAddress(slotToAddress(await getSlot(hre, proxyAddress, ADMIN_SLOT)));
  const admin = await hre.ethers.getContractAt(FQN.proxyAdmin, adminAddress);
  const owner = opts.owner ?? (await defaultOwner(hre));
  await admin.connect(owner).upgradeAndCall(proxyAddress, newImplAddress, opts.call ?? '0x');

  // trust, but verify: the implementation slot must now hold the new address
  const current = slotToAddress(await getSlot(hre, proxyAddress, IMPL_SLOT)).toLowerCase();
  if (current !== newImplAddress.toLowerCase()) {
    throw new Error(
      `Upgrade transaction succeeded but the implementation slot holds ${current}, expected ${newImplAddress}`,
    );
  }

  if (record) {
    record.contract = newContractName;
    record.implementation = newImplAddress;
    writeManifest(hre, manifest);
  }

  return hre.ethers.getContractAt(newContractName, proxyAddress);
}

function makeUpgrades(hre) {
  return {
    deployProxy: (name, args, opts) => deployProxy(hre, name, args, opts),
    upgradeProxy: (proxy, name, opts) => upgradeProxy(hre, proxy, name, opts),
    validateImplementation: (name) => validateImplementation(hre, name),
    validateUpgrade: (from, to) => validateUpgrade(hre, from, to),
    trc1967: { IMPL_SLOT, ADMIN_SLOT },
  };
}

module.exports = { makeUpgrades };
