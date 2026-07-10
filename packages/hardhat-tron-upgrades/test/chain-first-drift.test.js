'use strict';

// The central safety claims of chain-first validation, tested EXPLICITLY:
//   - an implementation installed outside the plugin is a hard stop
//     (transparent, uups, and beacon variants), and
//   - two deployments of the same version merge into one manifest entry
//     that keeps BOTH proxies upgradeable (primary address + allAddresses).
// Plus the UUPS interface dispatch: a current implementation exposing only
// the v4 upgradeTo(address) entry point must still be upgradeable.

const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { readManifest, implEntry } = require('./_manifest-helper');

const ADMIN_FQN =
  'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin';

describe('chain-first validation — drift hard stops and merge semantics', function () {
  this.timeout(240_000);

  it('T6: same-version double deploy merges; BOTH proxies upgrade afterwards', async () => {
    const [owner] = await ethers.getSigners();
    const p1 = await upgrades.deployProxy('TestBoxV1', [owner.address, 1n]);
    const p2 = await upgrades.deployProxy('TestBoxV1', [owner.address, 2n]);
    const i1 = await upgrades.erc1967.getImplementationAddress(p1);
    const i2 = await upgrades.erc1967.getImplementationAddress(p2);
    expect(i1.toLowerCase()).to.not.equal(i2.toLowerCase()); // two real deploys (reuse comes later)

    // ONE merged entry covers both addresses — a naive overwrite would have
    // lost i1 and stranded p1 behind a false "not registered" stop
    const manifest = await readManifest();
    const e1 = implEntry(manifest, i1);
    const e2 = implEntry(manifest, i2);
    expect(e1, 'first deployment must stay registered').to.not.equal(undefined);
    expect(e1).to.equal(e2); // same entry, merged
    const covered = [e1.address, ...(e1.allAddresses ?? [])].map((a) => a.toLowerCase());
    expect(covered).to.include(i1.toLowerCase());
    expect(covered).to.include(i2.toLowerCase());

    // both proxies find their layout baseline by address and upgrade
    const p1v2 = await upgrades.upgradeProxy(p1, 'TestBoxV2');
    const p2v2 = await upgrades.upgradeProxy(p2, 'TestBoxV2');
    expect(await p1v2.version()).to.equal('v2');
    expect(await p2v2.version()).to.equal('v2');
    expect(await p1v2.value()).to.equal(1n); // per-proxy state intact
    expect(await p2v2.value()).to.equal(2n);
  });

  it('T1: transparent proxy upgraded outside the plugin → hard stop, no transaction', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 7n]);
    const boxAddress = await box.getAddress();

    // out-of-band: raw-deploy an implementation and re-point via the ProxyAdmin
    const rogue = await ethers.deployContract('TestBoxV2');
    const adminAddress = await upgrades.erc1967.getAdminAddress(box);
    const admin = await ethers.getContractAt(ADMIN_FQN, adminAddress);
    await admin.upgradeAndCall(boxAddress, await rogue.getAddress(), '0x');
    expect(await box.version()).to.equal('v2'); // the drift is real

    let error = null;
    try {
      await upgrades.upgradeProxy(box, 'TestBoxV2');
    } catch (e) {
      error = e;
    }
    expect(error, 'chain-first must refuse an unknown implementation').to.not.equal(null);
    expect(error.message).to.match(/is not registered/i);
    expect(await box.version()).to.equal('v2'); // nothing else changed
  });

  it('T2: uups proxy upgraded outside the plugin → hard stop', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 3n], { kind: 'uups' });

    // out-of-band: press the current implementation's button directly
    const rogue = await ethers.deployContract('TestBoxUUPSV2');
    await box.upgradeToAndCall(await rogue.getAddress(), '0x');
    expect(await box.version()).to.equal('v2');

    let error = null;
    try {
      await upgrades.upgradeProxy(box, 'TestBoxUUPSV2');
    } catch (e) {
      error = e;
    }
    expect(error, 'chain-first must refuse an unknown implementation').to.not.equal(null);
    expect(error.message).to.match(/is not registered/i);
  });

  it('T3: beacon re-pointed outside the plugin → hard stop', async () => {
    const [owner] = await ethers.getSigners();
    const beacon = await upgrades.deployBeacon('TestBoxV1');
    await upgrades.deployBeaconProxy(beacon, 'TestBoxV1', [owner.address, 4n]);

    const rogue = await ethers.deployContract('TestBoxV2');
    await beacon.upgradeTo(await rogue.getAddress());
    expect((await upgrades.beacon.getImplementationAddress(beacon)).toLowerCase()).to.equal(
      (await rogue.getAddress()).toLowerCase(),
    );

    let error = null;
    try {
      await upgrades.upgradeBeacon(beacon, 'TestBoxV2');
    } catch (e) {
      error = e;
    }
    expect(error, 'chain-first must refuse an unknown implementation').to.not.equal(null);
    expect(error.message).to.match(/is not registered/i);
  });

  it('uups v4 dispatch: upgrades through a current implementation with only upgradeTo', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 6n], { kind: 'uups' });

    // v5 dispatch installs the legacy implementation (V1 reports 5.0.0)
    const legacy = await upgrades.upgradeProxy(box, 'TestBoxUUPSLegacyUpgradeTo');
    expect(await legacy.version()).to.equal('legacy');

    // now the CURRENT implementation exposes only upgradeTo(address) and no
    // UPGRADE_INTERFACE_VERSION — the plugin must take the v4 path
    const boxV2 = await upgrades.upgradeProxy(box, 'TestBoxUUPSV2');
    expect(await boxV2.version()).to.equal('v2');
    expect(await boxV2.value()).to.equal(6n); // state survived both hops
  });
});
