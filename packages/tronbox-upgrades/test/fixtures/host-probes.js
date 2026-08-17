'use strict';
/*
 * Environment-seam probes — the executable evidence behind the measured host
 * facts the seam is built on.
 *
 * Usage:  node host-probes.js <path-to-installed-tronbox> [probe-name ...]
 * Example: node probes.js ../../../node_modules/tronbox
 *          node probes.js /tmp/tb490/node_modules/tronbox deferredChain parityDeployPort
 *
 * Run against every TronBox version in the supported range: each probe pins a fact the seam is
 * built on, and a fact that changes upstream should fail here loudly rather than surface as a
 * behavioural bug. `test/real-tronbox.test.ts` runs them as test cases.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const TB = path.resolve(process.argv[2] || '');
if (!TB || !fs.existsSync(path.join(TB, 'build'))) {
  console.error('usage: node probes.js <path-to-installed-tronbox> [probe-name ...]');
  process.exit(2);
}
const tb = (p) => require(path.join(TB, 'build', p));
const version = require(path.join(TB, 'package.json')).version;

// TronWrap is a first-initialisation-wins process singleton; several probes need it warm.
function initTronWrap() {
  return tb('components/TronWrap')(
    {
      fullHost: 'http://127.0.0.1:9090',
      network_id: '*',
      privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
    },
    { logger: { log() {} } },
  );
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf0-' + tag + '-'));
}

const probes = {};

/* ------------------------------------------------------------------ *
 * Claim: a plugin module required from a migration cannot see any of
 * TronBox's migration globals — they are vm-context properties, while
 * the module runs in the outer context. (See the note "Why it does
 * not port")
 * ------------------------------------------------------------------ */
probes.sandboxVisibility = function () {
  const dir = tmpdir('sandbox');
  fs.mkdirSync(path.join(dir, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'p', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'p', 'index.js'),
    'module.exports.seen = () => ({\n' +
      '  tronWrap: typeof global.tronWrap, tronWeb: typeof global.tronWeb,\n' +
      '  artifacts: typeof global.artifacts, waitForTransactionReceipt: typeof global.waitForTransactionReceipt,\n' +
      '});\n',
  );
  fs.writeFileSync(
    path.join(dir, 'mig.js'),
    "const p = require('p');\n" +
      'module.exports = function (deployer) {\n' +
      '  module.exports.result = { inMigration: typeof tronWrap, inPlugin: p.seen() };\n' +
      '};\n',
  );

  const marker = { __marker: 'tronWrap' };
  const fn = tb('components/Require.js').file({
    file: path.join(dir, 'mig.js'),
    context: { tronWrap: marker, tronWeb: marker, waitForTransactionReceipt() {} },
    resolver: { require() {} },
  });
  fn({});
  const r = fn.result;

  assert.strictEqual(r.inMigration, 'object', 'migration scope should see tronWrap');
  for (const k of Object.keys(r.inPlugin)) {
    assert.strictEqual(r.inPlugin[k], 'undefined', 'plugin scope must NOT see global.' + k);
  }
  return 'migration sees tronWrap; plugin module sees none of the sandbox globals';
};

/* ------------------------------------------------------------------ *
 * Claim: the Config is at deployer.options.options, not deployer.options,
 * and deployer.options carries basePath (the migrations dir, not the root).
 *
 * ------------------------------------------------------------------ */
probes.deployerConfigDepth = function () {
  const Config = tb('components/Config');
  const Deployer = tb('components/Deployer/index.js');
  const cfg = Config.default();
  const d = new Deployer({
    options: cfg,
    logger: { log() {} },
    network: 'development',
    network_id: '*',
    basePath: '/proj/migrations',
  });
  assert.deepStrictEqual(Object.keys(d.options), ['options', 'logger', 'network', 'network_id', 'basePath']);
  assert.ok(d.options.options instanceof Config, 'deployer.options.options must be the Config');
  assert.ok(!(d.options instanceof Config), 'deployer.options must NOT be the Config');
  return 'Config lives at deployer.options.options; deployer.options also carries basePath';
};

/* ------------------------------------------------------------------ *
 * Claim: `'*'` is never resolved by TronBox, and Config.with() returns a
 * materialised plain-object snapshot whose derived values freeze.
 *
 * ------------------------------------------------------------------ */
probes.wildcardAndSnapshot = function () {
  const Config = tb('components/Config');
  const c = Config.default();
  c.working_directory = '/proj';
  c.networks = { development: { network_id: '*', fullHost: 'http://127.0.0.1:9090', privateKey: 'aa' } };
  c.network = 'development';

  assert.strictEqual(c.network_id, '*', "live Config must pass '*' through unresolved");
  assert.strictEqual(c.privateKey, null, 'config.privateKey getter always returns null');
  assert.strictEqual(c.network_config.privateKey, 'aa', 'network_config carries the key');
  assert.notStrictEqual(c.network_config, c.network_config, 'network_config is freshly merged per access');

  const snap = c.with({});
  assert.ok(!(snap instanceof Config), 'Config.with() returns a plain object');
  c.networks.development.network_id = '9999';
  assert.strictEqual(c.network_id, '9999', 'live Config is late-bound');
  assert.strictEqual(snap.network_id, '*', 'snapshot is early-bound');
  return "'*' never resolved; live is late-bound, .with() is a frozen snapshot; privateKey getter is null";
};

/* ------------------------------------------------------------------ *
 * Claim: two Config lineages. Identical object under migrate; distinct
 * under `tronbox test`, and able to disagree.
 * ------------------------------------------------------------------ */
probes.configLineages = function () {
  const Config = tb('components/Config');
  const Resolver = tb('components/Resolver/index.js');
  const Intercept = tb('components/Resolver/intercept.js');
  const Deployer = tb('components/Deployer/index.js');

  const mk = () => {
    const c = Config.default();
    c.working_directory = '/proj';
    c.networks = { development: { network_id: '*' }, nile: { network_id: '3' } };
    c.network = 'development';
    c.resolver = new Resolver(c);
    return c;
  };
  const lineages = (opts) => {
    const d = new Deployer({
      options: opts,
      logger: { log() {} },
      network: opts.network,
      network_id: opts.network_id,
    });
    return [d.options.options, new Intercept(opts.resolver).resolver.options];
  };

  const [dMig, aMig] = lineages(mk());
  assert.strictEqual(dMig, aMig, 'under migrate the two lineages are the same object');

  const live = mk();
  const snap = live.with({ reset: true });
  snap.resolver = live.resolver;
  const [dTest, aTest] = lineages(snap);
  assert.notStrictEqual(dTest, aTest, 'under `tronbox test` they are distinct objects');

  live.network = 'nile'; // a post-snapshot mutation reaching only the live Config
  assert.strictEqual(aTest.network_id, '3');
  assert.strictEqual(dTest.network_id, '*');
  return 'same object under migrate; distinct and able to disagree under `tronbox test`';
};

/* ------------------------------------------------------------------ *
 * Claim: an error in a queued deferred-chain step rejects start(), leaves
 * the awaiting caller inside the migration permanently unsettled, and
 * emits an unhandled rejection. Ordering of queued work IS preserved.
 * (reproduces the migrations-directory hazard)
 * ------------------------------------------------------------------ */
probes.deferredChain = async function () {
  const Deployer = tb('components/Deployer/index.js');
  initTronWrap();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e && e.message);
  process.on('unhandledRejection', onUnhandled);

  const contract = (name, fail) => ({
    contract_name: name,
    initTronWeb: true,
    isDeployed: () => false,
    new: async () => {
      if (fail) throw new Error('deploy failed: insufficient fee limit');
      return { address: '41' + name.padEnd(40, '0'), transactionHash: 'tx-' + name };
    },
  });

  async function run(body) {
    unhandled.length = 0;
    const d = new Deployer({ options: {}, logger: { log() {} }, network: 'development', network_id: '*' });
    const trace = [];
    const migrateFn = body(d, trace);
    let startRejected = null;
    await d.start().then(() => {}, (e) => { startRejected = e.message; });
    const settled = await Promise.race([
      Promise.resolve(migrateFn).then(() => 'settled', () => 'settled'),
      new Promise((r) => setTimeout(() => r('HUNG'), 200)),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    return { startRejected, settled, unhandled: unhandled.length, trace };
  }

  const fail = await run((d) => (async () => { await d.deploy(contract('F', true)); })());
  assert.ok(fail.startRejected, 'start() must reject with the underlying error');
  assert.strictEqual(fail.settled, 'HUNG', 'awaiting caller in the migration never settles');
  assert.ok(fail.unhandled >= 1, 'a dangling unhandled rejection is left on the chain');

  const order = await run((d, t) => (async () => {
    d.deploy(contract('A'));                            // queued, not awaited
    await d.then(() => t.push('pluginStepRan'));
  })());
  assert.strictEqual(order.settled, 'settled');
  assert.deepStrictEqual(order.trace, ['pluginStepRan'], 'queued deploy runs before the plugin step');

  process.off('unhandledRejection', onUnhandled);
  return 'failure: start() rejects, caller hangs, unhandled rejection; ordering preserved';
};

/* ------------------------------------------------------------------ *
 * Claim: the parity target's deploy line cannot be ported verbatim —
 * `await deployer.deploy(...)` yields undefined in the real ordering.
 *
 * ------------------------------------------------------------------ */
probes.parityDeployPort = async function () {
  const Deployer = tb('components/Deployer/index.js');
  initTronWrap();
  const contract = {
    contract_name: 'Impl',
    initTronWeb: true,
    isDeployed: () => false,
    new: async () => ({ address: '41aaaabbbbccccddddeeeeffff0000111122223333', transactionHash: '0xdeadbeef' }),
  };
  const d = new Deployer({ options: {}, logger: { log() {} }, network: 'development', network_id: '*' });

  // Mirrors Migration.prototype.run: migration fn first, THEN deployer.start().
  const migrateFn = (async (deployer) => {
    const { address } = await deployer.deploy(contract);   // plugin-truffle/src/utils/deploy.ts
    return address;
  })(d);
  d.start().then(() => {}, () => {});

  const outcome = await migrateFn.then(() => 'succeeded', (e) => e.constructor.name);
  assert.strictEqual(outcome, 'TypeError', 'the ported destructuring must throw TypeError');
  return 'ported parity deploy line throws TypeError — deployer.deploy() resolves undefined';
};

/* ------------------------------------------------------------------ *
 * Claim: `deployer` and `artifacts` are FRESH per migration while the
 * Config is SHARED; plugin modules are cached across migrations; and each
 * migration's saveAll preserves earlier migrations' artifacts.
 * (covers the "state leakage AND artifact persistence" hazard)
 * ------------------------------------------------------------------ */
probes.perMigrationBinding = async function () {
  const Migrate = tb('components/Migrate');
  const Artifactor = tb('components/Artifactor');
  const Contract = tb('components/Contract');
  const provision = tb('components/Provisioner');
  const Config = tb('components/Config');
  initTronWrap();

  const dir = tmpdir('binding');
  const migrations = path.join(dir, 'migrations');
  const buildDir = path.join(dir, 'build', 'contracts');
  fs.mkdirSync(migrations, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'p', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', main: 'index.js' }),
  );
  // A plugin module that memoises a composite on `deployer` via WeakMap.
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'p', 'index.js'),
    'const d=[],c=[],a=[];const m=new WeakMap();let builds=0;\n' +
      'module.exports.observe=(dep,art)=>{d.push(dep);c.push(dep.options.options);a.push(art);\n' +
      '  if(!m.has(dep))m.set(dep,++builds);\n' +
      '  return {pass:d.length,deployerFresh:dep!==d[0],artifactsFresh:art!==a[0],\n' +
      '          configShared:dep.options.options===c[0],builds,builtOn:m.get(dep)};};\n' +
      'module.exports.results=[];\n',
  );
  for (const n of [1, 2]) {
    fs.writeFileSync(
      path.join(migrations, n + '_m.js'),
      "const p=require('p');\n" +
        'module.exports=function(deployer){\n' +
        "  const W=artifacts.require('Widget" + n + "');\n" +
        "  W.address='41" + n + n + n + "aaaabbbbccccddddeeeeffff00001111';\n" +
        '  p.results.push(p.observe(deployer, artifacts));\n' +
        '};\n',
    );
  }

  const cfg = Config.default();
  cfg.working_directory = dir;
  cfg.networks = { development: { network_id: '*', fullHost: 'http://127.0.0.1:9090', privateKey: 'aa', from: 'TFrom' } };
  cfg.network = 'development';
  cfg.migrations_directory = migrations;
  cfg.artifactor = new Artifactor(buildDir);
  cfg.logger = { log() {} };
  cfg.resolver = {
    require(name) {
      if (name === 'Migrations') throw new Error('no Migrations artifact');
      const a = Contract({ contractName: name, abi: [], bytecode: '0x6080', networks: {} });
      provision(a, cfg);
      return a;
    },
  };

  for (const f of ['1_m', '2_m']) {
    const m = new Migrate.Migration(path.join(migrations, f + '.js'));
    await new Promise((res, rej) => m.run(cfg, (e) => (e ? rej(e) : res())));
  }

  const results = require(path.join(dir, 'node_modules', 'p')).results;
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[1].deployerFresh, true, 'deployer must be a fresh object per migration');
  assert.strictEqual(results[1].artifactsFresh, true, 'artifacts must be a fresh intercept per migration');
  assert.strictEqual(results[1].configShared, true, 'the Config is SHARED across migrations');
  assert.strictEqual(results[1].builds, 2, 'a WeakMap keyed on deployer builds one composite per migration');
  assert.strictEqual(results[1].builtOn, 2);

  // Artifact persistence: migration 1's address must survive migration 2's saveAll.
  const w1 = JSON.parse(fs.readFileSync(path.join(buildDir, 'Widget1.json'), 'utf8'));
  const w2 = JSON.parse(fs.readFileSync(path.join(buildDir, 'Widget2.json'), 'utf8'));
  assert.strictEqual(w1.networks['*'].address, '41111aaaabbbbccccddddeeeeffff00001111');
  assert.strictEqual(w2.networks['*'].address, '41222aaaabbbbccccddddeeeeffff00001111');
  return 'deployer/artifacts fresh per migration, Config shared, WeakMap-on-deployer gives per-migration identity, earlier artifacts survive';
};

/* ------------------------------------------------------------------ *
 * Claim: bare-name-only artifact resolution (no FQN), but a JSON artifact
 * inside node_modules IS loadable by path — correcting gap-review G4.
 *
 * ------------------------------------------------------------------ */
probes.artifactResolution = function () {
  const Config = tb('components/Config');
  const Resolver = tb('components/Resolver/index.js');
  initTronWrap();

  const dir = tmpdir('resolve');
  const pkgDir = path.join(dir, 'node_modules', '@openzeppelin', 'upgrades-core', 'artifacts', 'proxy');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'build', 'contracts'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'ERC1967Proxy.json'),
    JSON.stringify({ contractName: 'ERC1967Proxy', abi: [], bytecode: '0x6080604052', networks: {} }),
  );
  fs.writeFileSync(
    path.join(dir, 'build', 'contracts', 'Box.json'),
    JSON.stringify({ contractName: 'Box', abi: [], bytecode: '0x60aa', networks: {} }),
  );

  const c = Config.default();
  c.working_directory = dir;
  c.networks = { development: { network_id: '*' } };
  c.network = 'development';
  const r = new Resolver(c);
  const tryRequire = (p) => { try { return r.require(p).contract_name; } catch (e) { return null; } };

  assert.strictEqual(tryRequire('Box'), 'Box', 'bare name resolves');
  assert.strictEqual(tryRequire('contracts/Box.sol'), null, 'qualified .sol paths are rejected (no FQN)');
  assert.strictEqual(
    tryRequire('@openzeppelin/upgrades-core/artifacts/proxy/ERC1967Proxy.json'),
    'ERC1967Proxy',
    'a JSON artifact under node_modules IS loadable by path',
  );
  assert.strictEqual(tryRequire('../outside/Evil.json'), null, 'project-boundary guard holds');
  return 'bare-name only for .sol; node_modules JSON artifacts loadable by path (G4 corrected)';
};

/* ------------------------------------------------------------------ *
 * Claim: `require('tronbox')` never resolves — no main, no root index.js.
 *
 * ------------------------------------------------------------------ */
probes.tronboxNotRequirable = function () {
  const pkg = require(path.join(TB, 'package.json'));
  assert.strictEqual(pkg.main, undefined, 'tronbox declares no main');
  assert.strictEqual(fs.existsSync(path.join(TB, 'index.js')), false, 'no root index.js');
  return 'require("tronbox") cannot resolve: no main field, no root index.js';
};

/* ------------------------------------------------------------------ *
 * Claim (the `compiler` slot): every Config key the compiler
 * slot reads is where the seam says it is, and the two Config lineages
 * hold the *same* solc-settings object — which is what licenses the
 * identity cross-check in `compiler.ts:compareCompilerSettings`.
 * ------------------------------------------------------------------ */
probes.compilerConfiguration = () => {
  const Config = tb('components/Config');
  const config = new Config();

  // `solc` and `networks` are declared props: own enumerable accessors, and
  // present on every live Config. `compilers` and `evm` are declared nowhere.
  for (const key of ['solc', 'networks']) {
    const d = Object.getOwnPropertyDescriptor(config, key);
    assert.ok(d, key + ' is an own property of a bare Config');
    assert.strictEqual(typeof d.get, 'function', key + ' is an accessor');
    assert.strictEqual(d.enumerable, true, key + ' is enumerable');
  }
  assert.deepStrictEqual(config.solc, {}, 'solc defaults to {}');
  assert.deepStrictEqual(config.networks, {}, 'networks defaults to {}');
  for (const key of ['compilers', 'evm']) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(config, key),
      false,
      key + ' is absent from a bare Config',
    );
  }

  // `merge` installs an undeclared key as a plain own DATA property, which is how
  // a project's `compilers` and the CLI's `--evm` reach the Config at all.
  const merged = new Config();
  merged.merge({ compilers: { solc: { version: '0.8.20' } }, evm: true });
  for (const key of ['compilers', 'evm']) {
    const d = Object.getOwnPropertyDescriptor(merged, key);
    assert.ok(d, key + ' is installed by merge');
    assert.strictEqual(d.get, undefined, key + ' is a data property, not an accessor');
  }
  assert.strictEqual(merged.compilers.solc.version, '0.8.20');
  assert.strictEqual(merged.evm, true);

  // `addProp`'s getter is truthiness-guarded, so a falsy configured value reads
  // back as `undefined` rather than as the value written. This is the only way a
  // project reaches `TronSolc.getWrapper`'s `if (options.networks)` false branch.
  const falsy = new Config();
  falsy.merge({ solc: 0, networks: null });
  assert.strictEqual(falsy.solc, undefined, 'a falsy solc reads back as undefined');
  assert.strictEqual(falsy.networks, undefined, 'a falsy networks reads back as undefined');

  // The materialized snapshot the deployer lineage carries under `tronbox test`
  // copies object-valued keys BY REFERENCE, so both lineages see one settings
  // object. `compareCompilerSettings` compares identity on the strength of this.
  const live = new Config();
  live.merge({ compilers: { solc: { settings: { evmVersion: 'istanbul' } } } });
  const snapshot = live.with({ reset: true });
  for (const key of ['solc', 'networks', 'compilers']) {
    const d = Object.getOwnPropertyDescriptor(snapshot, key);
    assert.ok(d, key + ' is present on the snapshot');
    assert.strictEqual(d.get, undefined, key + ' is a data property on the snapshot');
    assert.strictEqual(snapshot[key], live[key], key + ' is the same object on both lineages');
  }

  // The precedence chain and the settings fall-through, asserted against the
  // INSTALLED package — `build/`, transpiled, one physical line per file — rather
  // than against a clone's readable `src/`. The needles are therefore the built
  // form: double quotes, `var`, and optional chaining desugared into
  // `===null||…===void 0?void 0:` ladders. A clone is the readable source and is
  // cited as such; this is what a consumer can actually verify from a package root.
  const tronSolc = fs.readFileSync(path.join(TB, 'build/components/TronSolc.js'), 'utf8');
  const compile = fs.readFileSync(path.join(TB, 'build/components/Compile/index.js'), 'utf8');
  const expected = [
    // the host default, and the fact that nothing else supplies it
    [tronSolc, 'var maxVersion="0.8.26"'],
    [tronSolc, 'var compilerVersion=maxVersion'],
    // the family, from `evm` alone
    [tronSolc, 'options.evm?"evm-solc":"solc"'],
    // the whole selection block is gated on a truthy `networks`
    [tronSolc, 'if(options.networks){'],
    // the two legacy flags, read off the networks MAP rather than the entry
    [tronSolc, 'if(options.networks.useZeroFourCompiler){compilerVersion="0.4.25"}'],
    [tronSolc, 'else if(options.networks.useZeroFiveCompiler){compilerVersion="0.5.4"}'],
    // the two configured versions, and global winning over network-level
    [tronSolc, 'var networkVersion=(_options$networks$com=options.networks.compilers)'],
    [tronSolc, 'var globalVersion=(_options$compilers=options.compilers)'],
    [tronSolc, 'if(globalVersion){compilerVersion=globalVersion}else if(networkVersion){'],
    // the settings fall-through
    [compile, 'var settings=Object.keys(options.solc).length?options.solc:'],
    [compile, '_options$compilers.settings)|'],
  ];
  for (const [text, needle] of expected) {
    assert.ok(text.includes(needle), 'host build/ contains: ' + needle);
  }

  return (
    'solc+networks are declared accessors, compilers+evm are merge-installed data props, ' +
    'a falsy value reads back undefined, the snapshot shares the settings object, ' +
    'and all 11 precedence/fall-through expressions are present in build/'
  );
};

/* ------------------------------------------------------------------ */

(async () => {
  const requested = process.argv.slice(3);
  const names = requested.length ? requested : Object.keys(probes);
  console.log('TronBox ' + version + ' — ' + names.length + ' probe(s)\n');
  let failed = 0;
  for (const name of names) {
    if (!probes[name]) { console.error('  ?  ' + name + ' — no such probe'); failed++; continue; }
    try {
      const note = await probes[name]();
      console.log('  ok  ' + name + '\n        ' + note);
    } catch (e) {
      failed++;
      console.error('  FAIL ' + name + '\n        ' + e.message);
    }
  }
  console.log('\n' + (failed ? failed + ' probe(s) FAILED' : 'all probes passed'));
  process.exit(failed ? 1 : 0);
})();
