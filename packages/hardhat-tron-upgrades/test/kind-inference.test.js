'use strict';

const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { readManifest, proxyRecord } = require('./_manifest-helper');

describe('proxy kind inference', function () {
  this.timeout(240_000);

  it('deployProxy infers uups from public upgrade-function signatures', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 51n]);
    expect(await upgrades.erc1967.getAdminAddress(box)).to.equal(ethers.ZeroAddress);
    expect(proxyRecord(await readManifest(), await box.getAddress()).kind).to.equal('uups');
  });

  it('deployProxy infers transparent when no public upgrade function exists', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 52n]);
    expect(await upgrades.erc1967.getAdminAddress(box)).to.not.equal(ethers.ZeroAddress);
    expect(proxyRecord(await readManifest(), await box.getAddress()).kind).to.equal('transparent');
  });

  it('rejects a new implementation whose inferred kind conflicts with the recorded proxy kind', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 53n]);
    await expect(upgrades.upgradeProxy(box, 'TestBoxV2')).to.be.rejectedWith(
      /kind transparent.*proxy is uups|proxy is uups.*kind transparent/i,
    );
    expect(await box.version()).to.equal('v1');
  });
});
