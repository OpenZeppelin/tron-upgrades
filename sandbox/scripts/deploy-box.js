'use strict';

// Example deployment script — the way an end user will actually run the
// plugin (vs. the test suite):
//
//   npx hardhat run scripts/deploy-box.js --network tre
//
// Expects a reachable TRON node on the configured network (`hardhat run`
// does not auto-start TRE; `hardhat test` and `hardhat node` do).

const { ethers, upgrades, network } = require('hardhat');

async function main() {
  const [owner] = await ethers.getSigners();
  console.log(`network : ${network.name}`);
  console.log(`deployer: ${owner.address}`);

  const box = await upgrades.deployProxy('BoxV1', [owner.address, 42n]);
  console.log(`proxy   : ${await box.getAddress()}`);
  console.log(`value   : ${await box.value()}  version: ${await box.version()}`);

  const boxV2 = await upgrades.upgradeProxy(box, 'BoxV2');
  console.log(`upgraded: value ${await boxV2.value()}  version: ${await boxV2.version()}`);

  await boxV2.increment();
  console.log(`incr    : value ${await boxV2.value()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
