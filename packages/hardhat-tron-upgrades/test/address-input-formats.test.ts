import hre from 'hardhat';
import { expect } from 'chai';

const { ethers, upgrades } = hre;

// TVM addresses have three interchangeable encodings for the same account:
// Base58Check (`T...`), TRON-hex (`41` + 20 bytes), and EVM-hex (`0x` + 20
// bytes). Any of them may reach a public entry point — a caller pasting a
// value from a block explorer (Base58), from a TronWeb call (`41`-hex), or
// from an ethers contract (`0x`-hex). Every entry point must accept all three
// and canonicalize to the EIP-55 checksummed `0x` form the manifest records.
function tronForms(hexAddress: string): { hex0x: string; hex41: string; base58: string } {
  const { tronWeb } = (hre as any).tre.makeTronWeb();
  const hex41 = tronWeb.address.toHex(hexAddress);
  return {
    hex0x: hexAddress,
    hex41,
    base58: tronWeb.address.fromHex(hex41),
  };
}

describe('native TRON address formats at the API boundary', function () {
  this.timeout(240_000);

  for (const fmt of ['hex0x', 'hex41', 'base58'] as const) {
    it(`upgradeProxy accepts a proxy address in ${fmt} form`, async () => {
      const [owner] = await ethers.getSigners();
      const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 90n]);
      const checksummed = await box.getAddress();

      const upgraded = await upgrades.upgradeProxy(tronForms(checksummed)[fmt], 'TestBoxV2');
      expect(await upgraded.version()).to.equal('v2');
      expect(await upgraded.value()).to.equal(90n);
    });

    it(`forceImport accepts an implementation address in ${fmt} form`, async () => {
      const impl = await ethers.deployContract('TestBoxV1');
      const checksummed = await impl.getAddress();

      const imported = await upgrades.forceImport(tronForms(checksummed)[fmt], 'TestBoxV1');
      expect(await imported.version()).to.equal('v1');
    });
  }

  for (const fmt of ['hex41', 'base58'] as const) {
    it(`deployProxy accepts initialOwner in ${fmt} form`, async () => {
      const [deployer, nextOwner] = await ethers.getSigners();
      const box = await upgrades.deployProxy('TestBoxV1', [deployer.address, 91n], {
        initialOwner: tronForms(nextOwner.address)[fmt],
      });
      const adminAddress = await upgrades.erc1967.getAdminAddress(box);
      const admin = await ethers.getContractAt(
        '@openzeppelin/tron-contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
        adminAddress,
      );

      expect(await admin.owner()).to.equal(nextOwner.address);
    });

    it(`transferProxyAdminOwnership accepts newOwner in ${fmt} form`, async () => {
      const [deployer, nextOwner] = await ethers.getSigners();
      const box = await upgrades.deployProxy('TestBoxV1', [deployer.address, 92n]);
      const adminAddress = await upgrades.erc1967.getAdminAddress(box);
      const admin = await ethers.getContractAt(
        '@openzeppelin/tron-contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
        adminAddress,
      );

      await upgrades.admin.transferProxyAdminOwnership(box, tronForms(nextOwner.address)[fmt]);
      expect(await admin.owner()).to.equal(nextOwner.address);
    });
  }

  it('deployBeacon accepts initialOwner in Base58 form', async () => {
    const [, nextOwner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1', {
      initialOwner: tronForms(nextOwner.address).base58,
    });

    expect(await beacon.owner()).to.equal(nextOwner.address);
  });

  it('rejects a 21-byte native-hex address whose network prefix is not 41', async () => {
    const implementation = await ethers.deployContract('TestBoxV1');
    const invalidPrefix = '42' + tronForms(await implementation.getAddress()).hex41.slice(2);

    await expect(upgrades.forceImport(invalidPrefix, 'TestBoxV1')).to.be.rejectedWith(
      /invalid TRON address/i,
    );
  });
});
