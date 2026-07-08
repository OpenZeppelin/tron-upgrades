'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const { ethers, upgrades, network, config } = require('hardhat');

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

async function getSlot(address, slot) {
  try {
    return await ethers.provider.getStorage(address, slot);
  } catch (_) {
    const url = process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getStorageAt',
        params: [address, slot, 'latest'],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`eth_getStorageAt: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}

function slotAddress(slotValue) {
  return '0x' + slotValue.slice(-40).toLowerCase();
}

function manifestFile() {
  return path.join(config.paths.root, '.openzeppelin', `${network.name}.json`);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
}

describe('hre.upgrades API — uups kind', function () {
  this.timeout(240_000);

  it('deploys a uups proxy: calls forwarded, slot set, manifest records kind', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('BoxUUPSV1', [owner.address, 42n], { kind: 'uups' });
    const boxAddress = await box.getAddress();

    expect(await box.value()).to.equal(42n);
    expect(await box.version()).to.equal('v1');

    const implAddress = slotAddress(await getSlot(boxAddress, IMPL_SLOT));
    expect(implAddress).to.not.equal('0x' + '0'.repeat(40));

    const record = readManifest().proxies[boxAddress.toLowerCase()];
    expect(record.kind).to.equal('uups');
    expect(record.contract).to.equal('BoxUUPSV1');
    expect(record.implementation.toLowerCase()).to.equal(ethers.getAddress(implAddress).toLowerCase());
  });

  it('upgrades V1 → V2 through the implementation-borne upgrade function', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('BoxUUPSV1', [owner.address, 42n], { kind: 'uups' });
    const boxAddress = await box.getAddress();

    const boxV2 = await upgrades.upgradeProxy(box, 'BoxUUPSV2');
    expect(await boxV2.getAddress()).to.equal(boxAddress); // same address
    expect(await boxV2.value()).to.equal(42n); // state preserved
    expect(await boxV2.version()).to.equal('v2'); // new logic live
    await boxV2.increment();
    expect(await boxV2.value()).to.equal(43n);
    expect(await boxV2.incrementCount()).to.equal(1n);

    const record = readManifest().proxies[boxAddress.toLowerCase()];
    expect(record.kind).to.equal('uups');
    expect(record.contract).to.equal('BoxUUPSV2');
  });

  it('anti-brick: refuses an upgrade to an implementation without the upgrade function', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('BoxUUPSV1', [owner.address, 7n], { kind: 'uups' });
    const boxAddress = await box.getAddress();
    const slotBefore = await getSlot(boxAddress, IMPL_SLOT);

    let error = null;
    try {
      await upgrades.upgradeProxy(box, 'BoxUUPSV2NoButton');
    } catch (e) {
      error = e;
    }
    expect(error, 'expected the upgrade to be rejected').to.not.equal(null);
    expect(error.message).to.match(/upgradeTo/i); // names the missing mechanism

    // proxy untouched: logic, state, slot and manifest all unchanged
    expect(await box.version()).to.equal('v1');
    expect(await box.value()).to.equal(7n);
    expect(await getSlot(boxAddress, IMPL_SLOT)).to.equal(slotBefore);
    expect(readManifest().proxies[boxAddress.toLowerCase()].contract).to.equal('BoxUUPSV1');
  });

  it('kind-aware validation: refuses to deploy a buttonless implementation as uups', async () => {
    const [owner] = await ethers.getSigners();
    let error = null;
    try {
      await upgrades.deployProxy('BoxV1', [owner.address, 1n], { kind: 'uups' });
    } catch (e) {
      error = e;
    }
    expect(error, 'expected deployProxy to reject').to.not.equal(null);
    expect(error.message).to.match(/upgradeTo/i);
  });

  it('wrong signer: on-chain authorization rejects a non-owner upgrade', async () => {
    const [owner, stranger] = await ethers.getSigners();
    const box = await upgrades.deployProxy('BoxUUPSV1', [owner.address, 9n], { kind: 'uups' });
    const boxAddress = await box.getAddress();
    const slotBefore = await getSlot(boxAddress, IMPL_SLOT);

    let error = null;
    try {
      await upgrades.upgradeProxy(box, 'BoxUUPSV2', { owner: stranger });
    } catch (e) {
      error = e;
    }
    expect(error, 'expected the unauthorized upgrade to fail').to.not.equal(null);

    expect(await box.version()).to.equal('v1');
    expect(await getSlot(boxAddress, IMPL_SLOT)).to.equal(slotBefore);
  });

  it('recordless upgrade works with explicit {from, kind}; without kind it fails clearly', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('BoxUUPSV1', [owner.address, 5n], { kind: 'uups' });
    const boxAddress = await box.getAddress();

    // simulate a lost record
    const manifest = readManifest();
    delete manifest.proxies[boxAddress.toLowerCase()];
    fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 2) + '\n');

    // without kind: defaults to transparent, which must fail loudly (no admin)
    let error = null;
    try {
      await upgrades.upgradeProxy(box, 'BoxUUPSV2', { from: 'BoxUUPSV1' });
    } catch (e) {
      error = e;
    }
    expect(error, 'expected the transparent-path fallback to fail').to.not.equal(null);
    expect(error.message).to.match(/admin|transparent/i);

    // with explicit kind: takes the uups path and succeeds
    const boxV2 = await upgrades.upgradeProxy(box, 'BoxUUPSV2', { from: 'BoxUUPSV1', kind: 'uups' });
    expect(await boxV2.version()).to.equal('v2');
    expect(await boxV2.value()).to.equal(5n);
  });
});
