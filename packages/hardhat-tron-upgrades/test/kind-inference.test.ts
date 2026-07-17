import hre from 'hardhat';
import { expect } from 'chai';
import { proxyRecord, readManifest } from './_manifest-helper';

const { ethers, upgrades } = hre;

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

// Standalone validateUpgrade has no on-chain proxy to read the kind from, so
// when `kind` is omitted it must infer the kind from the REFERENCE contract.
// Inferring from the candidate is unsafe: a candidate that dropped its upgrade
// function self-infers 'transparent', which suppresses the missing-upgradeTo
// error and would let a UUPS proxy be bricked.
describe('standalone validateUpgrade infers proxy kind from the reference', function () {
  this.timeout(240_000);

  it('kind omitted: rejects a UUPS reference upgraded to an impl with no upgrade function', async () => {
    await expect(
      upgrades.validateUpgrade('TestBoxUUPSV1', 'TestBoxUUPSV2MissingUpgradeFunction'),
    ).to.be.rejectedWith(/is not upgrade-safe[\s\S]*upgradeTo/i);
  });

  it('explicit kind uups: rejects the same pair', async () => {
    await expect(
      upgrades.validateUpgrade('TestBoxUUPSV1', 'TestBoxUUPSV2MissingUpgradeFunction', {
        kind: 'uups',
      }),
    ).to.be.rejectedWith(/is not upgrade-safe[\s\S]*upgradeTo/i);
  });

  it('explicit kind transparent: accepts the same pair (documented escape hatch)', async () => {
    // must not throw: transparent proxies have no in-implementation upgrade
    // mechanism, so the missing-upgradeTo error does not apply.
    await upgrades.validateUpgrade('TestBoxUUPSV1', 'TestBoxUUPSV2MissingUpgradeFunction', {
      kind: 'transparent',
    });
  });

  it('kind omitted: accepts a transparent reference upgraded to a compatible impl', async () => {
    // inference yields 'transparent'; the layout-compatible upgrade is safe.
    await upgrades.validateUpgrade('TestBoxV1', 'TestBoxV2'); // must not throw
  });
});
