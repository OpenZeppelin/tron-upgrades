'use strict';

const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { readManifest, writeManifest, implEntry } = require('./_manifest-helper');

describe('implementation reuse', function () {
  this.timeout(240_000);

  it('onchange reuses one implementation across two proxies', async () => {
    const [owner] = await ethers.getSigners();
    const opts = { constructorArgs: [101n] };
    const a = await upgrades.deployProxy('TestBoxWithCtor', [owner.address, 1n], opts);
    const b = await upgrades.deployProxy('TestBoxWithCtor', [owner.address, 2n], opts);
    const aImpl = await upgrades.erc1967.getImplementationAddress(a);
    const bImpl = await upgrades.erc1967.getImplementationAddress(b);

    expect(bImpl).to.equal(aImpl);
    expect(await a.value()).to.equal(1n);
    expect(await b.value()).to.equal(2n);
  });

  it('always deploys a fresh address and merges it into allAddresses', async () => {
    const first = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [102n] });
    const second = await upgrades.deployImplementation('TestBoxWithCtor', {
      constructorArgs: [102n],
      redeployImplementation: 'always',
    });
    expect(second.toLowerCase()).to.not.equal(first.toLowerCase());
    const manifest = await readManifest();
    expect(implEntry(manifest, first)).to.equal(implEntry(manifest, second));
  });

  it('never rejects when the requested version has not been deployed', async () => {
    await expect(
      upgrades.deployImplementation('TestBoxWithCtor', {
        constructorArgs: [103n],
        redeployImplementation: 'never',
      }),
    ).to.be.rejectedWith(/not previously deployed|not deployed/i);
  });

  it('onchange replaces a stale no-code manifest entry', async () => {
    const original = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [104n] });
    const manifest = await readManifest();
    const entry = implEntry(manifest, original);
    entry.address = ethers.Wallet.createRandom().address;
    delete entry.allAddresses;
    delete entry.txHash;
    await writeManifest(manifest);

    const replacement = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [104n] });
    expect(replacement.toLowerCase()).to.not.equal(entry.address.toLowerCase());
    expect(implEntry(await readManifest(), replacement)).to.not.equal(undefined);
  });

  it('same constructor arguments produce the same reusable version key', async () => {
    const first = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [105n] });
    const second = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [105n] });
    expect(second).to.equal(first);
  });

  it('different constructor arguments produce different version keys and deployments', async () => {
    const first = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [106n] });
    const second = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [107n] });
    expect(second.toLowerCase()).to.not.equal(first.toLowerCase());
    expect(implEntry(await readManifest(), first)).to.not.equal(implEntry(await readManifest(), second));
  });
});
