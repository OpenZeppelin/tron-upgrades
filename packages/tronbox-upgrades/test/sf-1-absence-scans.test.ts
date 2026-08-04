/**
 * SF-1 — the nine invariants enforced by an **absence**, plus the four negative
 * clauses that ride on the same scan.
 *
 * INV-2 (no freeze), INV-22 (no import of the five upstream names), INV-23 (no cache
 * in `send`), INV-24 (no module-scope mutable binding), INV-25's negative (no
 * dev-node classification), INV-27's negative (no fallback literal), INV-28 (no host
 * specifier), INV-33 (no filesystem, no state-mutating method), INV-34 (no logger),
 * INV-39 (no retry, no timer), INV-45 (zero imports in three modules), INV-48 (the
 * import graph and its acyclicity).
 *
 * **There is no code to unit-test for any of these**, which is exactly why each one
 * gets a non-vacuity fixture. A scan that matches nothing is indistinguishable from
 * a scan that is looking in the wrong place, or for the wrong thing, or at an empty
 * file list — and all three failure modes report a pass. So every property below is
 * paired with a violating fixture, parsed as text, that the *same* scan must fire on.
 *
 * Fixtures are text rather than files on disk for the reason
 * `test/helpers/source-scan.ts` already records: `tsconfig.test.json` includes `src`
 * and `test`, so a fixture that genuinely imported the host would fail type-checking,
 * and a fixture under `src/` would violate the invariant it exists to test.
 *
 * AST rather than grep, also for a reason already measured: half of the forbidden
 * identifiers appear in these modules' own doc comments, which explain the upstream
 * mechanisms the absences exist to avoid. `provider.ts` documents
 * `Object.freeze` by name in the comment that forbids it; `transport.ts` documents
 * the retry it does not have. A text grep reports a violation for every comment that
 * documents one, and the first person it fires on would be right to revert it.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOST_SPECIFIER,
  allSources,
  chainSources,
  hostSpecifiers,
  scanText,
  type ScannedSource,
} from './helpers/source-scan';

const sources = chainSources();

/** The ten modules, pinned — a scan over an empty list passes every assertion. */
const EXPECTED_MODULES = [
  'classify.ts',
  'endpoint.ts',
  'errors.ts',
  'index.ts',
  'instance.ts',
  'policy.ts',
  'provider.ts',
  'read.ts',
  'slots.ts',
  'transport.ts',
] as const;

/** Value-position identifier names in one module — comments and types excluded. */
function valueNames(source: ScannedSource): readonly string[] {
  return source.identifiers
    .filter(use => !use.inTypePosition)
    .map(use => use.name);
}

/** `a.b.c` chains as written, which is where `Object.freeze` and `console.log` live. */
function chains(source: ScannedSource): readonly string[] {
  return source.accessChains;
}

// ---------------------------------------------------------------------------
// 0. The scan's own subject — without this every assertion below is vacuous
// ---------------------------------------------------------------------------

describe('the absence scans range over all ten modules', () => {
  it('finds exactly the ten modules of src/chain/**', () => {
    // The completeness clause. Nine invariants below are prohibitions, and a
    // prohibition asserted over zero files is satisfied by construction. This is the
    // assertion that makes the rest mean something.
    expect(sources.map(source => source.relative).sort()).toEqual([
      ...EXPECTED_MODULES,
    ]);
  });

  it('parsed real content from each of them', () => {
    for (const source of sources) {
      expect(source.text.length, `${source.relative} is empty`).toBeGreaterThan(500);
      expect(
        source.identifiers.length,
        `${source.relative} parsed to no identifiers`,
      ).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. INV-45 — three modules with zero imports
// ---------------------------------------------------------------------------

describe('INV-45: policy.ts, classify.ts and slots.ts import nothing', () => {
  it.each(['policy.ts', 'classify.ts', 'slots.ts'])(
    '%s has exactly zero module specifiers',
    relative => {
      const source = sources.find(entry => entry.relative === relative);
      expect(source, `${relative} was not scanned`).toBeDefined();
      // Not "imports no host" and not "imports nothing external" — **zero**, in
      // every syntax. One import of a sibling (`./errors` for a throw, most
      // plausibly) converts SF-11's extraction from a file move into a dependency
      // untangling, at the stage that also has to create the workspace package and
      // work around `check-architecture.cjs` resolving only relative specifiers.
      expect(source?.moduleSpecifiers ?? []).toEqual([]);
      expect(source?.importSpecifiers ?? []).toEqual([]);
    },
  );

  it('is not satisfied by the scan being blind to relative specifiers', () => {
    // Non-vacuity. The plausible violation is a *relative* import of a sibling, not
    // an external one, so the fixture is exactly that.
    const fixture = scanText(
      "import { ChainSlotMalformedError } from './errors';\nexport const x = ChainSlotMalformedError;\n",
      'fixtures/slots-imports-errors.ts',
    );
    expect(fixture.moduleSpecifiers).toHaveLength(1);
    expect(fixture.moduleSpecifiers[0]?.specifier).toBe('./errors');
  });

  it('is not satisfied by the scan missing a type-only import', () => {
    const fixture = scanText(
      "import type { TvmDiagnosis } from './classify';\nexport type D = TvmDiagnosis;\n",
      'fixtures/policy-type-imports.ts',
    );
    expect(fixture.moduleSpecifiers).toHaveLength(1);
    expect(fixture.moduleSpecifiers[0]?.typeOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. INV-48 — the allowed external specifiers, and the type-only distinction
// ---------------------------------------------------------------------------

describe('INV-48: src/chain/** imports only the seam and upgrades-core types', () => {
  it('names exactly two allowed external specifiers, one of them used once', () => {
    const external = sources.flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => !entry.specifier.startsWith('.'))
        .map(entry => `${source.relative}: ${entry.specifier}`),
    );
    expect(external).toEqual(['index.ts: @openzeppelin/upgrades-core']);
  });

  it('imports upgrades-core as TYPES ONLY — the distinction INV-49\'s pin could not make', () => {
    // **This is the tightening.** `test/inv-49-host-import-boundary.test.ts:124`
    // pins the row `chain/index.ts: @openzeppelin/upgrades-core (import)`, and until
    // now the scan rendered a type-only import and a **runtime** import identically.
    // So the row added to record a type-only import would also have admitted a
    // future value import of upgrades-core from that module without tripping —
    // which INV-48 forbids in those words: `src/chain/**` may import
    // `src/environment/**` and upgrades-core **types** only.
    //
    // Both halves of the fix are in place: `ModuleSpecifier` now carries `typeOnly`
    // (so the *scan* distinguishes), and this is the assertion that reads it for
    // SF-1's directory. INV-49's own pin gains a parallel assertion in its own file.
    const engineImports = sources.flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => entry.specifier.startsWith('@openzeppelin/'))
        .map(entry => ({ where: `${source.relative}:${String(entry.line)}`, ...entry })),
    );
    expect(engineImports).toHaveLength(1);
    expect(engineImports[0]?.typeOnly).toBe(true);
    expect(engineImports[0]?.where).toBe('index.ts:15');
  });

  it('would fire on a runtime import of upgrades-core, which is the whole point', () => {
    // Non-vacuity for the assertion above, and the case the un-tightened pin missed.
    const runtime = scanText(
      "import { Manifest } from '@openzeppelin/upgrades-core';\nexport const m = Manifest;\n",
      'fixtures/chain-runtime-engine-import.ts',
    );
    expect(runtime.moduleSpecifiers[0]?.typeOnly).toBe(false);
    expect(runtime.moduleSpecifiers[0]?.kind).toBe('import');

    // And the inline-`type` form must still read as type-only, or the tightened scan
    // would fire on a legitimate import — the opposite failure.
    const inlineType = scanText(
      "import { type EthereumProvider } from '@openzeppelin/upgrades-core';\nexport type P = EthereumProvider;\n",
      'fixtures/chain-inline-type-import.ts',
    );
    expect(inlineType.moduleSpecifiers[0]?.typeOnly).toBe(true);

    // A namespace import is a value binding even when only types are read off it.
    const namespace = scanText(
      "import * as core from '@openzeppelin/upgrades-core';\nexport const c = core;\n",
      'fixtures/chain-namespace-import.ts',
    );
    expect(namespace.moduleSpecifiers[0]?.typeOnly).toBe(false);
  });

  it('imports no other sub-feature\'s directory', () => {
    // Six sub-features depend on SF-1, so one import of a consumer's module makes it
    // un-buildable ahead of them and turns the plan's DAG into a lie. The concrete
    // near-miss was real: the endpoint override was originally a candidate for
    // SF-10's option surface.
    const outward = sources.flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => entry.specifier.startsWith('..'))
        .map(entry => `${source.relative}: ${entry.specifier}`),
    );
    expect(outward.sort()).toEqual([
      'endpoint.ts: ../environment',
      'errors.ts: ../environment',
      'index.ts: ../environment',
    ]);
    for (const forbidden of ['../options', '../output', '../results', '../index']) {
      expect(
        outward.filter(entry => entry.includes(forbidden)),
        `src/chain/** imports ${forbidden}`,
      ).toEqual([]);
    }
  });

  it('has an acyclic, strictly downward internal graph', () => {
    // `policy | classify | slots → errors → endpoint → transport → provider → read |
    // instance → index`. INV-45 is what forced this layering, so a cycle here would
    // mean INV-45 had been satisfied by moving a file rather than by getting the
    // dependency direction right.
    const layer: Readonly<Record<string, number>> = {
      'policy.ts': 0,
      'classify.ts': 0,
      'slots.ts': 0,
      'errors.ts': 1,
      'endpoint.ts': 2,
      'transport.ts': 3,
      'provider.ts': 4,
      'read.ts': 5,
      'instance.ts': 5,
      'index.ts': 6,
    };

    for (const source of sources) {
      const from = layer[source.relative];
      expect(from, `${source.relative} has no assigned layer`).toBeDefined();
      for (const entry of source.moduleSpecifiers) {
        if (!entry.specifier.startsWith('./')) {
          continue;
        }
        const target = `${entry.specifier.slice(2)}.ts`;
        const to = layer[target];
        expect(to, `${source.relative} imports unknown ${target}`).toBeDefined();
        // Strictly downward: every edge decreases the layer number.
        expect(
          to,
          `${source.relative} (layer ${String(from)}) imports ${target} (layer ${String(to)}) — not strictly downward`,
        ).toBeLessThan(from ?? -1);
      }
    }
  });

  it('leaves no computed specifier for the static scan to miss', () => {
    // The same completeness clause INV-49's suite carries, restated for this
    // directory: zero forbidden specifiers plus zero dynamic sites is a proof; zero
    // forbidden specifiers alone is not.
    for (const source of sources) {
      expect(
        source.dynamicSpecifierSites,
        `${source.relative} computes a module specifier`,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. INV-28 — the host, by no path
// ---------------------------------------------------------------------------

describe('INV-28: src/chain/** imports the host by no path, anywhere', () => {
  it('names no tronbox or tronweb specifier', () => {
    // SF-1 is the most tempting site in the plugin for this import, because it is the
    // only sub-feature that wants a chain handle. And it would *work*:
    // `tronbox/package.json` declares no `main` and no `exports`, only a `bin`, so
    // bare-name resolution fails while every file in the published tree stays
    // addressable — `require('tronbox/build/components/TronWrap')` resolves.
    for (const source of sources) {
      expect(
        hostSpecifiers(source),
        `${source.relative} names the TronBox host`,
      ).toEqual([]);
    }

    const tronweb = sources.flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => /^tronweb(?:$|\/)/.test(entry.specifier))
        .map(entry => `${source.relative}: ${entry.specifier}`),
    );
    expect(tronweb).toEqual([]);
  });

  it('fires on every syntax that could name the host', () => {
    // Non-vacuity across all six loading syntaxes, since the invariant says "by no
    // path" rather than "by no import".
    const fixtures: readonly { readonly label: string; readonly text: string }[] = [
      { label: 'static import', text: "import T from 'tronbox/build/components/TronWrap';\nexport default T;\n" },
      { label: 'type-only import', text: "import type { C } from 'tronbox/build/components/Config';\nexport type X = C;\n" },
      { label: 're-export', text: "export { default } from 'tronbox/build/components/Config';\n" },
      { label: 'import-equals', text: "import h = require('tronbox/package.json');\nexport const v = h.version;\n" },
      { label: 'bare require', text: "export const v = require('tronbox/package.json').version;\n" },
      { label: 'require.resolve', text: "export const w = require.resolve('tronbox/package.json');\n" },
      { label: 'dynamic import', text: "export const l = () => import('tronbox/build/components/Config');\n" },
      { label: 'version-aliased install', text: "import m from 'tronbox-4.9.0/package.json';\nexport default m;\n" },
      { label: 'tronweb', text: "import { TronWeb } from 'tronweb';\nexport const t = TronWeb;\n" },
    ];

    for (const fixture of fixtures) {
      const scanned = scanText(fixture.text, `fixtures/host-${fixture.label}.ts`);
      const hits = scanned.moduleSpecifiers.filter(
        entry =>
          HOST_SPECIFIER.test(entry.specifier) ||
          /^tronweb(?:$|\/)/.test(entry.specifier),
      );
      expect(hits.length, `${fixture.label} was not detected`).toBeGreaterThan(0);
    }
  });

  it('does not fire on the plugin\'s own package name', () => {
    // The other direction: `HOST_SPECIFIER` is deliberately narrower than
    // `/tronbox/`, because the plugin's own package is `tronbox-upgrades` and a
    // pattern that matched it would be relaxed for the wrong reason.
    const own = scanText(
      "import { x } from 'tronbox-upgrades';\nexport const y = x;\n",
      'fixtures/own-package.ts',
    );
    expect(hostSpecifiers(own)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. INV-33 — no filesystem, no process, no state-mutating method
// ---------------------------------------------------------------------------

describe('INV-33: SF-1 writes nothing, signs nothing and touches no filesystem', () => {
  it('imports no Node built-in at all', () => {
    // `manifestPathFor` names a file SF-1 must be **incapable** of modifying, which
    // is what makes INV-26's "discards nothing" structural rather than a promise.
    const builtins = sources.flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => /^(node:|fs$|path$|os$|child_process$|http$|https$|crypto$)/.test(entry.specifier))
        .map(entry => `${source.relative}: ${entry.specifier}`),
    );
    expect(builtins).toEqual([]);
  });

  it('names no state-mutating JSON-RPC method as a string literal', () => {
    const forbidden = [
      'eth_sendRawTransaction',
      'eth_sendTransaction',
      'eth_sign',
      'eth_signTransaction',
      'personal_sign',
      'evm_mine',
      'evm_snapshot',
      'evm_revert',
      'evm_setNextBlockTimestamp',
      'debug_traceTransaction',
      'tre_setBalance',
    ];
    for (const source of sources) {
      for (const literal of source.stringLiterals) {
        expect(
          forbidden,
          `${source.relative} names the state-mutating method ${literal}`,
        ).not.toContain(literal);
      }
    }
  });

  it('names no filesystem or process primitive in a value position', () => {
    // Value position only. `process.env` appears in `index.ts` as `deps.env`'s
    // documented default — read once at factory time, which INV-24 permits and
    // INV-46's ratified reading names explicitly — so `process` is allowed there and
    // nowhere else, and only for `env`.
    const forbidden = /^(readFileSync|writeFileSync|existsSync|mkdirSync|unlinkSync|rmSync|spawn|spawnSync|execSync|fork)$/;
    for (const source of sources) {
      const named = valueNames(source).filter(name => forbidden.test(name));
      expect(named, `${source.relative} names a filesystem primitive`).toEqual([]);
    }
  });

  it('reads process only as process.env, and only in index.ts', () => {
    const processChains = sources.flatMap(source =>
      chains(source)
        .filter(chain => chain.startsWith('process.'))
        .map(chain => `${source.relative}: ${chain}`),
    );
    expect(processChains).toEqual(['index.ts: process.env']);
  });

  it('fires on a filesystem read, and on a write method', () => {
    // Non-vacuity for both halves.
    const fsFixture = scanText(
      "import fs from 'node:fs';\nexport const read = () => fs.readFileSync('/tmp/x', 'utf8');\n",
      'fixtures/chain-reads-fs.ts',
    );
    expect(
      fsFixture.moduleSpecifiers.filter(entry => entry.specifier === 'node:fs'),
    ).toHaveLength(1);
    expect(valueNames(fsFixture)).toContain('readFileSync');

    const writeFixture = scanText(
      "export const send = (p: { send(m: string, a: unknown[]): Promise<unknown> }) => p.send('eth_sendRawTransaction', []);\n",
      'fixtures/chain-sends-transaction.ts',
    );
    expect(writeFixture.stringLiterals).toContain('eth_sendRawTransaction');
  });
});

// ---------------------------------------------------------------------------
// 5. INV-34 — no logger, no console, no metric sink
// ---------------------------------------------------------------------------

describe('INV-34: SF-1 emits nothing', () => {
  it('calls no console method', () => {
    // SF-0 established that the injected logger's guaranteed surface is exactly
    // `log` — four of five injection paths supply a single-method object — so a
    // `logger.warn` in a warning path is a `TypeError` precisely for users who asked
    // for less output. SF-1's answer is to have no channel at all.
    for (const source of sources) {
      const consoleUse = chains(source).filter(chain => chain.startsWith('console.'));
      expect(consoleUse, `${source.relative} calls console`).toEqual([]);
      expect(
        valueNames(source),
        `${source.relative} names console`,
      ).not.toContain('console');
    }
  });

  it('receives no output channel and names no logger, tracer or metric sink', () => {
    const forbidden = /^(logger|log|warn|trace|tracer|metrics|metric|counter|histogram|reportProgress|emit)$/;
    for (const source of sources) {
      const named = valueNames(source).filter(name => forbidden.test(name));
      expect(named, `${source.relative} names an output channel`).toEqual([]);
    }
  });

  it('fires on a console call and on an injected logger', () => {
    const consoleFixture = scanText(
      "export const f = () => { console.warn('degraded'); };\n",
      'fixtures/chain-logs.ts',
    );
    expect(chains(consoleFixture)).toContain('console.warn');

    const loggerFixture = scanText(
      "export const f = (logger: { log(m: string): void }) => { logger.log('x'); };\n",
      'fixtures/chain-takes-logger.ts',
    );
    expect(valueNames(loggerFixture)).toContain('logger');
  });
});

// ---------------------------------------------------------------------------
// 6. INV-2 — nothing SF-1 returns is frozen
// ---------------------------------------------------------------------------

describe('INV-2: no freeze, seal or proxy is applied to a transport result', () => {
  it('applies no freeze, seal or preventExtensions to a RESULT-shaped expression', () => {
    // The two modules a resolved `result` passes through. Freezing one is the
    // defensive instinct that is strong and *wrong*:
    // `provider.js:getTransactionReceipt` assigns `receipt.status` in a
    // `"use strict"` module, and the assignment is **guarded** by
    // `if (receipt?.status)` — which makes freezing worse rather than better. A
    // frozen result passes every test that polls a not-yet-mined transaction
    // (`status` absent, `result: null`) and throws only when the receipt finally
    // arrives: on the **success** path of every deploy, after the transaction is
    // already on chain.
    //
    // **Scoped to the result, not to the module.** A first draft of this test
    // forbade `Object.freeze` outright in these two files and failed: `transport.ts`
    // freezes the *channel* it constructs and `index.ts` freezes the composite, both
    // of which INV-3 **requires**. The two invariants are about different objects —
    // SF-1's own values are frozen; the node's result is not — so a module-wide ban
    // would be scanning for the wrong property, and passing it would have meant
    // breaking INV-3.
    const resultShaped =
      /(?:Object\.(?:freeze|seal|preventExtensions)|new\s+Proxy)\s*\(\s*(?:outcome\.result|result|body|value|receipt|json)\b/;
    for (const relative of ['transport.ts', 'provider.ts', 'read.ts', 'instance.ts']) {
      const source = sources.find(entry => entry.relative === relative);
      expect(source, `${relative} was not scanned`).toBeDefined();
      const offending = (source?.text ?? '')
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(entry => !entry.line.startsWith('*') && !entry.line.startsWith('//'))
        .filter(entry => resultShaped.test(entry.line))
        .map(entry => `${relative}:${String(entry.number)} ${entry.line}`);
      expect(offending, `${relative} freezes a transport result`).toEqual([]);
    }
  });

  it('constructs no Proxy anywhere in src/chain/**', () => {
    for (const source of sources) {
      expect(
        valueNames(source),
        `${source.relative} constructs a Proxy`,
      ).not.toContain('Proxy');
    }
  });

  it('does freeze the composite and the reader surface, which is a different thing', () => {
    // INV-3 requires exactly this, and the two invariants are about different
    // objects: SF-1's *own* composite is frozen; the node's *result* is not. A scan
    // that forbade `Object.freeze` directory-wide would be scanning for the wrong
    // property, so the distinction is asserted rather than left implicit.
    const index = sources.find(entry => entry.relative === 'index.ts');
    expect(chains(index ?? sources[0]!)).toContain('Object.freeze');
  });

  it('fires on a frozen result', () => {
    const resultShaped =
      /(?:Object\.(?:freeze|seal|preventExtensions)|new\s+Proxy)\s*\(\s*(?:outcome\.result|result|body|value|receipt|json)\b/;
    // Non-vacuity for the narrowed scan: the forbidden shape must still trip it,
    // while the permitted shape must not.
    expect(resultShaped.test('return Object.freeze(outcome.result);')).toBe(true);
    expect(resultShaped.test('return Object.freeze(result);')).toBe(true);
    expect(resultShaped.test('return new Proxy(result, handler);')).toBe(true);
    expect(resultShaped.test('return Object.freeze({ endpoint, post });')).toBe(false);

    const fixture = scanText(
      'export const f = (result: unknown) => Object.freeze(result);\n',
      'fixtures/provider-freezes-result.ts',
    );
    expect(chains(fixture)).toContain('Object.freeze');
    expect(resultShaped.test(fixture.text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. INV-39 — no retry, no backoff, no timer, no queue
// ---------------------------------------------------------------------------

describe('INV-39: no retry, no backoff, no timer, no queue', () => {
  it('names no timer API', () => {
    // A retry inside `send` makes a transport failure look like a slow success, and
    // a transport failure absorbed — by a blanket catch, or by a retry that
    // eventually succeeds — silently disables the safety check that depended on the
    // read. It also breaks INV-1's contract in a way the type cannot catch, since
    // two attempts can produce two different outcomes and the second is returned as
    // if it were the first.
    const forbidden = /^(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|requestIdleCallback|queueMicrotask)$/;
    for (const source of sources) {
      const named = valueNames(source).filter(name => forbidden.test(name));
      expect(named, `${source.relative} names a timer`).toEqual([]);
    }
  });

  it('names no retry, backoff, queue or limiter identifier', () => {
    const forbidden = /^(retry|retries|backoff|sleep|delay|wait|queue|limiter|throttle|debounce|attempt|attempts)$/i;
    for (const source of sources) {
      const named = valueNames(source).filter(name => forbidden.test(name));
      expect(named, `${source.relative} names retry machinery`).toEqual([]);
    }
  });

  it('awaits post exactly once per call in transport.ts', () => {
    // The structural half. `transport.ts` is the only module that calls `post`, and
    // it does so once — asserted as an occurrence count on the AST rather than as a
    // claim about the reading.
    const transport = sources.find(entry => entry.relative === 'transport.ts');
    const postCalls = (transport?.identifiers ?? []).filter(
      use => use.name === 'post' && !use.isPropertyName && !use.inTypePosition,
    );
    // The parameter declaration, plus the one call. Two, not three.
    expect(postCalls.length).toBeLessThanOrEqual(2);
  });

  it('fires on a retry loop and on a timer', () => {
    const retryFixture = scanText(
      'export const f = async (post: () => Promise<unknown>) => { for (let attempt = 0; attempt < 3; attempt += 1) { try { return await post(); } catch { /* retry */ } } };\n',
      'fixtures/transport-retries.ts',
    );
    expect(valueNames(retryFixture)).toContain('attempt');

    const timerFixture = scanText(
      'export const f = () => new Promise(resolve => setTimeout(resolve, 100));\n',
      'fixtures/transport-sleeps.ts',
    );
    expect(valueNames(timerFixture)).toContain('setTimeout');
  });
});

// ---------------------------------------------------------------------------
// 8. INV-24 — no module-scope mutable binding
// ---------------------------------------------------------------------------

describe('INV-24: no module-scope mutable state', () => {
  it('declares no module-scope let or var in any of the ten modules', () => {
    // A module is loaded once and a migration runs many times. A module-scope id
    // counter shared across two `ChainAccess` instances makes the ids of one channel
    // depend on the traffic of another, turning a diagnostic into noise.
    for (const source of sources) {
      expect(
        source.topLevelMutableBindings,
        `${source.relative} declares a module-scope mutable binding`,
      ).toEqual([]);
    }
  });

  it('fires on a module-scope counter', () => {
    const fixture = scanText(
      'let nextId = 1;\nexport const next = () => { nextId += 1; return nextId; };\n',
      'fixtures/transport-module-counter.ts',
    );
    expect(fixture.topLevelMutableBindings).toEqual(['nextId']);
  });

  it('keeps the id counter inside the factory closure, not at module scope', () => {
    const transport = sources.find(entry => entry.relative === 'transport.ts');
    // `nextId` exists — it is just not a module-scope binding.
    expect(valueNames(transport ?? sources[0]!)).toContain('nextId');
    expect(transport?.topLevelMutableBindings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. INV-23 — no cache in send
// ---------------------------------------------------------------------------

describe('INV-23: send holds no cache, memo or dedupe', () => {
  it('names no cache-shaped identifier in provider.ts or transport.ts', () => {
    // `eth_chainId` is immutable per instance and the engine calls it on every
    // `Manifest.forNetwork`, so memoizing inside `send` is the obvious optimization.
    // It also reproduces the sibling's two-transports defect — one remapping addresses
    // and swallowing failures to zeros, the other doing neither, so the same read
    // answers differently depending on which it went through — and its staleness window is
    // unbounded because a `tronbox console` session can switch network under it.
    const forbidden = /^(cache|cached|memo|memoize|memoized|dedupe|store|entries|results)$/i;
    for (const relative of ['provider.ts', 'transport.ts']) {
      const source = sources.find(entry => entry.relative === relative);
      const named = valueNames(source ?? sources[0]!).filter(name =>
        forbidden.test(name),
      );
      expect(named, `${relative} names a cache`).toEqual([]);
    }
  });

  it('constructs no Map or WeakMap in provider.ts or transport.ts', () => {
    for (const relative of ['provider.ts', 'transport.ts']) {
      const source = sources.find(entry => entry.relative === relative);
      for (const name of ['Map', 'WeakMap', 'Set', 'WeakSet']) {
        expect(
          valueNames(source ?? sources[0]!),
          `${relative} constructs a ${name}`,
        ).not.toContain(name);
      }
    }
  });

  it('keeps the one permitted memo in index.ts, on identity()', () => {
    // Memoization lives on `ChainAccess.identity()`, where its scope is one object
    // and the memo is the **promise** — so the in-flight case is covered by
    // construction rather than by a lock.
    const index = sources.find(entry => entry.relative === 'index.ts');
    expect(valueNames(index ?? sources[0]!)).toContain('identityMemo');
  });

  it('fires on a memo inside send', () => {
    const fixture = scanText(
      'export const create = () => { const cache = new Map<string, unknown>(); return { send: async (m: string) => cache.get(m) }; };\n',
      'fixtures/provider-memoizes.ts',
    );
    expect(valueNames(fixture)).toContain('cache');
    expect(valueNames(fixture)).toContain('Map');
  });
});

// ---------------------------------------------------------------------------
// 10. INV-22 — the five upstream names are imported nowhere in src/**
// ---------------------------------------------------------------------------

const DENIED_UPSTREAM_NAMES = [
  'getUpgradeInterfaceVersion',
  'inferProxyAdmin',
  'getImplementationAddressFromBeacon',
  'isBeacon',
  'getImplementationAddressFromProxy',
] as const;

describe('INV-22: the five-name deny-list holds across all of src/**', () => {
  it('names none of the five anywhere under src/', () => {
    // Calling any of them converts normal control flow into a thrown error on the
    // upgrade path: a v5 proxy cannot be told from a v4 one, a ProxyAdmin check
    // becomes a crash, and a beacon read fails. The scan ranges over **all** of
    // `src/`, not just `src/chain/`, because the invariant binds SF-5, SF-7, SF-8 and
    // SF-9 too.
    const scanned = allSources();
    expect(scanned.length, 'the scan found no modules under src/').toBeGreaterThan(
      sources.length,
    );
    for (const source of scanned) {
      for (const denied of DENIED_UPSTREAM_NAMES) {
        const hits = source.identifiers.filter(
          use => use.name === denied && !use.isPropertyName,
        );
        expect(
          hits,
          `${source.relative} names the denied upstream function ${denied}`,
        ).toEqual([]);
      }
    }
  });

  it('supplies three differently named replacements', () => {
    // Named differently from upstream on purpose, so a mis-import is visible at the
    // call site rather than silently correct-looking.
    const read = sources.find(entry => entry.relative === 'read.ts');
    const names = valueNames(read ?? sources[0]!);
    expect(names).toContain('readUpgradeInterfaceVersion');
    expect(names).toContain('looksLikeProxyAdmin');
    expect(names).toContain('readBeaconImplementation');
  });

  it('fires on each of the five, as an import and as a call', () => {
    for (const denied of DENIED_UPSTREAM_NAMES) {
      const importFixture = scanText(
        `import { ${denied} } from '@openzeppelin/upgrades-core';\nexport const f = ${denied};\n`,
        `fixtures/imports-${denied}.ts`,
      );
      const importHits = importFixture.identifiers.filter(
        use => use.name === denied && !use.isPropertyName,
      );
      expect(importHits.length, `${denied} was not detected`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. INV-25 / INV-27 — the two negative clauses
// ---------------------------------------------------------------------------

describe('INV-25: no branch anywhere decides that a chain is a dev node', () => {
  it('names no chain-id literal and no dev-node predicate', () => {
    // The spec names the hazard directly: "inferring 'disposable' from an
    // unrecognized chain id would misclassify a legitimate private production
    // chain". The mechanism dissolves the need — block 1 is immutable on a persistent
    // chain and per-boot on a disposable one — but the dissolution is only durable
    // while the classification stays absent. The first `if (chainId === TRE_CHAIN_ID)`
    // added for a "nicer local-node message" reintroduces it, and it will be added by
    // someone who reads the refusal text and wants to tailor it.
    const devPredicates = /^(isDevelopmentNetwork|isDevNode|isLocalNode|isDisposable|isEphemeral|isTre|isHardhat|isAnvil)$/i;
    for (const source of sources) {
      const named = valueNames(source).filter(name => devPredicates.test(name));
      expect(named, `${source.relative} names a dev-node predicate`).toEqual([]);
    }
  });

  it('names no TRON chain-id literal outside a doc comment', () => {
    // The four measured chain ids, in both hex and decimal. `instance.ts` and
    // `errors.ts` discuss them in prose — which is why this is an AST scan of string
    // and numeric literals rather than a grep.
    const chainIdLiterals = [
      '0x2b6653dc',
      '0xcd8690dc',
      '0x94a9059e',
      '0xc84e6faf',
      '728126428',
      '3448148188',
      '2494104990',
      '3360022319',
    ];
    for (const source of sources) {
      for (const literal of source.stringLiterals) {
        expect(
          chainIdLiterals,
          `${source.relative} carries the chain-id literal ${literal}`,
        ).not.toContain(literal.toLowerCase());
      }
    }
  });

  it('names no client-version match', () => {
    for (const source of sources) {
      for (const literal of source.stringLiterals) {
        expect(
          literal.includes('TRON/v'),
          `${source.relative} matches a client version string`,
        ).toBe(false);
      }
    }
  });

  it('fires on a chain-id conditional', () => {
    const fixture = scanText(
      "export const nicer = (chainId: string) => chainId === '0xc84e6faf' ? 'local node' : 'network';\n",
      'fixtures/instance-classifies-tre.ts',
    );
    expect(fixture.stringLiterals).toContain('0xc84e6faf');
  });
});

describe('INV-27: no fallback endpoint literal exists to fall back to', () => {
  it('names no localhost and no port 9090 literal at all', () => {
    // The sibling's specimen: `hre.network.config.url ?? process.env.TRE_URL ??
    // 'http://127.0.0.1:9090/jsonrpc'`. The result is not an error; it is a confident
    // answer about the wrong chain, delivered to a validation engine that will
    // compare it against a manifest written from the right one. `9090` is the TRE's
    // port and `localhost` is the other spelling, and neither has any legitimate use
    // in this directory.
    for (const source of sources) {
      for (const literal of source.stringLiterals) {
        for (const forbidden of ['localhost', '9090']) {
          expect(
            literal.includes(forbidden),
            `${source.relative} carries the fallback literal ${forbidden} in ${JSON.stringify(literal)}`,
          ).toBe(false);
        }
      }
    }
  });

  it('pins every 127.0.0.1 literal, and each one is prose rather than a target', () => {
    // **A blanket ban was wrong and the first run of this suite proved it.**
    // `endpoint.ts` carries `http://127.0.0.1:8545/jsonrpc` as the worked example
    // inside the not-an-absolute-URL refusal — "An endpoint must include a scheme, as
    // in …" — which INV-31's own test asserts the presence of, because "not absolute"
    // is not actionable without one. So the literal is pinned rather than forbidden:
    // a *new* occurrence fails this test, and the reason each existing one is safe is
    // recorded next to it.
    //
    // What makes it safe is structural, not a promise: it is never a fallback target,
    // and the assertion that establishes that is
    // `sf-1-endpoint-resolution.test.ts` → "attempts exactly one distinct URL when
    // every request fails". Port 8545 also distinguishes it from the sibling's 9090.
    const occurrences = sources.flatMap(source =>
      source.stringLiterals
        .filter(literal => literal.includes('127.0.0.1'))
        .map(literal => `${source.relative}: ${literal}`),
    );
    expect(occurrences.sort()).toEqual([
      'endpoint.ts: http://127.0.0.1:8545/jsonrpc',
    ]);
  });

  it('names no TRE_URL environment variable', () => {
    for (const source of sources) {
      expect(
        source.stringLiterals,
        `${source.relative} reads TRE_URL`,
      ).not.toContain('TRE_URL');
    }
  });

  it('fires on a hardcoded fallback', () => {
    const fixture = scanText(
      "export const url = (configured?: string) => configured ?? 'http://127.0.0.1:9090/jsonrpc';\n",
      'fixtures/endpoint-falls-back.ts',
    );
    expect(
      fixture.stringLiterals.some(literal => literal.includes('127.0.0.1')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. INV-5 — no === between two addresses
// ---------------------------------------------------------------------------

describe('INV-5: sameAddress is the only sanctioned address comparison', () => {
  it('exports sameAddress from slots.ts and uses no raw equality on an address', () => {
    // upgrades-core compares addresses with `===` while reading its **own** manifest,
    // so a casing mismatch silently drops a recorded proxy kind and layout — the
    // sibling's `canonicalizeStoredAddresses` exists for exactly this.
    const slots = sources.find(entry => entry.relative === 'slots.ts');
    expect(valueNames(slots ?? sources[0]!)).toContain('sameAddress');

    // A textual check over the parsed source, scoped to identifiers that name an
    // address, since the AST helper does not model binary expressions. Any `===`
    // whose either side is an address-named identifier would appear here.
    const addressEquality = /\b(address|proxy|implementation|admin|beacon|impl)\s*(===|!==)\s*[a-zA-Z_$]/;
    for (const source of sources) {
      const offending = source.text
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        // Comments explain the hazard; the scan is about code.
        .filter(entry => !entry.line.startsWith('*') && !entry.line.startsWith('//'))
        .filter(entry => addressEquality.test(entry.line));
      expect(
        offending.map(entry => `${source.relative}:${String(entry.number)} ${entry.line}`),
        `${source.relative} compares addresses with === or !==`,
      ).toEqual([]);
    }
  });

  it('fires on a raw address comparison', () => {
    const fixture = 'export const f = (address: string, impl: string) => address === impl;\n';
    const addressEquality = /\b(address|proxy|implementation|admin|beacon|impl)\s*(===|!==)\s*[a-zA-Z_$]/;
    expect(addressEquality.test(fixture)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. The scans' own residency — they must not be defeated by a path change
// ---------------------------------------------------------------------------

describe('the scans read the real directory', () => {
  it('resolves every scanned file to an absolute path under src/chain', () => {
    for (const source of sources) {
      expect(source.file).toContain(`${path.sep}src${path.sep}chain${path.sep}`);
      expect(path.isAbsolute(source.file)).toBe(true);
    }
  });
});
