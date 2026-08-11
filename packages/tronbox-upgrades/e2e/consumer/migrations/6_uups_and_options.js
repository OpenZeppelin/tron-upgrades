const {
  deployProxy,
  upgradeProxy,
  validateImplementation,
  erc1967,
  silenceWarnings,
} = require('@openzeppelin/tronbox-upgrades');

const BoxUUPS = artifacts.require('BoxUUPS');
const BoxUUPSV2 = artifacts.require('BoxUUPSV2');
const BoxUUPSAuto = artifacts.require('BoxUUPSAuto');
const BoxZeroInit = artifacts.require('BoxZeroInit');
const BoxOptions = artifacts.require('BoxOptions');
const BoxOptionsV2 = artifacts.require('BoxOptionsV2');
const BoxOwned = artifacts.require('BoxOwned');
const BoxSolo = artifacts.require('BoxSolo');
const BoxLinked = artifacts.require('BoxLinked');
const BoxNever = artifacts.require('BoxNever');
// Written by the harness before the run; requiring it beats reading env vars
// inside the migration sandbox.
const params = require('../e2e-params.json');

async function readBig(call) {
  return BigInt((await call()).toString());
}

function assertBase58(address, what) {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error(`e2e: ${what} is not a canonical base58 TRON address: ${address}`);
  }
}

function sameAddress(left, right) {
  return (
    tronWrap.address.toHex(left).toLowerCase() ===
    tronWrap.address.toHex(right).toLowerCase()
  );
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

  const readerImplementation = await erc1967.getImplementationAddress(
    uups.address,
    handles,
  );
  const readerAdmin = await erc1967.getAdminAddress(uups.address, handles);
  assertBase58(readerImplementation, 'uups implementation reader result');
  assertBase58(readerAdmin, 'uups admin reader result');
  if (!sameAddress(readerImplementation, upgraded.implementation)) {
    throw new Error(
      `e2e: uups implementation reader returned ${readerImplementation}, ` +
        `expected ${upgraded.implementation}`,
    );
  }
  const zeroAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
  if (readerAdmin !== zeroAddress) {
    throw new Error(
      `e2e: uups admin reader returned ${readerAdmin}, expected ${zeroAddress}`,
    );
  }
  console.log('E2E m6.readerImpl=' + readerImplementation);
  console.log('E2E m6.readerAdmin=' + readerAdmin);

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

  // kind OMITTED on the DEPLOY of a UUPS-shaped implementation: deployProxy
  // must INFER uups from the public upgrade entry point — the harness reads
  // this proxy's 1967 admin slot from the node and requires it EMPTY, which
  // a kind defaulted to transparent fails. A separate contract so the
  // scenario owns its replay memory.
  const auto = await deployProxy(BoxUUPSAuto, [42], handles);
  console.log('E2E m6.autoProxy=' + auto.address);
  const autoValue = await readBig(() => auto.contract.value());
  // Exactly the initializer's value, first run and replay both: nothing
  // increments this proxy, and `deployProxy` initializes a fresh proxy with
  // the same [42] every run, so it answers the same 42 either way.
  if (autoValue !== 42n) {
    throw new Error('e2e: inferred-kind initializer value wrong: ' + autoValue);
  }
  console.log('E2E m6.autoValue=' + autoValue);

  // initialOwner with kind:'uups' is refused BY NAME before anything spends:
  // a UUPS proxy has no admin for the option to configure. The refusal is
  // deterministic — it fires ahead of the corrupt-record refusal — so it
  // replays identically regardless of what BoxUUPSAuto's own recorded proxy
  // (above) has to say.
  let ownerRefusal = null;
  try {
    await deployProxy(BoxUUPSAuto, [42], {
      ...handles,
      kind: 'uups',
      initialOwner: params.newOwner,
    });
  } catch (error) {
    ownerRefusal = error;
  }
  if (!ownerRefusal || ownerRefusal.code !== 'initial-owner-unsupported-kind') {
    throw new Error(
      'e2e: initialOwner with uups was not refused by name; saw: ' +
        (ownerRefusal
          ? `${ownerRefusal.code}: ${ownerRefusal.message}`
          : 'a successful deploy'),
    );
  }
  console.log('E2E m6.ownerRefusalCode=' + ownerRefusal.code);

  // initializer OMITTED with zero args: the TRY-FIRST rule must find the
  // zero-argument initialize() in the ABI and deploy INITIALIZED — the value
  // below is the initializer's own constant, asserted exactly.
  const zero = await deployProxy(BoxZeroInit, [], handles);
  console.log('E2E m6.zeroProxy=' + zero.address);
  const zeroValue = await readBig(() => zero.contract.value());
  if (zeroValue !== 7n) {
    throw new Error('e2e: zero-arg initialize() did not run: ' + zeroValue);
  }
  console.log('E2E m6.zeroValue=' + zeroValue);

  // call: { fn, args } — the post-upgrade call must land through the
  // upgrade dispatch itself: store() exists only on the new implementation,
  // and retrieve() must answer 99 afterwards. `opts` is a fresh proxy every
  // run (deployProxy never reuses one): the same upgrade-with-call runs again
  // from scratch, and 99 must still hold because the call executed again.
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
  if (!refusal || refusal.code !== 'empty-initializer-refused') {
    throw new Error(
      'e2e: initializer:false was not refused by name; saw: ' +
        (refusal ? `${refusal.code}: ${refusal.message}` : 'a successful deploy'),
    );
  }
  console.log('E2E m6.refusalCode=' + refusal.code);

  // The candidate differs from the implementation currently behind `opts`
  // and has no recorded deployment. The reuse-only policy must therefore
  // refuse before it can deploy an implementation or send an upgrade.
  let neverRefusal = null;
  try {
    await upgradeProxy(opts.address, BoxNever, {
      ...handles,
      redeployImplementation: 'never',
    });
  } catch (error) {
    neverRefusal = error;
  }
  if (
    !neverRefusal ||
    neverRefusal.code !== 'implementation-not-previously-deployed'
  ) {
    throw new Error(
      "e2e: redeployImplementation:'never' was not refused by name; saw: " +
        (neverRefusal
          ? `${neverRefusal.code}: ${neverRefusal.message}`
          : 'a successful upgrade'),
    );
  }
  console.log('E2E m6.never.refusalCode=' + neverRefusal.code);

  // This contract carries a genuine external-library link reference. The
  // engine must reject it first, then accept the same artifact only under the
  // one explicit allowance. Silencing suppresses that allowance's advisory
  // write while the returned notes prove the warning was still recorded.
  let linkedRefusal = null;
  try {
    await validateImplementation(BoxLinked, { artifacts });
  } catch (error) {
    linkedRefusal = error;
  }
  if (
    !linkedRefusal ||
    !/external libraries/i.test(String(linkedRefusal.message)) ||
    !/LinkedMath/.test(String(linkedRefusal.message))
  ) {
    throw new Error(
      'e2e: linked implementation did not receive the engine verdict; saw: ' +
        (linkedRefusal ? linkedRefusal.message : 'successful validation'),
    );
  }
  silenceWarnings();
  const linkedAccepted = await validateImplementation(BoxLinked, {
    artifacts,
    unsafeAllow: ['external-library-linking'],
  });
  const linkedAllowanceNotes = linkedAccepted.notes.filter(note =>
    [note.summary, ...note.detail].some(line =>
      /unsafeAllow\.external-library-linking/.test(line),
    ),
  );
  if (linkedAllowanceNotes.length === 0) {
    throw new Error(
      'e2e: linked implementation acceptance recorded no allowance warning',
    );
  }
  console.log('E2E m6.linked.refused=true');
  console.log('E2E m6.linked.accepted=true');
  console.log('E2E m6.linked.noteCount=' + linkedAllowanceNotes.length);
};
