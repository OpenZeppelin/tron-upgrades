'use strict';

const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { readManifest, proxyRecord, implEntry } = require('./_manifest-helper');

describe('hre.upgrades API (plugin)', function () {
  this.timeout(240_000);

  it('deployProxy → use → upgradeProxy, in plugin API calls', async () => {
    const [owner] = await ethers.getSigners();

    // one call: validate + deploy impl + deploy proxy + initialize + record
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 42n]);
    const boxAddress = await box.getAddress();
    expect(await box.value()).to.equal(42n);
    expect(await box.version()).to.equal('v1');

    // the proxy is recorded with its kind, and the implementation actually
    // installed on-chain is registered WITH its storage layout
    const implV1 = await upgrades.erc1967.getImplementationAddress(box);
    const manifest = await readManifest();
    expect(proxyRecord(manifest, boxAddress).kind).to.equal('transparent');
    const entryV1 = implEntry(manifest, implV1);
    expect(entryV1, 'installed implementation must be registered').to.not.equal(undefined);
    expect(entryV1.layout).to.have.property('storage');

    // one call: read current impl from chain + validate against ITS stored
    // layout + deploy v2 + re-point + verify slot
    const boxV2 = await upgrades.upgradeProxy(box, 'TestBoxV2');
    expect(await boxV2.getAddress()).to.equal(boxAddress); // same address
    expect(await boxV2.value()).to.equal(42n); // state preserved
    expect(await boxV2.version()).to.equal('v2'); // new logic live
    await boxV2.increment();
    expect(await boxV2.value()).to.equal(43n);

    // manifest followed the upgrade: the NEW on-chain implementation is
    // registered too (with its own layout, under its own version key)
    const implV2 = await upgrades.erc1967.getImplementationAddress(box);
    const updated = await readManifest();
    expect(implV2.toLowerCase()).to.not.equal(implV1.toLowerCase());
    expect(implEntry(updated, implV2), 'v2 implementation must be registered').to.not.equal(
      undefined,
    );
    expect(implEntry(updated, implV1), 'v1 entry is kept, not overwritten').to.not.equal(
      undefined,
    );
  });

  it('refuses an unsafe upgrade BEFORE touching the chain', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 7n]);

    let error = null;
    try {
      await upgrades.upgradeProxy(box, 'TestBoxV2StorageConflict');
    } catch (e) {
      error = e;
    }
    expect(error, 'expected upgradeProxy to reject the incompatible layout').to.not.equal(null);
    expect(error.message).to.match(/incompatible/i);

    // the proxy is untouched: still v1, still holding its state
    expect(await box.version()).to.equal('v1');
    expect(await box.value()).to.equal(7n);
  });

  it('validateUpgrade is exposed standalone (CI use)', async () => {
    await upgrades.validateUpgrade('TestBoxV1', 'TestBoxV2'); // must not throw

    let error = null;
    try {
      await upgrades.validateUpgrade('TestBoxV1', 'TestBoxV2StorageConflict');
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
  });
});
