#!/usr/bin/env node
/**
 * The live end-to-end harness: proves the PUBLISHED package against a real
 * TRON node, exactly as a consumer would use it.
 *
 * What it does, in order:
 *   1. preflight — the node must answer. Unreachable is a loud failure, or a
 *      loud SKIP with E2E_SKIP_IF_NO_TRE=1: a live-network check that cannot
 *      run says so and why, never passes silently.
 *   2. pack — `npm pack` the plugin (prepack builds first), so what installs
 *      is exactly what would publish.
 *   3. scaffold — a consumer project in a scratch directory, installed from
 *      the tarball.
 *   4. compile — `tronbox compile`. The wasm compiler can hang: bounded
 *      trials with a timeout each; a killed trial is retried, not diagnosed.
 *   5. migrate — six migrations: proxy deploy + upgrade, the standalone
 *      validate/prepare pair, the authority transfer, the beacon trio,
 *      adoption from a set-aside record, and the non-default option surface
 *      (kind: 'uups', an inferred-kind upgrade, an inferred-kind DEPLOY of a
 *      UUPS shape, the initialOwner-with-uups refusal, a zero-argument
 *      omitted initializer, call, initialOwner, and the initializer:false
 *      refusal).
 *   6. verify — independent reads against the node itself; the migrations'
 *      own asserts are trusted only after the chain agrees.
 *   7. replay — the SAME migrations again: `deployProxy` always deploys a
 *      fresh proxy on every run (Hardhat parity — a prior recorded address
 *      is never reused), so every proxy address a migration deploys
 *      directly must DIFFER between the two runs; what must still hold is
 *      implementation reuse (unchanged addresses for unchanged bytecode),
 *      deterministic refusals replaying identically, and state a migration
 *      re-derives itself (initializer values, upgrade-borne calls) landing
 *      the same way again.
 *   8. test — `tronbox test`: validation works without a deployer, and a
 *      state-changing operation refuses by name.
 *
 * Environment:
 *   E2E_FULL_HOST         node URL             (default http://127.0.0.1:9090)
 *   E2E_PRIVATE_KEY       funded account key   (default: the TRE quickstart key)
 *   E2E_TRONBOX_VERSION   tronbox to install   (default 4.9.0)
 *   E2E_WORKDIR           scaffold here instead of a fresh temp directory
 *   E2E_KEEP=1            keep the scaffold for inspection
 *   E2E_SKIP_IF_NO_TRE=1  exit 0 (loudly) when the node is unreachable
 *
 * Start a node:
 *   docker run -d -p 9090:9090 --name tron-upgrades-tre tronbox/tre
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const consumerTemplate = path.join(here, 'consumer');

const HOST = process.env.E2E_FULL_HOST || 'http://127.0.0.1:9090';
const PRIVATE_KEY =
  process.env.E2E_PRIVATE_KEY ||
  'c8afe0306dbb962a4ce8c09954f050c57facf05eb7ac88497ee1489d741aaff1';
const TRONBOX_VERSION = process.env.E2E_TRONBOX_VERSION || '4.9.0';

// A fixed throwaway key: the transfer target only ever RECEIVES ownership,
// nothing signs with it, so any well-formed address works — but a derived one
// exercises the same canonicalization a real consumer's would.
const NEW_OWNER_KEY =
  '2222222222222222222222222222222222222222222222222222222222222222';

function say(message) {
  console.log(`[e2e] ${message}`);
}

function die(message) {
  console.error(`[e2e] FAIL: ${message}`);
  process.exit(1);
}

function run(command, args, { cwd, timeoutMs, allowFailure = false } = {}) {
  const shown = `${path.basename(command)} ${args.join(' ')}`;
  say(`$ ${shown}  (cwd ${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const stdout = result.stdout ?? '';
  const out = `${stdout}${result.stderr ?? ''}`;
  if (result.status !== 0 && !allowFailure) {
    const tail = out.split('\n').slice(-40).join('\n');
    die(
      `${shown} exited ${result.status === null ? 'by timeout/kill' : result.status}\n${tail}`,
    );
  }
  return { status: result.status, output: out, stdout };
}

/**
 * Network-level failures retry; an ANSWERED request never does. The long
 * `spawnSync` steps block the event loop for minutes, the node closes the
 * idle keep-alive socket meanwhile, and the next fetch that reuses the dead
 * pooled connection dies with `TypeError: fetch failed` — measured twice at
 * the first post-migrate read. A fresh attempt opens a fresh connection.
 */
async function post(endpoint, body) {
  let lastFailure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${HOST}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(10_000),
      });
      return await response.json();
    } catch (failure) {
      lastFailure = failure;
      if (attempt < 3) {
        say(`${endpoint} did not answer (attempt ${attempt}); retrying`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  throw lastFailure;
}

/** JSON-RPC against the node's own endpoint — the same one the plugin derives. */
async function rpc(method, params) {
  const body = await post('/jsonrpc', {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  });
  if (body?.error || typeof body?.result !== 'string') {
    die(`${method} answered no result: ${JSON.stringify(body)}`);
  }
  return body.result;
}

// The two 1967 slots the option assertions read. Independent of the plugin
// on purpose: these are the standard's constants, restated here so the check
// cannot inherit a plugin-side mistake.
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

function parseReport(output) {
  const report = {};
  for (const match of output.matchAll(/^E2E ([A-Za-z0-9._]+)=(.*)$/gm)) {
    report[match[1]] = match[2].trim();
  }
  return report;
}

function assertAddedCoverage(workdir, report, output, runLabel) {
  const base58Keys = [
    'm4.readerBeacon',
    'm4.readerBeaconImpl',
    'm6.readerImpl',
    'm6.readerAdmin',
  ];
  for (const key of base58Keys) {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(report[key] ?? '')) {
      die(`${runLabel} ${key} is not a canonical base58 TRON address: ${report[key]}`);
    }
  }
  if (
    bareAddress(workdir, report['m4.readerBeacon']) !==
    bareAddress(workdir, report['m4.beacon'])
  ) {
    die(`${runLabel} beacon-slot reader disagrees with deployBeacon`);
  }
  if (
    bareAddress(workdir, report['m4.readerBeaconImpl']) !==
    bareAddress(workdir, report['m4.beaconImpl'])
  ) {
    die(`${runLabel} beacon implementation reader disagrees with deployBeacon`);
  }
  if (
    bareAddress(workdir, report['m6.readerImpl']) !==
    bareAddress(workdir, report['m6.uupsImpl'])
  ) {
    die(`${runLabel} implementation-slot reader disagrees with upgradeProxy`);
  }
  if (report['m6.readerAdmin'] !== 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb') {
    die(`${runLabel} empty UUPS admin slot did not return the base58 zero address`);
  }
  if (report['m6.readerBeaconThrew'] !== 'true') {
    die(
      `${runLabel} the empty beacon slot of a UUPS proxy must make the ` +
        `beacon-slot reader throw, not smooth to zero`,
    );
  }

  // Report hygiene for the reuse-only refusal: exactly the named code and
  // nothing else. The migration writes its own report lines, so this is not
  // itself the no-spend proof — that evidence is the source-level throw
  // inside the engine's deploy callback plus replay stability (a run-1
  // record would flip run 2 to a successful reuse and fail this check).
  const neverKeys = Object.keys(report).filter(key => key.startsWith('m6.never.'));
  if (
    neverKeys.length !== 1 ||
    neverKeys[0] !== 'm6.never.refusalCode' ||
    report['m6.never.refusalCode'] !== 'implementation-not-previously-deployed'
  ) {
    die(
      `${runLabel} reuse-only refusal must report only its named code; ` +
        `saw ${JSON.stringify(neverKeys)}`,
    );
  }

  if (
    report['m6.linked.refused'] !== 'true' ||
    report['m6.linked.accepted'] !== 'true' ||
    !/^[1-9][0-9]*$/.test(report['m6.linked.noteCount'] ?? '')
  ) {
    die(`${runLabel} linked-library validation did not flip under its single allowance`);
  }
  if (output.includes('unsafeAllow.external-library-linking')) {
    die(`${runLabel} silenceWarnings did not suppress the linked-library advisory`);
  }
}

function bareHex(address) {
  if (/^(41|0x)[0-9a-fA-F]{40}$/.test(address)) {
    return address.slice(2).toLowerCase();
  }
  return null;
}

/** Runs a one-liner with the CONSUMER's node_modules (for tronweb). */
function nodeEval(workdir, code) {
  const result = run(process.execPath, ['-e', code], {
    cwd: workdir,
    timeoutMs: 30_000,
  });
  // stdout only: warnings on stderr must not poison a last-line read.
  return result.stdout.trim();
}

const TRONWEB_PRELUDE =
  "const m = require('tronweb'); const TronWeb = m.TronWeb || m.default || m;";

/** 40 lowercase hex chars, whatever spelling a report used for the address. */
function bareAddress(workdir, address) {
  const direct = bareHex(address);
  if (direct) return direct;
  const converted = nodeEval(
    workdir,
    `${TRONWEB_PRELUDE} console.log(TronWeb.address.toHex('${address}'));`,
  )
    .split('\n')
    .pop();
  const hex = bareHex(converted);
  if (!hex) die(`cannot canonicalize the address ${address}`);
  return hex;
}

async function main() {
  // 1 — preflight
  say(`node: ${HOST}`);
  let reachable = false;
  try {
    const block = await post('/wallet/getnowblock');
    reachable = typeof block?.blockID === 'string';
  } catch {
    reachable = false;
  }
  if (!reachable) {
    const remedy =
      `no TRON node answered at ${HOST}. Start one with:\n` +
      '  docker run -d -p 9090:9090 --name tron-upgrades-tre tronbox/tre\n' +
      'or point E2E_FULL_HOST at a running node.';
    if (process.env.E2E_SKIP_IF_NO_TRE === '1') {
      console.log(`[e2e] SKIPPED (loudly): ${remedy}`);
      process.exit(0);
    }
    die(remedy);
  }

  const vendorDir = path.join(repoRoot, 'vendor');
  const vendorTarball = fs.existsSync(vendorDir)
    ? fs
        .readdirSync(vendorDir)
        .filter(name => /^openzeppelin-tron-solidity-.*\.tgz$/.test(name))
        .map(name => path.join(vendorDir, name))
        .sort()
        .pop()
    : undefined;
  if (!vendorTarball) {
    die(`no openzeppelin-tron-solidity tarball under ${vendorDir}`);
  }

  // 2 — pack
  const workRoot =
    process.env.E2E_WORKDIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'tronbox-upgrades-e2e-'));
  fs.mkdirSync(workRoot, { recursive: true });
  say(`workdir: ${workRoot}`);

  const packed = run('npm', ['pack', '--json', '--pack-destination', workRoot], {
    cwd: packageRoot,
    timeoutMs: 300_000,
  });
  // Script hooks may print around the JSON on stdout: take the outermost
  // array literal, not the whole stream.
  const jsonStart = packed.stdout.indexOf('[');
  const jsonEnd = packed.stdout.lastIndexOf(']');
  const packInfo = JSON.parse(packed.stdout.slice(jsonStart, jsonEnd + 1));
  const tarball = path.join(workRoot, packInfo[0].filename);
  if (!fs.existsSync(tarball)) die(`npm pack reported ${tarball} but it is absent`);
  say(`tarball: ${path.basename(tarball)}`);

  // 3 — scaffold
  const workdir = path.join(workRoot, 'consumer');
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.cpSync(consumerTemplate, workdir, { recursive: true });
  fs.writeFileSync(
    path.join(workdir, 'package.json'),
    JSON.stringify(
      {
        name: 'tronbox-upgrades-e2e-consumer',
        private: true,
        dependencies: {
          '@openzeppelin/tronbox-upgrades': `file:${tarball}`,
          'openzeppelin-tron-solidity': `file:${vendorTarball}`,
          tronbox: TRONBOX_VERSION,
        },
      },
      null,
      2,
    ),
  );
  run('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: workdir,
    timeoutMs: 600_000,
  });
  const tronbox = path.join(workdir, 'node_modules', '.bin', 'tronbox');
  if (!fs.existsSync(tronbox)) die('tronbox did not install into the consumer');

  // The transfer target, derived inside the consumer install.
  const newOwner = nodeEval(
    workdir,
    `${TRONWEB_PRELUDE} console.log(TronWeb.address.fromPrivateKey('${NEW_OWNER_KEY}'));`,
  )
    .split('\n')
    .pop();
  say(`transfer target: ${newOwner}`);
  fs.writeFileSync(
    path.join(workdir, 'e2e-params.json'),
    JSON.stringify({ newOwner }, null, 2),
  );

  // The configured account must be funded, or every deploy fails opaquely.
  const senderHex = nodeEval(
    workdir,
    `${TRONWEB_PRELUDE} console.log(TronWeb.address.toHex(TronWeb.address.fromPrivateKey('${PRIVATE_KEY}')));`,
  )
    .split('\n')
    .pop();
  const account = await post('/wallet/getaccount', {
    address: senderHex,
  });
  if (!account || !(account.balance > 0)) {
    die(
      `the configured account (${senderHex}) holds no TRX on ${HOST}. ` +
        'Set E2E_PRIVATE_KEY to a funded key — for TRE, read one from: ' +
        'docker logs tron-upgrades-tre',
    );
  }

  // 4 — compile: bounded trials; a killed trial is retried, not diagnosed.
  let compiled = false;
  for (let trial = 1; trial <= 3 && !compiled; trial += 1) {
    say(`compile, trial ${trial}`);
    const attempt = run(tronbox, ['compile'], {
      cwd: workdir,
      timeoutMs: 300_000,
      allowFailure: true,
    });
    compiled = attempt.status === 0;
    if (!compiled) say(`compile trial ${trial} did not finish; retrying`);
  }
  if (!compiled) die('tronbox compile failed three bounded trials');

  // 5 — migrate, first run
  const first = run(tronbox, ['migrate', '--network', 'development'], {
    cwd: workdir,
    timeoutMs: 900_000,
  });
  console.log(first.output);
  const report1 = parseReport(first.output);

  // 6 — independent verification against the node
  const required = [
    'm1.proxy',
    'm1.impl',
    'm1.valueAfter',
    'm2.prepared',
    'm2.impl',
    'm3.alreadyHeld',
    'm4.beacon',
    'm4.beaconImpl',
    'm4.beaconProxy',
    'm4.upgradedImpl',
    'm4.valueAfter',
    'm4.readerBeacon',
    'm4.readerBeaconImpl',
    'm5.kind',
    'm5.address',
    'm6.uupsProxy',
    'm6.uupsImpl',
    'm6.readerImpl',
    'm6.readerAdmin',
    'm6.readerBeaconThrew',
    'm6.uupsValueAfter',
    'm6.autoProxy',
    'm6.autoValue',
    'm6.ownerRefusalCode',
    'm6.zeroProxy',
    'm6.zeroValue',
    'm6.callProxy',
    'm6.callValue',
    'm6.ownedProxy',
    'm6.ownedOwner',
    'm6.refusalCode',
    'm6.never.refusalCode',
    'm6.linked.refused',
    'm6.linked.accepted',
    'm6.linked.noteCount',
  ];
  for (const key of required) {
    if (!(key in report1)) die(`first run reported no ${key}`);
  }
  assertAddedCoverage(workdir, report1, first.output, 'first run');
  // The initializer value, exactly: on the FIRST run nothing has incremented
  // the m1 proxy yet, so anything but the literal 42 means initialize(42)
  // did not run as asked — a `>= 42` reading would let a double-initialized
  // or replayed value slip through.
  if (BigInt(report1['m1.valueBefore']) !== 42n) {
    die(
      `the m1 initializer value must be exactly 42 on the first run, ` +
        `saw ${report1['m1.valueBefore']}`,
    );
  }
  if (report1['m3.alreadyHeld'] !== 'false') {
    die(`first transfer expected alreadyHeld=false, saw ${report1['m3.alreadyHeld']}`);
  }
  if (report1['m5.kind'] !== 'transparent') {
    die(`adoption expected kind=transparent, saw ${report1['m5.kind']}`);
  }

  let proxyHex = report1['m1.proxy'];
  if (!bareHex(proxyHex)) {
    proxyHex = nodeEval(
      workdir,
      `${TRONWEB_PRELUDE} console.log(TronWeb.address.toHex('${proxyHex}'));`,
    )
      .split('\n')
      .pop();
  }
  const constant = await post('/wallet/triggerconstantcontract', {
    owner_address: senderHex,
    contract_address: proxyHex.startsWith('0x') ? `41${proxyHex.slice(2)}` : proxyHex,
    function_selector: 'value()',
  });
  const observed = BigInt(`0x${constant.constant_result[0]}`);
  if (observed !== BigInt(report1['m1.valueAfter'])) {
    die(
      `the chain answers value()=${observed} through the proxy; ` +
        `the migration reported ${report1['m1.valueAfter']}`,
    );
  }
  say(`chain agrees: value() = ${observed} through ${report1['m1.proxy']}`);

  const recordDir = path.join(workdir, '.openzeppelin');
  const records = fs
    .readdirSync(recordDir)
    .filter(name => name.endsWith('.json') && !name.endsWith('.instance.json'));
  if (records.length === 0) die('no deployment record was written');
  const recordText = fs
    .readFileSync(path.join(recordDir, records[0]), 'utf8')
    .toLowerCase();
  if (!recordText.includes(bareHex(proxyHex))) {
    die('the deployment record does not name the proxy');
  }

  // 6b — the non-default option semantics, verified against the node's own
  // slots: the migration's asserts are trusted only after the chain agrees.
  const zeroWord = value => BigInt(value) === 0n;

  // kind: 'uups' — the admin slot must be EMPTY and the implementation slot
  // must name the (kind-inferred) upgrade's implementation. A silently
  // transparent deploy fails both reads.
  const uupsHex = bareAddress(workdir, report1['m6.uupsProxy']);
  const uupsAdmin = await rpc('eth_getStorageAt', [
    `0x${uupsHex}`,
    ADMIN_SLOT,
    'latest',
  ]);
  if (!zeroWord(uupsAdmin)) {
    die(`kind:'uups' produced a proxy with a non-empty 1967 admin slot: ${uupsAdmin}`);
  }
  const uupsImplWord = await rpc('eth_getStorageAt', [
    `0x${uupsHex}`,
    IMPLEMENTATION_SLOT,
    'latest',
  ]);
  const uupsImplHex = bareAddress(workdir, report1['m6.uupsImpl']);
  if (!uupsImplWord.toLowerCase().endsWith(uupsImplHex)) {
    die(
      `the uups implementation slot holds ${uupsImplWord}; the kind-omitted ` +
        `upgrade reported ${report1['m6.uupsImpl']}`,
    );
  }
  const uupsValue = await post('/wallet/triggerconstantcontract', {
    owner_address: senderHex,
    contract_address: `41${uupsHex}`,
    function_selector: 'value()',
  });
  if (
    BigInt(`0x${uupsValue.constant_result[0]}`) !==
    BigInt(report1['m6.uupsValueAfter'])
  ) {
    die('the chain disagrees with the migration about the uups proxy value');
  }
  say(
    `chain agrees: uups proxy ${report1['m6.uupsProxy']} — empty admin slot, ` +
      `implementation ${report1['m6.uupsImpl']}`,
  );

  // kind OMITTED on a UUPS-shaped implementation — the kind must be
  // INFERRED: the admin slot must be EMPTY, exactly as for the explicit
  // kind above. A defaulted-to-transparent deploy fails this read.
  const autoHex = bareAddress(workdir, report1['m6.autoProxy']);
  const autoAdmin = await rpc('eth_getStorageAt', [
    `0x${autoHex}`,
    ADMIN_SLOT,
    'latest',
  ]);
  if (!zeroWord(autoAdmin)) {
    die(
      `the kind-omitted UUPS deploy produced a proxy with a non-empty 1967 ` +
        `admin slot (${autoAdmin}) — the kind was not inferred`,
    );
  }
  const autoValue = await post('/wallet/triggerconstantcontract', {
    owner_address: senderHex,
    contract_address: `41${autoHex}`,
    function_selector: 'value()',
  });
  if (BigInt(`0x${autoValue.constant_result[0]}`) !== 42n) {
    die('the chain disagrees about the kind-omitted proxy initializer value');
  }
  say(
    `chain agrees: kind-omitted proxy ${report1['m6.autoProxy']} inferred ` +
      `uups — empty admin slot, value() = 42`,
  );

  if (report1['m6.ownerRefusalCode'] !== 'initial-owner-unsupported-kind') {
    die(
      `initialOwner with kind:'uups' expected the ` +
        `initial-owner-unsupported-kind refusal, saw ${report1['m6.ownerRefusalCode']}`,
    );
  }

  // initializer OMITTED with zero args — the zero-argument initialize() must
  // have RUN: value() answers exactly the initializer's constant, and the
  // inferred-transparent proxy's admin slot is set.
  const zeroHex = bareAddress(workdir, report1['m6.zeroProxy']);
  const zeroAdmin = await rpc('eth_getStorageAt', [
    `0x${zeroHex}`,
    ADMIN_SLOT,
    'latest',
  ]);
  if (zeroWord(zeroAdmin)) {
    die('the zero-arg-initializer proxy has an empty 1967 admin slot — not transparent');
  }
  const zeroValue = await post('/wallet/triggerconstantcontract', {
    owner_address: senderHex,
    contract_address: `41${zeroHex}`,
    function_selector: 'value()',
  });
  if (BigInt(`0x${zeroValue.constant_result[0]}`) !== 7n) {
    die(
      `the zero-argument initialize() did not run: value() answers ` +
        `${BigInt(`0x${zeroValue.constant_result[0]}`)} instead of 7`,
    );
  }
  say('chain agrees: the omitted initializer found and ran initialize()');

  // call: { fn: 'store', args: [99] } — retrieve() must answer 99 through
  // the transparent proxy, whose admin slot must be set.
  const callHex = bareAddress(workdir, report1['m6.callProxy']);
  const callAdmin = await rpc('eth_getStorageAt', [
    `0x${callHex}`,
    ADMIN_SLOT,
    'latest',
  ]);
  if (zeroWord(callAdmin)) {
    die('the call-option proxy has an empty 1967 admin slot — not transparent');
  }
  const retrieved = await post('/wallet/triggerconstantcontract', {
    owner_address: senderHex,
    contract_address: `41${callHex}`,
    function_selector: 'retrieve()',
  });
  if (BigInt(`0x${retrieved.constant_result[0]}`) !== 99n) {
    die(
      `the post-upgrade call did not land: retrieve() answers ` +
        `${BigInt(`0x${retrieved.constant_result[0]}`)} instead of 99`,
    );
  }
  say('chain agrees: the upgrade-borne store(99) landed');

  // initialOwner — the 1967 admin slot names the ProxyAdmin, whose owner()
  // must be exactly the requested address, not the deploying account.
  const ownedHex = bareAddress(workdir, report1['m6.ownedProxy']);
  const ownedAdmin = await rpc('eth_getStorageAt', [
    `0x${ownedHex}`,
    ADMIN_SLOT,
    'latest',
  ]);
  if (zeroWord(ownedAdmin)) {
    die('the initialOwner proxy has an empty 1967 admin slot — not transparent');
  }
  const adminHex = ownedAdmin.slice(-40).toLowerCase();
  const ownerAnswer = await post('/wallet/triggerconstantcontract', {
    owner_address: senderHex,
    contract_address: `41${adminHex}`,
    function_selector: 'owner()',
  });
  const ownerHex = (ownerAnswer.constant_result?.[0] ?? '')
    .slice(-40)
    .toLowerCase();
  const expectedOwner = bareAddress(workdir, report1['m6.ownedOwner']);
  if (ownerHex !== expectedOwner) {
    die(
      `initialOwner did not land: the ProxyAdmin's owner is ${ownerHex}, ` +
        `the caller asked for ${expectedOwner}`,
    );
  }
  say('chain agrees: the ProxyAdmin owner is the requested initialOwner');

  if (report1['m6.refusalCode'] !== 'empty-initializer-refused') {
    die(
      `initializer:false expected the empty-initializer-refused refusal, ` +
        `saw ${report1['m6.refusalCode']}`,
    );
  }

  // 7 — replay: the same migrations again
  const second = run(tronbox, ['migrate', '--network', 'development'], {
    cwd: workdir,
    timeoutMs: 900_000,
  });
  console.log(second.output);
  const report2 = parseReport(second.output);
  for (const key of required) {
    if (!(key in report2)) die(`replay reported no ${key}`);
  }
  assertAddedCoverage(workdir, report2, second.output, 'replay');

  // Addresses compare by identity, not spelling — the plugin's own rule.
  const sameAccount = (left, right) => {
    const l = bareHex(left) ?? left;
    const r = bareHex(right) ?? right;
    return l.toLowerCase() === r.toLowerCase();
  };
  // Implementation-only identities: `fetchOrDeployImplementation`'s own
  // record reuse is untouched by the deploy-proxy change above and keeps
  // these addresses fixed across runs whether or not the proxy pointing at
  // them is new.
  const stable = [
    'm1.impl',
    'm2.prepared',
    'm2.impl',
    'm4.beaconImpl',
    'm4.readerBeaconImpl',
    'm4.upgradedImpl',
    'm6.uupsImpl',
    'm6.readerImpl',
  ];
  for (const key of stable) {
    if (!sameAccount(report1[key], report2[key])) {
      die(`replay changed ${key}: ${report1[key]} -> ${report2[key]}`);
    }
  }
  // `deployProxy` always deploys a fresh proxy — Hardhat parity, a prior
  // recorded address is never reused — so every proxy address a migration
  // deploys directly must DIFFER between the two runs, exactly like the
  // beacon proxy already does below.
  const fresh = [
    'm1.proxy',
    'm4.beacon',
    'm4.readerBeacon',
    'm4.beaconProxy',
    'm6.uupsProxy',
    'm6.autoProxy',
    'm6.zeroProxy',
    'm6.callProxy',
    'm6.ownedProxy',
  ];
  for (const key of fresh) {
    if (sameAccount(report1[key], report2[key])) {
      die(
        `${key} was expected to deploy fresh on replay (deployProxy never ` +
          `reuses a prior proxy), but stayed ${report1[key]}`,
      );
    }
  }
  // Migration 1's Box proxy is a NEW proxy every run, and a transparent
  // proxy deploys its own ProxyAdmin internally — so the admin transfer
  // never sees an already-transferred ProxyAdmin on replay either: it
  // starts over from the deploying account each time.
  if (report2['m3.alreadyHeld'] !== 'false') {
    die(
      `replayed transfer expected alreadyHeld=false (a fresh proxy's ` +
        `ProxyAdmin is owned by the deployer again), saw ${report2['m3.alreadyHeld']}`,
    );
  }
  // The refusal is pre-spend against a never-deployed artifact, so it must
  // replay identically.
  if (report2['m6.refusalCode'] !== 'empty-initializer-refused') {
    die(
      `replayed initializer:false expected the same refusal, ` +
        `saw ${report2['m6.refusalCode']}`,
    );
  }
  // The uups+initialOwner refusal is a deterministic, pre-spend option
  // check, so it must replay identically regardless of what deployProxy's
  // corrupt-record refusal would have decided about BoxUUPSAuto's (fresh,
  // differently-addressed) recorded proxy.
  if (report2['m6.ownerRefusalCode'] !== 'initial-owner-unsupported-kind') {
    die(
      `replayed initialOwner+uups expected the same refusal, ` +
        `saw ${report2['m6.ownerRefusalCode']}`,
    );
  }
  // Each of these is the FRESH proxy's own initializer/call landing again —
  // never a preserved value from the first run's now-superseded proxy.
  if (report2['m6.autoValue'] !== '42') {
    die(`replay changed the kind-omitted proxy value: ${report2['m6.autoValue']}`);
  }
  if (report2['m6.zeroValue'] !== '7') {
    die(`replay changed the zero-arg-initializer value: ${report2['m6.zeroValue']}`);
  }
  if (report2['m6.callValue'] !== '99') {
    die(`replay lost the upgrade-borne store(99): ${report2['m6.callValue']}`);
  }
  // NOT a continuity check against run 1's post-increment value: migration
  // 1's proxy is a fresh deploy every run, so its state starts over — the
  // read right after the (also fresh) upgrade must be exactly the
  // initializer's 42 again, the same pin already made on the first run.
  if (BigInt(report2['m1.valueBefore']) !== 42n) {
    die(
      `the m1 initializer value must be exactly 42 again on replay (a ` +
        `fresh proxy every run), saw ${report2['m1.valueBefore']}`,
    );
  }
  // 8 — tronbox test: validation without a deployer
  const tested = run(tronbox, ['test', '--network', 'development'], {
    cwd: workdir,
    timeoutMs: 600_000,
  });
  console.log(tested.output);

  if (process.env.E2E_KEEP !== '1' && !process.env.E2E_WORKDIR) {
    fs.rmSync(workRoot, { recursive: true, force: true });
  } else {
    say(`kept: ${workRoot}`);
  }
  say('PASS: pack, install, migrate, verify, replay, test — all green');
}

main().catch(error => die(error?.stack ?? String(error)));
