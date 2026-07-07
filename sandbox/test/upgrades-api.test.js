'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const { ethers, upgrades, network, config } = require('hardhat');

describe('hre.upgrades API (plugin)', function () {
  this.timeout(240_000);

  function manifestFile() {
    return path.join(config.paths.root, '.openzeppelin', `${network.name}.json`);
  }

  it('deployProxy → use → upgradeProxy, in plugin API calls', async () => {
    const [owner] = await ethers.getSigners();

    // one call: validate + deploy impl + deploy proxy + initialize + record
    const box = await upgrades.deployProxy('BoxV1', [owner.address, 42n]);
    const boxAddress = await box.getAddress();
    expect(await box.value()).to.equal(42n);
    expect(await box.version()).to.equal('v1');

    // the deployment record exists and knows what backs the proxy
    const manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    expect(manifest.proxies[boxAddress.toLowerCase()].contract).to.equal('BoxV1');

    // one call: validate compatibility + deploy v2 + re-point + verify slot
    const boxV2 = await upgrades.upgradeProxy(box, 'BoxV2');
    expect(await boxV2.getAddress()).to.equal(boxAddress); // same address
    expect(await boxV2.value()).to.equal(42n); // state preserved
    expect(await boxV2.version()).to.equal('v2'); // new logic live
    await boxV2.increment();
    expect(await boxV2.value()).to.equal(43n);

    // manifest followed the upgrade
    const updated = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    expect(updated.proxies[boxAddress.toLowerCase()].contract).to.equal('BoxV2');
  });

  it('refuses an unsafe upgrade BEFORE touching the chain', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('BoxV1', [owner.address, 7n]);

    let error = null;
    try {
      await upgrades.upgradeProxy(box, 'BoxV2Broken');
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
    await upgrades.validateUpgrade('BoxV1', 'BoxV2'); // must not throw

    let error = null;
    try {
      await upgrades.validateUpgrade('BoxV1', 'BoxV2Broken');
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
  });
});
