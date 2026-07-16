import hre from 'hardhat';
import { expect } from 'chai';
import { implEntry, readManifest } from './_manifest-helper';

const { ethers, upgrades } = hre;

describe('deployImplementation and prepareUpgrade', function () {
  this.timeout(240_000);

  it('deployImplementation validates, deploys, and records a standalone implementation', async () => {
    const address = await upgrades.deployImplementation('TestBoxV1');
    expect(await ethers.getContractAt('TestBoxV1', address).then((box) => box.version())).to.equal('v1');
    const entry = implEntry(await readManifest(), address);
    expect(entry).to.not.equal(undefined);
    expect(entry.layout).to.have.property('storage');
  });

  it('prepareUpgrade records a compatible implementation without changing a transparent proxy', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 21n]);
    const before = await upgrades.erc1967.getImplementationAddress(box);

    const prepared = await upgrades.prepareUpgrade(box, 'TestBoxV2');
    expect(await upgrades.erc1967.getImplementationAddress(box)).to.equal(before);
    expect(prepared.toLowerCase()).to.not.equal(before.toLowerCase());
    expect(implEntry(await readManifest(), prepared)).to.not.equal(undefined);
  });

  it('a manually installed prepared uups implementation becomes the next validation baseline', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 22n], { kind: 'uups' });
    const prepared = await upgrades.prepareUpgrade(box, 'TestBoxUUPSV2');

    await box.upgradeToAndCall(prepared, '0x');
    expect((await upgrades.erc1967.getImplementationAddress(box)).toLowerCase()).to.equal(
      prepared.toLowerCase(),
    );

    const boxV3 = await upgrades.upgradeProxy(box, 'TestBoxUUPSV3');
    expect(await boxV3.version()).to.equal('v3');
    expect(await boxV3.value()).to.equal(22n);
  });

  it('prepares against a bare implementation address with an explicit kind (upstream parity)', async () => {
    const implAddress = await upgrades.deployImplementation('TestBoxV1');
    const prepared = await upgrades.prepareUpgrade(implAddress, 'TestBoxV2', {
      kind: 'transparent',
    });
    expect(prepared.toLowerCase()).to.not.equal(implAddress.toLowerCase());
    expect(implEntry(await readManifest(), prepared)).to.not.equal(undefined);
  });

  it('rejects a bare implementation address without an explicit kind', async () => {
    const implAddress = await upgrades.deployImplementation('TestBoxV1');
    await expect(upgrades.prepareUpgrade(implAddress, 'TestBoxV2')).to.be.rejectedWith(
      /pass opts\.kind/,
    );
  });

  it('classifies by 1967 slots: a proxy whose implementation exposes implementation() stays a proxy', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxWithImplementationFn', [owner.address, 24n]);
    const prepared = await upgrades.prepareUpgrade(box, 'TestBoxV2');
    expect(implEntry(await readManifest(), prepared)).to.not.equal(undefined);
    expect(await upgrades.erc1967.getBeaconAddress(box)).to.equal(ethers.ZeroAddress);
  });

  it('accepts either a beacon or one of its proxies as the prepare reference', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const proxy = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 23n]);
    const before = await upgrades.beacon.getImplementationAddress(beacon);

    const fromProxy = await upgrades.prepareUpgrade(proxy, 'TestBoxV2');
    const fromBeacon = await upgrades.prepareUpgrade(beacon, 'TestBoxV2');
    expect(await upgrades.beacon.getImplementationAddress(beacon)).to.equal(before);
    expect(implEntry(await readManifest(), fromProxy)).to.not.equal(undefined);
    expect(implEntry(await readManifest(), fromBeacon)).to.not.equal(undefined);
  });
});
