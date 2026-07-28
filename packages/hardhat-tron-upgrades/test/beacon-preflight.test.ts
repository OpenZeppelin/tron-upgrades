import hre from 'hardhat';
import { expect } from 'chai';
import { readManifest } from './_manifest-helper';

const { ethers, upgrades } = hre;

// Operations that take a beacon address must confirm the target is actually an
// upgradeable beacon (an implementation() getter returning an address) BEFORE
// any chain interaction, and reject a non-beacon `kind` up front — mirroring
// upstream's deployBeaconProxy / upgradeBeacon guards. A precise error names
// the offending address and the expected interface.
describe('Beacon preflight', function () {
  this.timeout(240_000);

  it('deployBeaconProxy rejects a non-beacon target before touching the chain', async () => {
    const [owner] = await ethers.getSigners();
    const notABeacon: string = await upgrades.deployImplementation('TestBoxV1');
    const proxiesBefore = (await readManifest()).proxies.length;

    let error: any = null;
    try {
      await upgrades.deployBeaconProxy(notABeacon, 'TestBoxV1', [owner.address, 1n]);
    } catch (e) {
      error = e;
    }
    expect(error, 'expected a non-beacon target to be rejected').to.not.equal(null);
    expect(error.message.toLowerCase()).to.contain(notABeacon.toLowerCase());
    expect(error.message).to.match(/beacon/i);
    // pre-chain: nothing was deployed or recorded
    expect((await readManifest()).proxies.length).to.equal(proxiesBefore);
  });

  it('upgradeBeacon rejects a non-beacon target with a precise error', async () => {
    const notABeacon: string = await upgrades.deployImplementation('TestBoxV1');

    let error: any = null;
    try {
      await upgrades.upgradeBeacon(notABeacon, 'TestBoxV2');
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
    expect(error.message.toLowerCase()).to.contain(notABeacon.toLowerCase());
    expect(error.message).to.match(/beacon/i);
  });

  it('deployBeaconProxy rejects a non-beacon kind early', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');

    let error: any = null;
    try {
      await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 1n], {
        kind: 'transparent',
      } as any);
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
    expect(error.message).to.match(/kind|beacon/i);
  });

  it('accepts a valid beacon — preflight leaves the happy path unchanged', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    const a = await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 7n]);
    expect(await a.value()).to.equal(7n);
    await upgrades.upgradeBeacon(beacon, 'TestBoxV2'); // must not throw
  });
});
