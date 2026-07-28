import hre from 'hardhat';
import { expect } from 'chai';

const { ethers, upgrades } = hre;

// validateUpgrade also accepts a DEPLOYED reference as its first argument
// (a proxy, a beacon, one of a beacon's proxies, or a bare implementation
// address) and validates a candidate WITHOUT deploying it, comparing the
// candidate's storage layout against the manifest-stored layout of the
// implementation currently installed at the reference. This mirrors upstream
// validateUpgrade(proxyOrBeaconAddress, newImplFactory, opts).
function tronForms(hexAddress: string): { hex0x: string; hex41: string; base58: string } {
  const { tronWeb } = (hre as any).tre.makeTronWeb();
  const hex41 = tronWeb.address.toHex(hexAddress);
  return { hex0x: hexAddress, hex41, base58: tronWeb.address.fromHex(hex41) };
}

describe('validateUpgrade against a deployed reference', function () {
  this.timeout(240_000);

  it('transparent proxy reference: accepts a layout-compatible candidate without deploying', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 60n]);
    const implBefore = await upgrades.erc1967.getImplementationAddress(box);

    await upgrades.validateUpgrade(box, 'TestBoxV2'); // must not throw

    // no deploy side effect: the proxy still points at the same implementation
    expect(await upgrades.erc1967.getImplementationAddress(box)).to.equal(implBefore);
  });

  it('transparent proxy reference: rejects a storage-incompatible candidate', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 61n]);

    await expect(upgrades.validateUpgrade(box, 'TestBoxV2StorageConflict')).to.be.rejectedWith(
      /incompatible|storage/i,
    );
  });

  it('uups proxy reference, kind omitted: the buttonless candidate conflicts with the recorded uups kind', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 62n], { kind: 'uups' });

    // A buttonless candidate self-infers 'transparent'; the reference kind is
    // honored from the manifest record ('uups'), so the mismatch is rejected
    // before the proxy can be bricked.
    await expect(
      upgrades.validateUpgrade(box, 'TestBoxUUPSV2MissingUpgradeFunction'),
    ).to.be.rejectedWith(/kind transparent.*proxy is uups|proxy is uups.*kind transparent/i);
  });

  it('uups proxy reference, explicit kind: rejects the buttonless candidate with the missing-upgradeTo error', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 65n], { kind: 'uups' });

    await expect(
      upgrades.validateUpgrade(box, 'TestBoxUUPSV2MissingUpgradeFunction', { kind: 'uups' }),
    ).to.be.rejectedWith(/is not upgrade-safe[\s\S]*upgradeTo/i);
  });

  it('beacon reference: validates the candidate against the beacon implementation', async () => {
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const implBefore = await upgrades.beacon.getImplementationAddress(beacon);

    await upgrades.validateUpgrade(beacon, 'TestBoxV2'); // must not throw

    expect(await upgrades.beacon.getImplementationAddress(beacon)).to.equal(implBefore);
  });

  it('beacon-proxy reference: resolves the beacon and validates the candidate', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const proxy = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 63n]);

    await upgrades.validateUpgrade(proxy, 'TestBoxV2'); // must not throw
  });

  it('bare implementation reference without kind: requires an explicit kind', async () => {
    const implAddress = await upgrades.deployImplementation('TestBoxV1');

    await expect(upgrades.validateUpgrade(implAddress, 'TestBoxV2')).to.be.rejectedWith(
      /`kind` option must be provided|kind.*option/i,
    );
  });

  it('bare implementation reference with kind: validates against its recorded layout', async () => {
    const implAddress = await upgrades.deployImplementation('TestBoxV1');

    await upgrades.validateUpgrade(implAddress, 'TestBoxV2', { kind: 'transparent' }); // must not throw
  });

  it('unregistered reference: directs the user to forceImport', async () => {
    // A bare implementation deployed OUTSIDE the plugin is not in the manifest,
    // so its stored layout is unknown.
    const impl = await ethers.deployContract('TestBoxV1');
    const implAddress = await impl.getAddress();

    await expect(
      upgrades.validateUpgrade(implAddress, 'TestBoxV2', { kind: 'transparent' }),
    ).to.be.rejectedWith(/forceImport/);
  });

  for (const fmt of ['hex41', 'base58'] as const) {
    it(`accepts a proxy reference in ${fmt} form (canonicalization)`, async () => {
      const [owner] = await ethers.getSigners();
      const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 64n]);
      const reference = tronForms(await box.getAddress())[fmt];

      await upgrades.validateUpgrade(reference, 'TestBoxV2'); // must not throw
    });
  }
});
