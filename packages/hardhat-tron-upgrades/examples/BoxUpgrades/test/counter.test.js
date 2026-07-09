const { expect } = require('chai');
const { ethers } = require('hardhat');

// Runs against a real TRON node (TRE in Docker) — the plugin boots and tears
// down the container around `hardhat test`.
describe('Counter on TVM', () => {
  it('deploys and increments', async () => {
    const counter = await ethers.deployContract('Counter');
    await counter.increment();
    expect(await counter.value()).to.equal(1n);
  });

  it('emits events (TVM-aware chai matchers)', async () => {
    const counter = await ethers.deployContract('Counter');
    await expect(counter.increment()).to.emit(counter, 'Incremented').withArgs(1n);
  });
});
