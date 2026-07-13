'use strict';

const { expect } = require('chai');
const { ethers } = require('hardhat');

// TVM computes CREATE2 addresses with a 0x41 prefix (TIP-26), not 0xff.
function computeCreate2(prefix, deployer, salt, initCodeHash) {
  const packed = ethers.concat([prefix, deployer, salt, initCodeHash]);
  return '0x' + ethers.keccak256(packed).slice(-40);
}

// EIP-1167 minimal-proxy init code for a given implementation.
function cloneInitCode(implementation) {
  return ethers.concat([
    '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
    implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
  ]);
}

describe('Deterministic clone address prediction on TVM', function () {
  this.timeout(240_000);

  it('library prediction == 0x41 off-chain computation == actual deployment', async () => {
    const impl = await ethers.deployContract('TestBoxV1');
    const factory = await ethers.deployContract('CloneFactory');
    const implAddr = (await impl.getAddress()).toLowerCase();
    const factoryAddr = (await factory.getAddress()).toLowerCase();
    const salt = ethers.id('deterministic-clone-1');

    // on-chain prediction from the ported Clones library
    const predicted = (await factory.predict(implAddr, salt)).toLowerCase();

    // off-chain computation with the TVM (0x41) prefix
    const initCodeHash = ethers.keccak256(cloneInitCode(implAddr));
    const computedTvm = computeCreate2('0x41', factoryAddr, salt, initCodeHash);
    expect(predicted).to.equal(computedTvm);

    // negative control: the EVM (0xff) formula must give a DIFFERENT address
    const computedEvm = computeCreate2('0xff', factoryAddr, salt, initCodeHash);
    expect(predicted).to.not.equal(computedEvm);

    // the clone actually lands on the predicted address and runs
    const tx = await factory.deployClone(implAddr, salt);
    await expect(tx).to.emit(factory, 'CloneDeployed').withArgs(ethers.getAddress(predicted));
    const cloneBox = await ethers.getContractAt('TestBoxV1', ethers.getAddress(predicted));
    expect(await cloneBox.version()).to.equal('v1');
  });
});
