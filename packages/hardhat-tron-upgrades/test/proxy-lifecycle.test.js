'use strict';

const { expect } = require('chai');
const { ethers } = require('hardhat');

// ERC-1967 well-known slots (also used by the TRC1967 port).
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

// Read a raw storage slot; falls back to the node's eth JSON-RPC if the
// bridge provider doesn't implement getStorage.
async function getSlot(address, slot) {
  try {
    return await ethers.provider.getStorage(address, slot);
  } catch (_) {
    const url = process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getStorageAt',
        params: [address, slot, 'latest'],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`eth_getStorageAt: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}

function slotAddress(slotValue) {
  // slot holds a left-padded 20-byte address body
  return '0x' + slotValue.slice(-40).toLowerCase();
}

function body(address) {
  return address.toLowerCase().replace(/^0x/, '');
}

// The bridge's bare-name artifact index only covers local sources; contracts
// compiled from node_modules need fully-qualified names.
const PKG = 'openzeppelin-tron-solidity/contracts/proxy';
const TRANSPARENT_PROXY = `${PKG}/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy`;
const PROXY_ADMIN = `${PKG}/transparent/ProxyAdmin.sol:ProxyAdmin`;
const UPGRADEABLE_BEACON = `${PKG}/beacon/UpgradeableBeacon.sol:UpgradeableBeacon`;
const BEACON_PROXY = `${PKG}/beacon/BeaconProxy.sol:BeaconProxy`;

describe('Transparent proxy lifecycle on TVM', function () {
  this.timeout(240_000);

  it('deploys, verifies 1967 slots, upgrades, and preserves state', async () => {
    const [owner] = await ethers.getSigners();

    const implV1 = await ethers.deployContract('TestBoxV1');
    const implV2 = await ethers.deployContract('TestBoxV2');
    const v1Addr = await implV1.getAddress();
    const v2Addr = await implV2.getAddress();

    const initData = implV1.interface.encodeFunctionData('initialize', [owner.address, 42n]);
    const proxy = await ethers.deployContract(TRANSPARENT_PROXY, [
      v1Addr,
      owner.address,
      initData,
    ]);
    const proxyAddr = await proxy.getAddress();

    // calls are forwarded to the implementation
    const boxV1 = await ethers.getContractAt('TestBoxV1', proxyAddr);
    expect(await boxV1.value()).to.equal(42n);
    expect(await boxV1.version()).to.equal('v1');

    // 1967 implementation slot points at V1
    expect(slotAddress(await getSlot(proxyAddr, IMPL_SLOT))).to.equal('0x' + body(v1Addr));

    // admin slot holds the auto-created ProxyAdmin
    const adminAddr = slotAddress(await getSlot(proxyAddr, ADMIN_SLOT));
    expect(adminAddr).to.not.equal('0x' + '0'.repeat(40));

    // upgrade through the ProxyAdmin
    const admin = await ethers.getContractAt(PROXY_ADMIN, ethers.getAddress(adminAddr));
    await admin.connect(owner).upgradeAndCall(proxyAddr, v2Addr, '0x');

    // state preserved, new logic live, slot re-pointed
    const boxV2 = await ethers.getContractAt('TestBoxV2', proxyAddr);
    expect(await boxV2.value()).to.equal(42n);
    expect(await boxV2.version()).to.equal('v2');
    await boxV2.increment();
    expect(await boxV2.value()).to.equal(43n);
    expect(await boxV2.incrementCount()).to.equal(1n);
    expect(slotAddress(await getSlot(proxyAddr, IMPL_SLOT))).to.equal('0x' + body(v2Addr));
  });
});

describe('Beacon proxy lifecycle on TVM', function () {
  this.timeout(240_000);

  it('two proxies upgrade atomically when the beacon re-points', async () => {
    const [owner] = await ethers.getSigners();

    const implV1 = await ethers.deployContract('TestBoxV1');
    const implV2 = await ethers.deployContract('TestBoxV2');

    const beacon = await ethers.deployContract(UPGRADEABLE_BEACON, [
      await implV1.getAddress(),
      owner.address,
    ]);
    const beaconAddr = await beacon.getAddress();

    const init = (v) => implV1.interface.encodeFunctionData('initialize', [owner.address, v]);
    const proxyA = await ethers.deployContract(BEACON_PROXY, [beaconAddr, init(1n)]);
    const proxyB = await ethers.deployContract(BEACON_PROXY, [beaconAddr, init(2n)]);

    const a1 = await ethers.getContractAt('TestBoxV1', await proxyA.getAddress());
    const b1 = await ethers.getContractAt('TestBoxV1', await proxyB.getAddress());
    expect(await a1.version()).to.equal('v1');
    expect(await b1.value()).to.equal(2n);

    // beacon slot on the proxy points at the beacon
    expect(slotAddress(await getSlot(await proxyA.getAddress(), BEACON_SLOT))).to.equal(
      '0x' + body(beaconAddr),
    );

    // one upgrade, both proxies move
    await beacon.connect(owner).upgradeTo(await implV2.getAddress());
    const a2 = await ethers.getContractAt('TestBoxV2', await proxyA.getAddress());
    const b2 = await ethers.getContractAt('TestBoxV2', await proxyB.getAddress());
    expect(await a2.version()).to.equal('v2');
    expect(await b2.version()).to.equal('v2');
    expect(await a2.value()).to.equal(1n); // state preserved per-proxy
    expect(await b2.value()).to.equal(2n);
  });
});
