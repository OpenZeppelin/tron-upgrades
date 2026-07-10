'use strict';

// End-to-end exercise of the upgrades plugin against a PUBLIC testnet:
//
//   npx hardhat run scripts/testnet-e2e.js --network shasta   (or nile)
//
// Needs a funded account (see .testnet-key / TRON_TESTNET_KEY in the config).
// Faucets: https://shasta.tronex.io  or TronFAQBot on TRON's Telegram/Discord
// (!shasta <address>, up to 5000 TRX / 24h). Deploys burn energy bought with
// TRX, so ~2000+ TRX is recommended for the full run.

const { ethers, upgrades, network, tre } = require('hardhat');
const { TronWeb } = require('tronweb');

const SCAN = {
  shasta: 'https://shasta.tronscan.org/#',
  nile: 'https://nile.tronscan.org/#',
}[network.name];

// Tronscan resolves base58 addresses, not 0x hex.
function link(addr) {
  const base58 = TronWeb.address.fromHex('41' + addr.replace(/^0x/, ''));
  return SCAN ? `${SCAN}/contract/${base58}` : base58;
}

async function expectRejected(label, promise, pattern) {
  try {
    await promise;
    throw new Error(`${label}: expected rejection, but it went through`);
  } catch (e) {
    if (!pattern.test(e.message)) throw e;
    console.log(`  ✔ ${label} rejected off-chain as expected`);
  }
}

async function main() {
  // Deliberately NOT ethers.getSigners(): the bridge's signer setup relies
  // on a TRE-only cheatcode and fails on public networks. The deployer key
  // signs everything by default.
  const { tronWeb, address: base58 } = tre.makeTronWeb();
  const ownerAddress = ethers.getAddress('0x' + tronWeb.address.toHex(base58).slice(2));
  console.log(`network : ${network.name}`);
  console.log(`account : ${base58} (${ownerAddress})`);

  const balance = await tronWeb.trx.getBalance(base58);
  console.log(`balance : ${balance / 1e6} TRX`);
  if (balance < 500_000_000) {
    console.log('\n⚠ balance below 500 TRX — fund the account first:');
    console.log(`  address: ${base58}`);
    console.log('  faucet : https://shasta.tronex.io  (or TronFAQBot: !shasta <address>)');
    process.exit(1);
  }

  // -- transparent kind ------------------------------------------------
  console.log('\n[1/3] transparent proxy lifecycle');
  const t = await upgrades.deployProxy('BoxV1', [ownerAddress, 42n]);
  const tAddr = await t.getAddress();
  console.log(`  proxy   : ${link(tAddr)}`);
  console.log(`  value=${await t.value()} version=${await t.version()}`);

  const preparedV2 = await upgrades.prepareUpgrade(t, 'BoxV2');
  const t2 = await upgrades.upgradeProxy(t, 'BoxV2');
  if ((await upgrades.erc1967.getImplementationAddress(t2)).toLowerCase() !== preparedV2.toLowerCase()) {
    throw new Error('upgradeProxy did not reuse the prepared implementation');
  }
  await t2.increment();
  console.log(`  prepared + reused: ${link(preparedV2)}`);
  console.log(`  upgraded: value=${await t2.value()} version=${await t2.version()} ✔`);

  // -- uups kind ---------------------------------------------------------
  console.log('\n[2/3] uups proxy lifecycle');
  const u = await upgrades.deployProxy('BoxUUPSV1', [ownerAddress, 7n]);
  const uAddr = await u.getAddress();
  console.log(`  proxy   : ${link(uAddr)}`);
  console.log(`  value=${await u.value()} version=${await u.version()}`);

  const u2 = await upgrades.upgradeProxy(u, 'BoxUUPSV2');
  await u2.increment();
  console.log(`  upgraded: value=${await u2.value()} version=${await u2.version()} ✔`);

  // -- safety rails (off-chain, zero cost) -------------------------------
  console.log('\n[3/3] safety rails (no transactions)');
  await expectRejected('broken storage layout', upgrades.upgradeProxy(t2, 'BoxV2Broken'), /incompatible/i);
  await expectRejected(
    'anti-brick (uups)',
    upgrades.upgradeProxy(u2, 'BoxUUPSV2NoButton', { kind: 'uups' }),
    /upgradeTo/i,
  );

  console.log('\nDone. Deployment records: .openzeppelin/<network-or-chain-id>.json');
  // fee deductions settle a few seconds behind the last receipt on TronGrid
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`Final balance: ${(await tronWeb.trx.getBalance(base58)) / 1e6} TRX`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
