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
 *   5. migrate — five migrations: proxy deploy + upgrade, the standalone
 *      validate/prepare pair, the authority transfer, the beacon trio, and
 *      adoption from a set-aside record.
 *   6. verify — independent reads against the node itself; the migrations'
 *      own asserts are trusted only after the chain agrees.
 *   7. replay — the SAME migrations again: reruns must reuse, declare their
 *      no-ops, and change nothing they should not.
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

async function post(endpoint, body) {
  const response = await fetch(`${HOST}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
  return response.json();
}

function parseReport(output) {
  const report = {};
  for (const match of output.matchAll(/^E2E ([A-Za-z0-9._]+)=(.*)$/gm)) {
    report[match[1]] = match[2].trim();
  }
  return report;
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
    'm4.beaconProxy',
    'm4.valueAfter',
    'm5.kind',
    'm5.address',
  ];
  for (const key of required) {
    if (!(key in report1)) die(`first run reported no ${key}`);
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

  // 7 — replay: the same migrations again
  const second = run(tronbox, ['migrate', '--network', 'development'], {
    cwd: workdir,
    timeoutMs: 900_000,
  });
  console.log(second.output);
  const report2 = parseReport(second.output);

  // Addresses compare by identity, not spelling — the plugin's own rule.
  const sameAccount = (left, right) => {
    const l = bareHex(left) ?? left;
    const r = bareHex(right) ?? right;
    return l.toLowerCase() === r.toLowerCase();
  };
  const stable = ['m1.proxy', 'm1.impl', 'm2.prepared', 'm2.impl'];
  for (const key of stable) {
    if (!sameAccount(report1[key], report2[key])) {
      die(`replay changed ${key}: ${report1[key]} -> ${report2[key]}`);
    }
  }
  if (report2['m3.alreadyHeld'] !== 'true') {
    die(`replayed transfer expected alreadyHeld=true, saw ${report2['m3.alreadyHeld']}`);
  }
  if (BigInt(report2['m1.valueBefore']) !== BigInt(report1['m1.valueAfter'])) {
    die('replay lost the proxy state between runs');
  }
  if (report1['m4.beaconProxy'] === report2['m4.beaconProxy']) {
    die('the beacon migration was expected to deploy fresh on replay');
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
