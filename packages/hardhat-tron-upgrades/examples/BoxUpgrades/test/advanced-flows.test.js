'use strict';

const { expect } = require('chai');
const hre = require('hardhat');
const { ethers, upgrades } = hre;

// Exercises the rest of the plugin surface through the PACKED tarball: the
// beacon lifecycle, forceImport, prepareUpgrade, and a Base58 (T...) address
// input — the encoding a TRON user actually pastes.
describe('Advanced flows through the packed tarball', function () {
  this.timeout(240_000);

  it('beacon: deployBeacon → deployBeaconProxy → upgradeBeacon moves the fleet', async () => {
    const [owner] = await ethers.getSigners();

    const beacon = await upgrades.deployBeacon('BoxV1');
    const p1 = await upgrades.deployBeaconProxy(beacon, 'BoxV1', [owner.address, 1n]);
    const p2 = await upgrades.deployBeaconProxy(beacon, 'BoxV1', [owner.address, 2n]);
    expect(await p1.value()).to.equal(1n);
    expect(await p2.value()).to.equal(2n);

    await upgrades.upgradeBeacon(beacon, 'BoxV2');

    const p1v2 = await ethers.getContractAt('BoxV2', await p1.getAddress());
    const p2v2 = await ethers.getContractAt('BoxV2', await p2.getAddress());
    expect(await p1v2.version()).to.equal('v2');
    expect(await p2v2.version()).to.equal('v2');
    expect(await p1v2.value()).to.equal(1n); // per-proxy state intact
    expect(await p2v2.value()).to.equal(2n);
  });

  it('forceImport + prepareUpgrade accept a Base58 (T...) address', async () => {
    const [owner] = await ethers.getSigners();

    const box = await upgrades.deployProxy('BoxV1', [owner.address, 5n]);
    const evmAddress = await box.getAddress();

    // The same proxy in the canonical TRON encoding a user would paste.
    const { tronWeb } = hre.tre.makeTronWeb();
    const base58 = tronWeb.address.fromHex('41' + evmAddress.slice(2));
    expect(base58.startsWith('T')).to.equal(true);

    // forceImport registers the live proxy from its Base58 address.
    const imported = await upgrades.forceImport(base58, 'BoxV1', { kind: 'transparent' });
    expect(await imported.value()).to.equal(5n);

    // prepareUpgrade validates + deploys the next impl without re-pointing,
    // taking the Base58 address as the reference.
    const preparedImpl = await upgrades.prepareUpgrade(base58, 'BoxV2');
    expect(preparedImpl).to.be.a('string');
    expect(await box.version()).to.equal('v1'); // proxy untouched by prepareUpgrade
  });
});
