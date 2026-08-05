const { deployProxy, upgradeProxy } = require('@openzeppelin/tronbox-upgrades');

const Box = artifacts.require('Box');
const BoxV2 = artifacts.require('BoxV2');

async function readValue(box) {
  return BigInt((await box.value()).toString());
}

// A sent transaction lands on the chain's next block; poll instead of
// trusting the first read after a state-changing instance call.
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

  const deployed = await deployProxy(Box, [42], handles);
  console.log('E2E m1.proxy=' + deployed.address);
  console.log('E2E m1.deployTx=' + deployed.transaction.hash);

  const upgraded = await upgradeProxy(deployed.address, BoxV2, handles);
  console.log('E2E m1.impl=' + upgraded.implementation);
  console.log('E2E m1.upgradeTx=' + upgraded.transaction.hash);
  if (upgraded.address !== deployed.address && upgraded.address.toLowerCase() !== deployed.address.toLowerCase()) {
    // Addresses are tool-verbatim on one result and canonical on the other;
    // only an outright different account is a failure here.
    const bare = s => s.replace(/^(0x|41)/i, '').toLowerCase();
    if (bare(upgraded.address) !== bare(deployed.address)) {
      throw new Error('e2e: upgrade answered a different proxy than the deploy');
    }
  }

  // The new code must be LIVE through the SAME address: increment() exists
  // only on the upgraded implementation.
  const box = upgraded.contract;
  const before = await readValue(box);
  if (before < 42n) throw new Error('e2e: initializer value lost: ' + before);
  await box.increment();
  const after = await pollUntil(() => readValue(box), before + 1n, 'value()');
  console.log('E2E m1.valueBefore=' + before);
  console.log('E2E m1.valueAfter=' + after);
};
