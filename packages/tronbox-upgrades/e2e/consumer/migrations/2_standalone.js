const {
  validateImplementation,
  validateUpgrade,
  deployImplementation,
  prepareUpgrade,
} = require('@openzeppelin/tronbox-upgrades');

const Box = artifacts.require('Box');
const BoxV2 = artifacts.require('BoxV2');
const BoxV3 = artifacts.require('BoxV3');

module.exports = async function (deployer) {
  const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };

  await validateImplementation(BoxV3, handles);
  await validateUpgrade(BoxV2, BoxV3, handles);

  // The artifact's own per-network entry names the proxy after deployProxy
  // ran — the same write-back the replay recognition reads.
  const proxy = Box.address;
  console.log('E2E m2.proxyFromArtifact=' + proxy);

  const prepared = await prepareUpgrade(proxy, BoxV3, handles);
  console.log('E2E m2.prepared=' + prepared.address);
  console.log('E2E m2.preparedTx=' + prepared.transaction.hash);

  // Already recorded (the upgrade deployed it): must reuse, not redeploy.
  const impl = await deployImplementation(BoxV2, handles);
  console.log('E2E m2.impl=' + impl.address);
};
