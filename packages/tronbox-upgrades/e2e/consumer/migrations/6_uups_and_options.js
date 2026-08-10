const { deployProxy, upgradeProxy } = require('@openzeppelin/tronbox-upgrades');

const BoxUUPS = artifacts.require('BoxUUPS');
const BoxUUPSV2 = artifacts.require('BoxUUPSV2');
const BoxOptions = artifacts.require('BoxOptions');
const BoxOptionsV2 = artifacts.require('BoxOptionsV2');
const BoxOwned = artifacts.require('BoxOwned');
const BoxSolo = artifacts.require('BoxSolo');
// Written by the harness before the run; requiring it beats reading env vars
// inside the migration sandbox.
const params = require('../e2e-params.json');

async function readBig(call) {
  return BigInt((await call()).toString());
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

// The non-default option surface, exercised through the public API. The
// defaults path (migration 1) is exactly why a silently-dropped option was
// never caught before: every assertion here fails when an option is
// swallowed instead of honoured.
module.exports = async function (deployer) {
  const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };

  // kind: 'uups' — the proxy must be a TRC1967Proxy with NO admin: the
  // harness reads the proxy's 1967 admin slot from the node and requires it
  // empty. A dropped `kind` deploys transparent and fails that read.
  const uups = await deployProxy(BoxUUPS, [42], { ...handles, kind: 'uups' });
  console.log('E2E m6.uupsProxy=' + uups.address);

  // kind OMITTED on purpose: the plugin must hand the engine no own `kind`
  // key so the kind is inferred from the deployment ('uups'), and the
  // upgrade must route through the proxy itself — a transparent-path
  // attempt refuses, because this proxy has no admin to route through.
  const upgraded = await upgradeProxy(uups.address, BoxUUPSV2, handles);
  console.log('E2E m6.uupsImpl=' + upgraded.implementation);

  // The new code must be live through the same address: increment() exists
  // only on the upgraded implementation.
  const uupsBox = upgraded.contract;
  const uupsBefore = await readBig(() => uupsBox.value());
  if (uupsBefore < 42n) {
    throw new Error('e2e: uups initializer value lost: ' + uupsBefore);
  }
  await uupsBox.increment();
  const uupsAfter = await pollUntil(
    () => readBig(() => uupsBox.value()),
    uupsBefore + 1n,
    'uups value()',
  );
  console.log('E2E m6.uupsValueAfter=' + uupsAfter);

  // call: { fn, args } — the post-upgrade call must land through the
  // upgrade dispatch itself: store() exists only on the new implementation,
  // and retrieve() must answer 99 afterwards. On replay the upgrade is an
  // already-current no-op that sends no call, and 99 must still hold.
  const opts = await deployProxy(BoxOptions, [7], handles);
  console.log('E2E m6.callProxy=' + opts.address);
  await upgradeProxy(opts.address, BoxOptionsV2, {
    ...handles,
    call: { fn: 'store', args: [99] },
  });
  const optsBox = await BoxOptionsV2.at(opts.address);
  const stored = await pollUntil(
    () => readBig(() => optsBox.retrieve()),
    99n,
    'retrieve()',
  );
  console.log('E2E m6.callValue=' + stored);

  // initialOwner — the transparent proxy's admin must be owned by exactly
  // this address on-chain, not by the deploying account. The harness walks
  // the 1967 admin slot to the ProxyAdmin and asks owner() itself.
  const owned = await deployProxy(BoxOwned, [5], {
    ...handles,
    initialOwner: params.newOwner,
  });
  console.log('E2E m6.ownedProxy=' + owned.address);
  console.log('E2E m6.ownedOwner=' + params.newOwner);

  // initializer: false is refused BY NAME before any spend: the ported
  // proxies reject empty initialization data. BoxSolo never deploys, so the
  // refusal replays identically on every run.
  let refusal = null;
  try {
    await deployProxy(BoxSolo, [], { ...handles, initializer: false });
  } catch (error) {
    refusal = error;
  }
  if (!refusal || refusal.code !== 'initializer-data-required') {
    throw new Error(
      'e2e: initializer:false was not refused by name; saw: ' +
        (refusal ? `${refusal.code}: ${refusal.message}` : 'a successful deploy'),
    );
  }
  console.log('E2E m6.refusalCode=' + refusal.code);
};
