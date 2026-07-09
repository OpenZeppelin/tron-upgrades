'use strict';

// Root-level mocha hook: wait until TRE has actually funded the deployer
// account before any test runs.
//
// Why: hardhat-tron's readiness probe (`tre_version`) answers ~10s after
// container boot, but TRE funds its accounts via real transactions that only
// mine a few seconds LATER. A deploy inside that gap fails with
// "Contract validate error: account [T...] does not exist".
// Upstream fix candidate: waitForReady should also poll account existence.
// Reported symptom observed 2026-07-03; see hardhat-tron src/tre/lifecycle.js.

const hre = require('hardhat');

before(async function () {
  this.timeout(90_000);
  const { tronWeb, address } = hre.tre.makeTronWeb();
  const deadline = Date.now() + 75_000;
  for (;;) {
    const acct = await tronWeb.trx.getAccount(address).catch(() => ({}));
    if (acct && acct.address) return; // account exists on-chain → funded
    if (Date.now() > deadline) {
      throw new Error(`TRE deployer account ${address} was not funded within 75s of node start`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
});
