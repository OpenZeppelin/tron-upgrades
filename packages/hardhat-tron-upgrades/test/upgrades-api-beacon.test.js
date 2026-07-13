'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const { ethers, upgrades, network, config } = require('hardhat');

function readManifest() {
  const p = path.join(config.paths.root, '.openzeppelin', `${network.name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('hre.upgrades API — beacon kind', function () {
  this.timeout(240_000);

  it('deploys a beacon fleet: one beacon, two proxies, records written', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const beaconAddress = await beacon.getAddress();

    const a = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 1n]);
    const b = await upgrades.deployBeaconProxy(beaconAddress, 'TestBoxV1', [owner.address, 2n]);

    expect(await a.value()).to.equal(1n);
    expect(await b.value()).to.equal(2n);
    expect(await a.version()).to.equal('v1');

    // the proxy's 1967 beacon slot points at the beacon
    expect((await upgrades.erc1967.getBeaconAddress(a)).toLowerCase()).to.equal(
      beaconAddress.toLowerCase(),
    );
    // the beacon getter agrees with the manifest
    const manifest = readManifest();
    const beaconRecord = manifest.beacons[beaconAddress.toLowerCase()];
    expect(beaconRecord.contract).to.equal('TestBoxV1');
    expect((await upgrades.beacon.getImplementationAddress(beacon)).toLowerCase()).to.equal(
      beaconRecord.implementation.toLowerCase(),
    );
    // proxy records carry the kind and their beacon
    const proxyRecord = manifest.proxies[(await a.getAddress()).toLowerCase()];
    expect(proxyRecord.kind).to.equal('beacon');
    expect(proxyRecord.beacon.toLowerCase()).to.equal(beaconAddress.toLowerCase());
  });

  it('one beacon upgrade moves every proxy, preserving per-proxy state', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const a = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 10n]);
    const b = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 20n]);

    await upgrades.upgradeBeacon(beacon, 'TestBoxV2');

    const a2 = await ethers.getContractAt('TestBoxV2', await a.getAddress());
    const b2 = await ethers.getContractAt('TestBoxV2', await b.getAddress());
    expect(await a2.version()).to.equal('v2');
    expect(await b2.version()).to.equal('v2');
    expect(await a2.value()).to.equal(10n); // per-proxy state intact
    expect(await b2.value()).to.equal(20n);
    await a2.increment();
    expect(await a2.value()).to.equal(11n);
    expect(await b2.value()).to.equal(20n); // b untouched by a's tx

    // manifest followed
    expect(readManifest().beacons[(await beacon.getAddress()).toLowerCase()].contract).to.equal(
      'TestBoxV2',
    );
  });

  it('rejects a layout-incompatible beacon upgrade off-chain', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 3n]);
    const implBefore = await upgrades.beacon.getImplementationAddress(beacon);

    let error = null;
    try {
      await upgrades.upgradeBeacon(beacon, 'TestBoxV2StorageConflict');
    } catch (e) {
      error = e;
    }
    expect(error, 'expected the beacon upgrade to be rejected').to.not.equal(null);
    expect(error.message).to.match(/incompatible/i);
    expect(await upgrades.beacon.getImplementationAddress(beacon)).to.equal(implBefore);
  });

  it('routes upgradeProxy on a beacon proxy to a helpful error', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const a = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 4n]);

    let error = null;
    try {
      await upgrades.upgradeProxy(a, 'TestBoxV2');
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
    expect(error.message).to.match(/upgradeBeacon/);
    expect(await a.version()).to.equal('v1');
  });

  it('erc1967 getters agree across kinds', async () => {
    const [owner] = await ethers.getSigners();

    const t = await upgrades.deployProxy('TestBoxV1', [owner.address, 5n]);
    const tImpl = await upgrades.erc1967.getImplementationAddress(t);
    const tAdmin = await upgrades.erc1967.getAdminAddress(t);
    expect(tImpl).to.not.equal(ethers.ZeroAddress);
    expect(tAdmin).to.not.equal(ethers.ZeroAddress);
    expect(tImpl.toLowerCase()).to.equal(
      readManifest().proxies[(await t.getAddress()).toLowerCase()].implementation.toLowerCase(),
    );

    const u = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 6n], { kind: 'uups' });
    expect(await upgrades.erc1967.getAdminAddress(u)).to.equal(ethers.ZeroAddress); // uups: no admin
    expect(await upgrades.erc1967.getImplementationAddress(u)).to.not.equal(ethers.ZeroAddress);
  });

  it('a bad contract name fails before any deploy or record — even with initializer: false', async () => {
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const proxiesBefore = Object.keys(readManifest().proxies).length;

    let error = null;
    try {
      await upgrades.deployBeaconProxy(beacon, 'TestBoxV1Typo', [], { initializer: false });
    } catch (e) {
      error = e;
    }
    expect(error, 'expected the bad name to be rejected').to.not.equal(null);
    expect(error.message).to.match(/TestBoxV1Typo|not found|artifact/i);
    // nothing was deployed, nothing was recorded
    expect(Object.keys(readManifest().proxies).length).to.equal(proxiesBefore);
  });

  it('supports initializer: false — uninitialized beacon proxy, initialized later', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const a = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [], { initializer: false });

    // delegation works while uninitialized
    expect(await a.version()).to.equal('v1');
    expect(await a.value()).to.equal(0n);
    expect(await a.owner()).to.equal(ethers.ZeroAddress);

    // and the proxy can be initialized afterwards
    await a.initialize(owner.address, 9n);
    expect(await a.value()).to.equal(9n);
    expect(await a.owner()).to.equal(owner.address);
  });
});
