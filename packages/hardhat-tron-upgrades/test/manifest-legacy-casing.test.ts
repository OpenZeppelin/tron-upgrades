import hre from 'hardhat';
import { expect } from 'chai';
import { proxyRecord, readManifest, writeManifest } from './_manifest-helper';

const { ethers, upgrades } = hre;

// A deployment recorded before addresses were canonicalized stores its proxy
// and implementation addresses in lowercase. upgrades-core's manifest lookups
// compare addresses with strict equality, so a checksummed address arriving at
// a public entry point misses a lowercase record: the recorded proxy kind is
// dropped and re-inferred from the new implementation, which can route a
// transparent proxy onto the UUPS path (around its ProxyAdmin). The recorded
// kind must stay authoritative regardless of the stored casing.
async function lowercaseStoredAddresses(): Promise<void> {
  const data = await readManifest();
  for (const p of data.proxies) p.address = p.address.toLowerCase();
  for (const key of Object.keys(data.impls)) {
    const impl = data.impls[key];
    impl.address = impl.address.toLowerCase();
    if (Array.isArray(impl.allAddresses)) {
      impl.allAddresses = impl.allAddresses.map((a: string) => a.toLowerCase());
    }
  }
  await writeManifest(data);
}

describe('legacy lowercase manifest records', function () {
  this.timeout(240_000);

  it('keeps a transparent proxy on its recorded kind despite lowercase storage', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 83n]);
    const checksummed = await box.getAddress();

    await lowercaseStoredAddresses();
    expect(proxyRecord(await readManifest(), checksummed).address).to.equal(checksummed.toLowerCase());

    // The recorded kind is 'transparent', so a UUPS-inferring implementation
    // must be rejected as a kind mismatch — never silently re-routed onto the
    // UUPS path because the stored record was lowercase.
    await expect(upgrades.upgradeProxy(checksummed, 'TestBoxUUPSV1')).to.be.rejectedWith(
      /kind uups but proxy is transparent|proxy is transparent.*kind uups/i,
    );

    const still = await ethers.getContractAt('TestBoxV1', checksummed);
    expect(await still.version()).to.equal('v1');
  });

  it('rejects an explicit kind that conflicts with a lowercase-recorded proxy', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 84n]);
    const checksummed = await box.getAddress();

    await lowercaseStoredAddresses();

    await expect(
      upgrades.upgradeProxy(checksummed, 'TestBoxV2', { kind: 'uups' }),
    ).to.be.rejectedWith(/kind uups but proxy is transparent|proxy is transparent.*kind uups/i);
  });

  it('keeps a uups proxy on its recorded kind despite lowercase storage', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 85n]);

    await lowercaseStoredAddresses();

    await expect(upgrades.upgradeProxy(await box.getAddress(), 'TestBoxV2')).to.be.rejectedWith(
      /kind transparent but proxy is uups|proxy is uups.*kind transparent/i,
    );
    expect(await box.version()).to.equal('v1');
  });
});
