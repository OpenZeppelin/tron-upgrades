import hre from 'hardhat';
import { expect } from 'chai';
import { implEntry, proxyRecord, readManifest } from './_manifest-helper';

const { ethers, upgrades } = hre;

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
    // beacons need no manifest section: the beacon's current implementation
    // is read from the chain and must be registered (with its layout)
    const manifest = await readManifest();
    const beaconImpl = await upgrades.beacon.getImplementationAddress(beacon);
    const entry = implEntry(manifest, beaconImpl);
    expect(entry, "the beacon's implementation must be registered").to.not.equal(undefined);
    expect(entry.layout).to.have.property('storage');
    // proxy records carry the kind
    expect(proxyRecord(manifest, await a.getAddress()).kind).to.equal('beacon');
    expect(proxyRecord(manifest, await b.getAddress()).kind).to.equal('beacon');
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

    // manifest followed: the beacon's NEW on-chain implementation is registered
    const implV2 = await upgrades.beacon.getImplementationAddress(beacon);
    expect(implEntry(await readManifest(), implV2)).to.not.equal(undefined);
  });

  it('rejects a layout-incompatible beacon upgrade off-chain', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 3n]);
    const implBefore = await upgrades.beacon.getImplementationAddress(beacon);

    let error: any = null;
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

    let error: any = null;
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
    // the slot getter and the manifest agree: the on-chain impl is registered
    expect(implEntry(await readManifest(), tImpl)).to.not.equal(undefined);

    const u = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 6n], { kind: 'uups' });
    expect(await upgrades.erc1967.getAdminAddress(u)).to.equal(ethers.ZeroAddress); // uups: no admin
    expect(await upgrades.erc1967.getImplementationAddress(u)).to.not.equal(ethers.ZeroAddress);
  });

  it('a bad contract name fails before any deploy or record — even with initializer: false', async () => {
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const proxiesBefore = (await readManifest()).proxies.length;

    let error: any = null;
    try {
      await upgrades.deployBeaconProxy(beacon, 'TestTestBoxV1Typo', [], { initializer: false });
    } catch (e) {
      error = e;
    }
    expect(error, 'expected the bad name to be rejected').to.not.equal(null);
    expect(error.message).to.match(/TestTestBoxV1Typo|not found|artifact/i);
    // nothing was deployed, nothing was recorded
    expect((await readManifest()).proxies.length).to.equal(proxiesBefore);
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
