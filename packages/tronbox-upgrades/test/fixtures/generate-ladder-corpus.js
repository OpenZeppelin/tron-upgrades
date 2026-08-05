#!/usr/bin/env node
/*
 * Compiles `upgrade-pairs.json` against the real TVM wasm and writes
 * `ladder-corpus.json` — the real solc standard-JSON the validation ladder tests drive.
 *
 * WHY A GENERATED CORPUS RATHER THAN COMPILING IN THE SUITE.
 *
 * The ladder's non-vacuity discriminators need *real* ASTs and *real* deployed
 * bytecode: a fresh-path fixture that says "compatible at zero compiles" proves
 * nothing unless the same fixture refuses a reordering, and that refusal is the
 * validation engine's answer over a layout reconstructed from an AST. Hand-written
 * AST stubs cannot produce it. But a synchronous wasm compile blocks for its whole
 * duration and emits nothing while it does, so putting 26 of them in the fast suite
 * would make every run pay for a fixture that never changes.
 *
 * So the compiles happen here, once, and the suite reads the result.
 * `test/sf-2-real-compiler.test.ts` recompiles the decisive pairs live and compares,
 * which is what keeps a stale corpus from silently becoming the thing under test.
 *
 *   node test/fixtures/generate-ladder-corpus.js
 *
 * Requires ~/.tronbox/solc/soljson_v0.8.26.js. Deterministic: same compiler and
 * same input give byte-identical output, so re-running it on an unchanged tree
 * rewrites the same bytes.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const HERE = __dirname;
const PAIRS = JSON.parse(
  fs.readFileSync(path.join(HERE, 'upgrade-pairs.json'), 'utf8'),
);

const SOLJSON = path.join(
  os.homedir(),
  '.tronbox',
  'solc',
  `soljson_v${PAIRS.compiler.version}.js`,
);

/** The pairs whose slot-level side the ladder needs. The rest are AST-only. */
const SLOT_LEVEL_PAIRS = new Set([
  'append',
  'reorder',
  'gap-consumption',
  'intra-slot-padding',
]);

function wrap(module_) {
  const version = module_.cwrap('solidity_version', 'string', []);
  const reset = module_._solidity_reset
    ? module_.cwrap('solidity_reset', null, [])
    : undefined;
  const compile = module_.cwrap('solidity_compile', 'string', [
    'string',
    'number',
    'number',
  ]);
  return {
    version,
    compile: input => {
      const raw = compile(input, null, null);
      if (reset) reset();
      return raw;
    },
  };
}

function outputSelection(withLayout) {
  const contractOutputs = withLayout
    ? [...PAIRS.outputSelection.hostContractOutputs, PAIRS.outputSelection.pluginAddition]
    : [...PAIRS.outputSelection.hostContractOutputs];
  return { '*': { '': ['ast'], '*': contractOutputs } };
}

function compileText(solc, sourceKey, content, withLayout) {
  const input = {
    language: 'Solidity',
    sources: { [sourceKey]: { content } },
    settings: { outputSelection: outputSelection(withLayout) },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const hard = (output.errors || []).filter(e => e.severity !== 'warning');
  if (hard.length > 0) {
    throw new Error(hard[0].formattedMessage || hard[0].message);
  }
  return { input, output };
}

function compilePairSide(solc, source, withLayout) {
  return compileText(
    solc,
    PAIRS.sourceKey,
    PAIRS.pragma + source,
    withLayout,
  );
}

function main() {
  if (!fs.existsSync(SOLJSON)) {
    console.error(`no compiler at ${SOLJSON} — nothing generated.`);
    process.exit(2);
  }
  const solc = wrap(createRequire(__filename)(SOLJSON));
  const longVersion = solc.version();
  if (longVersion !== PAIRS.compiler.longVersion) {
    console.error(
      `compiler is ${longVersion}, pairs record ${PAIRS.compiler.longVersion}`,
    );
    process.exit(3);
  }

  const corpus = {
    generatedFrom: 'test/fixtures/upgrade-pairs.json',
    solcLongVersion: longVersion,
    solcVersion: PAIRS.compiler.version,
    sourceKey: PAIRS.sourceKey,
    contract: PAIRS.contract,
    pairs: {},
    standalone: {},
  };

  let compiles = 0;
  for (const pair of PAIRS.pairs) {
    const entry = { astOnly: {}, slotLevel: undefined };
    for (const side of ['before', 'after']) {
      entry.astOnly[side] = compilePairSide(solc, pair[side], false);
      compiles += 1;
    }
    if (SLOT_LEVEL_PAIRS.has(pair.id)) {
      entry.slotLevel = {};
      for (const side of ['before', 'after']) {
        entry.slotLevel[side] = compilePairSide(solc, pair[side], true);
        compiles += 1;
      }
    }
    corpus.pairs[pair.id] = entry;
    console.log(
      `  ${pair.id.padEnd(24)} ast-only${entry.slotLevel ? ' + slot-level' : ''}`,
    );
  }

  for (const [id, spec] of Object.entries(PAIRS.standalone)) {
    if (id.startsWith('_')) continue;
    corpus.standalone[id] = {
      contract: spec.contract,
      sourceKey: spec.sourceKey,
      astOnly: compileText(solc, spec.sourceKey, spec.source, false),
      slotLevel: compileText(solc, spec.sourceKey, spec.source, true),
    };
    compiles += 2;
    console.log(`  ${id.padEnd(24)} standalone, both selections`);
  }

  const target = path.join(HERE, 'ladder-corpus.json');
  fs.writeFileSync(target, `${JSON.stringify(corpus, null, 1)}\n`);
  console.log(
    `\n${compiles} compiles -> ${path.basename(target)} ` +
      `(${(fs.statSync(target).size / 1024).toFixed(0)} KiB)`,
  );
}

main();
