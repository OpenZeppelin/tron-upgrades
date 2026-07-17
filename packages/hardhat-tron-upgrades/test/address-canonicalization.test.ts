import hre from 'hardhat';
import { expect } from 'chai';

const { ethers, upgrades } = hre;

// Hex addresses are case-insensitive, but the manifest lookups in
// @openzeppelin/upgrades-core compare address strings with `===`. If an
// address reaches the plugin in a different casing than the manifest recorded,
// those lookups miss — dropping the recorded proxy kind (a routing/authority
// decision) and the recorded implementation layout. Every public entry point
// must therefore canonicalize addresses before they reach the manifest.

describe('address canonicalization at the API boundary', function () {
  this.timeout(240_000);

  it('keeps a transparent proxy on its recorded kind when the address casing differs', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 71n]);
    const checksummed = await box.getAddress();
    const lowercased = checksummed.toLowerCase();

    // The proxy is recorded 'transparent', so its upgrade must go through the
    // ProxyAdmin. A UUPS-inferring new implementation must be rejected as a
    // kind mismatch — never silently re-routed onto the UUPS path because the
    // caller happened to pass a lowercase address.
    await expect(upgrades.upgradeProxy(lowercased, 'TestBoxUUPSV1')).to.be.rejectedWith(
      /kind uups but proxy is transparent|proxy is transparent.*kind uups/i,
    );

    const still = await ethers.getContractAt('TestBoxV1', checksummed);
    expect(await still.version()).to.equal('v1');
  });

  it('keeps a uups proxy on its recorded kind when the address casing differs', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 72n]);
    const lowercased = (await box.getAddress()).toLowerCase();

    await expect(upgrades.upgradeProxy(lowercased, 'TestBoxV2')).to.be.rejectedWith(
      /kind transparent but proxy is uups|proxy is uups.*kind transparent/i,
    );
    expect(await box.version()).to.equal('v1');
  });

  it('registers a force-imported bare implementation under a canonical address', async () => {
    const impl = await ethers.deployContract('TestBoxV1');
    const checksummed = await impl.getAddress();
    const lowercased = checksummed.toLowerCase();

    await upgrades.forceImport(lowercased, 'TestBoxV1');

    // The chain returns implementation addresses checksummed. A later operation
    // that looks the implementation up by that checksummed form must still find
    // the registered layout rather than reporting it unregistered.
    const prepared = await upgrades.prepareUpgrade(checksummed, 'TestBoxV2', { kind: 'transparent' });
    expect(prepared).to.match(/^0x[0-9a-fA-F]{40}$/);
  });
});
