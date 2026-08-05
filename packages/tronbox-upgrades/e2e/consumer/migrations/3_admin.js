const { transferProxyAdminOwnership } = require('@openzeppelin/tronbox-upgrades');

const Box = artifacts.require('Box');
// Written by the harness before the run; requiring it beats reading env vars
// inside the migration sandbox.
const params = require('../e2e-params.json');

module.exports = async function (deployer) {
  const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };

  const outcome = await transferProxyAdminOwnership(
    Box.address,
    params.newOwner,
    handles,
  );
  console.log('E2E m3.alreadyHeld=' + outcome.alreadyHeld);
  console.log('E2E m3.previousOwner=' + outcome.previousOwner);
  console.log('E2E m3.newOwner=' + outcome.newOwner);
  if (outcome.alreadyHeld === false && !(outcome.transaction && outcome.transaction.hash)) {
    throw new Error('e2e: executed transfer carried no transaction identity');
  }
  if (outcome.alreadyHeld === true && outcome.transaction !== null) {
    throw new Error('e2e: declared no-op carried a transaction');
  }
};
