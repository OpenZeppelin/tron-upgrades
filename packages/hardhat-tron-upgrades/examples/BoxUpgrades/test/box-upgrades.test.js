'use strict';

const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

// The point of this example: prove the PACKED plugin (installed like an npm
// user would) actually performs the upgrade lifecycle — not just that the
// bridge deploys contracts.
describe('Upgrades plugin through the packed tarball', function () {
  this.timeout(240_000);

  it('transparent: deployProxy → state → upgradeProxy → state preserved + V2 live', async () => {
    const [owner] = await ethers.getSigners();

    const box = await upgrades.deployProxy('BoxV1', [owner.address, 42n]);
    const boxAddress = await box.getAddress();
    expect(await box.value()).to.equal(42n);
    expect(await box.version()).to.equal('v1');

    const boxV2 = await upgrades.upgradeProxy(box, 'BoxV2');
    expect(await boxV2.getAddress()).to.equal(boxAddress); // same address
    expect(await boxV2.value()).to.equal(42n); // state preserved
    expect(await boxV2.version()).to.equal('v2'); // new logic live
    await boxV2.increment();
    expect(await boxV2.value()).to.equal(43n);
  });

  it('uups: lifecycle works and the anti-brick rail rejects off-chain', async () => {
    const [owner] = await ethers.getSigners();

    const box = await upgrades.deployProxy('BoxUUPSV1', [owner.address, 7n], { kind: 'uups' });
    const boxV2 = await upgrades.upgradeProxy(box, 'BoxUUPSV2');
    expect(await boxV2.value()).to.equal(7n);
    expect(await boxV2.version()).to.equal('v2');

    let error = null;
    try {
      await upgrades.upgradeProxy(boxV2, 'BoxUUPSV2NoButton');
    } catch (e) {
      error = e;
    }
    expect(error, 'anti-brick must reject').to.not.equal(null);
    expect(error.message).to.match(/upgradeTo/i);
    expect(await boxV2.version()).to.equal('v2'); // untouched
  });
});
