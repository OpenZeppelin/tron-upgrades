import hre from 'hardhat';
import { expect } from 'chai';

const { ethers, upgrades } = hre;

const PROXY_ADMIN_FQN =
  '@openzeppelin/tron-contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin';

describe('proxy admin ownership', function () {
  this.timeout(240_000);

  it('transfers ownership and lets the new owner perform upgrades', async () => {
    const [owner, nextOwner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 31n]);
    const adminAddress = await upgrades.erc1967.getAdminAddress(box);
    const admin = await ethers.getContractAt(PROXY_ADMIN_FQN, adminAddress);
    expect(await admin.owner()).to.equal(owner.address);

    await upgrades.admin.transferProxyAdminOwnership(box, nextOwner.address);
    expect(await admin.owner()).to.equal(nextOwner.address);

    const boxV2 = await upgrades.upgradeProxy(box, 'TestBoxV2', { owner: nextOwner });
    expect(await boxV2.version()).to.equal('v2');
    expect(await boxV2.value()).to.equal(31n);
  });

  it('the old owner can no longer upgrade after transfer', async () => {
    const [owner, nextOwner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 32n]);
    await upgrades.admin.transferProxyAdminOwnership(box, nextOwner.address);
    const before = await upgrades.erc1967.getImplementationAddress(box);

    await expect(upgrades.upgradeProxy(box, 'TestBoxV2', { owner })).to.be.rejected;
    expect(await upgrades.erc1967.getImplementationAddress(box)).to.equal(before);
    expect(await box.version()).to.equal('v1');
  });

  it('rejects ownership transfer for a proxy with no admin slot', async () => {
    const [owner, nextOwner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 33n], { kind: 'uups' });
    await expect(
      upgrades.admin.transferProxyAdminOwnership(box, nextOwner.address),
    ).to.be.rejectedWith(/no admin|not a transparent proxy/i);
  });
});
