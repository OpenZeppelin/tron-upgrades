const {
  deployBeacon,
  deployBeaconProxy,
  upgradeBeacon,
} = require('@openzeppelin/tronbox-upgrades');

const Box = artifacts.require('Box');
const BoxV2 = artifacts.require('BoxV2');

async function readValue(box) {
  return BigInt((await box.value()).toString());
}

async function pollUntil(read, expected, what) {
  for (let trial = 0; trial < 30; trial += 1) {
    const seen = await read();
    if (seen === expected) return seen;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`e2e: ${what} never reached ${expected}`);
}

module.exports = async function (deployer) {
  const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };

  const beacon = await deployBeacon(Box, handles);
  console.log('E2E m4.beacon=' + beacon.address);
  console.log('E2E m4.beaconImpl=' + beacon.implementation);
  if (!beacon.implementation) {
    throw new Error('e2e: beacon result carries no implementation address');
  }
  if (!beacon.contract) {
    throw new Error('e2e: beacon result carries no contract handle');
  }

  const proxy = await deployBeaconProxy(beacon.address, Box, [7], handles);
  console.log('E2E m4.beaconProxy=' + proxy.address);

  const upgradedBeacon = await upgradeBeacon(beacon.address, BoxV2, handles);
  console.log('E2E m4.upgradedImpl=' + upgradedBeacon.implementation);

  // Every proxy pointing at the beacon follows: the beacon proxy must now run
  // the upgraded code, with its own storage intact.
  const box = await BoxV2.at(proxy.address);
  const before = await readValue(box);
  if (before !== 7n) throw new Error('e2e: beacon proxy initializer value lost: ' + before);
  await box.increment();
  const after = await pollUntil(() => readValue(box), 8n, 'beacon proxy value()');
  console.log('E2E m4.valueBefore=' + before);
  console.log('E2E m4.valueAfter=' + after);
};
