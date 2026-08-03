import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEnvironment } from '../src/environment';
import {
  DEPLOY_PARAMETER_FEE_LIMIT,
  DEPLOY_PARAMETER_ORIGIN_ENERGY_LIMIT,
  DEPLOY_PARAMETER_USER_FEE_PERCENTAGE,
  SENTINEL_PRIVATE_KEY,
} from './helpers/config-fixtures';
import { handles } from './helpers/handles';
import {
  ownEnumerableRoutes,
  shallowestRouteDepth,
} from './helpers/introspect';
import {
  repoRoot,
  tronBoxIsInstalled,
  tronBoxRoot,
  tronBoxVersionsUnderTest,
} from './helpers/locate';

/**
 * Real-host suites — the facts the fixtures stand in for, pinned against the
 * installed TronBox trees.
 *
 * Every other file in this suite drives plain-object fixtures, which is what
 * INV-43 exists to make possible. The cost of that is a fixture that can drift
 * from the tool without anything failing. This file is the drift canary: it asks
 * the real `Config`, `Deployer` and `Resolver` the same questions the fixtures
 * answer, on **both** supported minors, so a fact that changes upstream fails here
 * loudly rather than surfacing later as a behavioural bug.
 *
 * It also promotes `evidence/probes.js` — the executable evidence behind SF-0
 * Research's ⚗ claims — to a test case, which that file's own header asks for
 * ("Promote these to vitest cases at the Tests stage").
 *
 * Scope note: the facts pinned below are the ones *this stage's* four invariant
 * categories rest on — INV-31/35/40/43/44/45's host premises. The probe spawn
 * covers the rest of the research claims wholesale, including the ones belonging
 * to categories other files own.
 *
 * Both guards are graceful skips rather than failures. The TronBox trees are
 * devDependencies of the workspace root, and `evidence/probes.js` lives in the
 * artifacts tree, which is a separate repository — so a checkout of the code repo
 * alone legitimately has neither.
 */

const PROBES = path.join(
  repoRoot,
  'artifacts',
  '001-tronbox-upgrades-plugin',
  'sf-0-tronbox-environment',
  'evidence',
  'probes.js',
);

const installedVersions = tronBoxVersionsUnderTest.filter(tronBoxIsInstalled);

interface HostConfig extends Record<string, unknown> {
  working_directory: string;
  networks: Record<string, unknown>;
  network: string;
  network_config: Record<string, unknown>;
  resolver?: unknown;
  with(overrides: Record<string, unknown>): Record<string, unknown>;
}

interface HostConfigModule {
  default(): HostConfig;
}

function hostModule<T>(installName: string, relative: string): T {
  const root = tronBoxRoot(installName);
  return createRequire(path.join(root, 'package.json'))(
    path.join(root, 'build', relative),
  ) as T;
}

/** A live `Config` carrying the sentinel key on the selected network. */
function liveConfig(installName: string): HostConfig {
  const Config = hostModule<HostConfigModule>(installName, 'components/Config');
  const config = Config.default();
  config.working_directory = '/proj';
  config.networks = {
    development: {
      network_id: '*',
      fullHost: 'http://127.0.0.1:9090',
      privateKey: SENTINEL_PRIVATE_KEY,
    },
  };
  config.network = 'development';
  return config;
}

/** Dotted paths at which `target` is reachable by own-enumerable traversal. */
function reachableAt(
  root: unknown,
  target: string,
  maxDepth: number,
): readonly string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, at: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    if (typeof node === 'string') {
      if (node === target) {
        found.push(at);
      }
      return;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      visit(value, at === '' ? key : `${at}.${key}`, depth + 1);
    }
  };
  visit(root, '', 0);
  return found;
}

describe.skipIf(installedVersions.length === 0)(
  'real TronBox: the host facts the fixtures stand in for',
  () => {
    it('has both supported minors installed side by side', () => {
      // Stated rather than assumed: a suite running against one version would pin
      // half the drift surface while reporting full coverage.
      expect([...installedVersions]).toEqual([...tronBoxVersionsUnderTest]);
    });

    describe.each(installedVersions)('%s', installName => {
      it('reports the version the install directory claims', () => {
        const manifest = hostModule<{ version: string }>(
          installName,
          '../package.json',
        );
        expect(installName).toContain(manifest.version);
      });

      it('classifies the two lineages by the working_directory descriptor', () => {
        // `config-lineage.ts:classifyBinding` inspects exactly this and nothing
        // else. `Config.prototype.addProp` defines every prop with
        // `Object.defineProperty(this, key, { get, set, enumerable: true })`, so on
        // a live Config the key is an own **accessor**; `Config.prototype.with` is
        // `_.extend({}, this.normalize(this), this.normalize(obj))` and `normalize`
        // copies by assignment, so on the snapshot it is an own **data property**.
        const config = liveConfig(installName);
        const live = Object.getOwnPropertyDescriptor(config, 'working_directory');
        expect(live).toBeDefined();
        expect(typeof live?.get).toBe('function');

        const snapshot = config.with({ reset: true });
        const snapshotDescriptor = Object.getOwnPropertyDescriptor(
          snapshot,
          'working_directory',
        );
        expect(snapshotDescriptor).toBeDefined();
        expect(typeof snapshotDescriptor?.get).not.toBe('function');
        expect(snapshotDescriptor?.value).toBe('/proj');
      });

      it('copies networks onto the snapshot by reference', () => {
        // What makes INV-16 implementable through *both* lineages: the snapshot's
        // `networks` is the same object as the live Config's, with the per-network
        // entries intact, so the source-of-truth check works either way.
        const config = liveConfig(installName);
        const snapshot = config.with({ reset: true });
        expect(snapshot.networks).toBe(config.networks);
      });

      it('substitutes deployParameters constants for the derived getters', () => {
        // The fixture defaults in `helpers/config-fixtures.ts`, pinned. These are
        // the values that make an unconfigured network read as a complete,
        // plausible, entirely fictional configuration — INV-16's whole reason.
        const config = liveConfig(installName);
        expect(config.feeLimit).toBe(DEPLOY_PARAMETER_FEE_LIMIT);
        expect(config.userFeePercentage).toBe(
          DEPLOY_PARAMETER_USER_FEE_PERCENTAGE,
        );
        expect(config.originEnergyLimit).toBe(
          DEPLOY_PARAMETER_ORIGIN_ENERGY_LIMIT,
        );
      });

      it('declares callValue, tokenValue, tokenId and from as present-but-undefined', () => {
        // Absent and present-but-`undefined` are different states (INV-4, INV-17),
        // and the fixtures reproduce the second because that is what the tool does:
        // `deployParameters` declares `tokenValue`/`tokenId`/`from` as `undefined`,
        // and `callValue`'s `||` chain falls through its own falsy `0`.
        const config = liveConfig(installName);
        for (const key of ['callValue', 'tokenValue', 'tokenId', 'from']) {
          expect(
            Object.prototype.hasOwnProperty.call(config, key),
            `${key} should be an own key`,
          ).toBe(true);
          expect(config[key], `${key} should read undefined`).toBeUndefined();
        }
      });

      it("passes '*' through unresolved", () => {
        expect(liveConfig(installName).network_id).toBe('*');
      });

      it('carries no own quiet key, so absence is the default the seam reads', () => {
        // `output.ts:quietFrom` treats an absent `quiet` as `false`. `quiet` is not
        // a declared prop — `Config.prototype.merge` lands it as a plain own
        // property only when the CLI merged it in — so absence is the ordinary case.
        expect(
          Object.prototype.hasOwnProperty.call(liveConfig(installName), 'quiet'),
        ).toBe(false);
      });

      it('INV-35: injects a single-method logger on every path but the un-quieted CLI', () => {
        // `Config`'s own default and the `Deployer`'s default, checked against the
        // real classes. `logger.warn` in a validating operation's warning path
        // would therefore be a `TypeError` under `--quiet`, under `tronbox test`,
        // and through the deployer's own wrapper — a crash instead of the
        // degraded-mode statement SC-003 requires, and only for users who asked
        // for less output.
        const config = liveConfig(installName);
        expect(Object.keys(config.logger as object)).toEqual(['log']);

        const Deployer = hostModule<
          new (options: Record<string, unknown>) => { logger: object }
        >(installName, 'components/Deployer/index.js');
        const withDefaultLogger = new Deployer({
          options: config,
          network: 'development',
          network_id: '*',
        });
        expect(Object.keys(withDefaultLogger.logger)).toEqual(['log']);
        expect(typeof (withDefaultLogger.logger as Record<string, unknown>).warn)
          .toBe('undefined');

        // The one path that does carry `warn`: `build/index.js` passes
        // `logger: console`. So the richer surface exists sometimes, which is
        // exactly why it must be probed at the call site and never assumed.
        expect(typeof console.warn).toBe('function');
      });

      it('INV-40: hides privateKey behind its own getter while network_config carries it', () => {
        // The credential is one property away from the values SF-0 legitimately
        // projects: `config.privateKey` is hardcoded to `null` — safe and useless
        // as a presence check — while the real key lives on `network_config`, the
        // merged object the seam reads `txDefaults` from.
        const config = liveConfig(installName);
        expect(config.privateKey).toBeNull();
        expect(config.network_config.privateKey).toBe(SENTINEL_PRIVATE_KEY);
        // Freshly merged on every access, which is why hiding `networks` would not
        // close the live reachability INV-29 documents and INV-40 revision 2
        // deliberately does not range over — see `sensitive-data.test.ts`.
        expect(config.network_config).not.toBe(config.network_config);
      });

      it('INV-29 / INV-40: makes the key reachable by three routes from both credential-bearing handles, shallowest depth 4', () => {
        // The premise of INV-40's revision-2 scoping, pinned against the tool rather
        // than against a fixture: the reachability is a *discovered necessity*, not a
        // choice the seam made — which is why that narrow scoping was accepted as
        // correct rather than widened to cover it.
        //
        // **Two subjects, not one — added at revision 3.** `artifacts.intercept` is
        // credential-reachable on exactly the same terms as `scheduling.deployer`,
        // which is the door nobody had written down. Both bottom out in the *same*
        // `Config`, which is why the terms are identical rather than merely similar:
        // `config-lineage.ts` reads `deployer.options.options` and
        // `artifacts.resolver` precisely because they are two routes to one object
        // (INV-12). The operative consequence, handed to SF-4 and SF-10: a diagnostic
        // that avoids the deployer and inspects the intercept is **not safer**.
        //
        // **The count is pinned rather than bounded, and that needed a different
        // enumerator.** The earlier assertion was `>= 2` plus an exact shallowest
        // depth — true of three routes, so weaker than the fact rather than wrong:
        // pinning the exact count strengthens the test and fixes no defect.
        // `reachableAt` below carries one global identity-visited set, and
        // `config.networks` and `config._values.networks` are the *same object*, so it
        // structurally cannot observe the third route. `ownEnumerableRoutes` cuts
        // cycles per path instead, which is what makes an exact count possible.
        //
        // Three routes each — the fresh `network_config` merge, the `networks` map,
        // and the private `_values` backing store — so closing any one of them would
        // not close the door. Verified present at v4.8.0 and v4.9.0.
        const config = liveConfig(installName);
        const Resolver = hostModule<new (config: unknown) => object>(
          installName,
          'components/Resolver/index.js',
        );
        config.resolver = new Resolver(config);
        const Deployer = hostModule<new (options: Record<string, unknown>) => object>(
          installName,
          'components/Deployer/index.js',
        );
        const deployer = new Deployer({
          options: config,
          logger: { log(): void {} },
          network: 'development',
          network_id: '*',
        });
        const Intercept = hostModule<new (resolver: unknown) => object>(
          installName,
          'components/Resolver/intercept.js',
        );
        const intercept = new Intercept(config.resolver);

        for (const [label, subject, prefix] of [
          ['scheduling.deployer', deployer, 'options.options'],
          ['artifacts.intercept', intercept, 'resolver.options'],
        ] as const) {
          const routes = ownEnumerableRoutes(subject, SENTINEL_PRIVATE_KEY, 6);
          expect([...routes].sort(), label).toEqual([
            `${prefix}._values.networks.development.privateKey`,
            `${prefix}.network_config.privateKey`,
            `${prefix}.networks.development.privateKey`,
          ]);
          expect(shallowestRouteDepth(routes), `${label} shallowest depth`).toBe(4);

          // And the cycle that makes redaction load-bearing rather than cosmetic:
          // without the seam's `toJSON`, INV-40's own stated test is not executable.
          // It holds at **both** handles, which is why `sealSlot`'s application to
          // `artifacts` is a necessity on the same footing as to `scheduling`.
          expect(() => JSON.stringify(subject), label).toThrow(TypeError);
        }

        // The identity behind the identical terms, asserted rather than argued.
        expect((intercept as { resolver: { options: unknown } }).resolver.options)
          .toBe(config);

        // The older global-visited enumerator still returns a subset, so its `>= 2`
        // form was a true lower bound. Kept as an assertion so the reason the
        // enumerator had to change is a measurement rather than a comment.
        const globalVisited = reachableAt(deployer, SENTINEL_PRIVATE_KEY, 8);
        expect(globalVisited.length).toBeGreaterThanOrEqual(2);
        expect(globalVisited.length).toBeLessThan(3);
      });

      it('INV-29 / INV-40: reaches no credential from the logger or a receipt callback', () => {
        // The negative half of the two-reachable claim, against the real host. Without
        // it, "two of the five sealed handles are credential-reachable" is a claim
        // nobody checked the other side of — and a route enumerator returning `[]` for
        // the wrong reason would make the positive case above the only thing between
        // this suite and a silent false negative.
        //
        // Every logger shape TronBox injects, plus a bare receipt function. `Config`'s
        // default logger's own keys come back as exactly `["log"]`, which independently
        // corroborates INV-35 from a probe written for a different purpose.
        const config = liveConfig(installName);
        const Deployer = hostModule<
          new (options: Record<string, unknown>) => { logger: object }
        >(installName, 'components/Deployer/index.js');
        const wrapped = new Deployer({
          options: config,
          network: 'development',
          network_id: '*',
        });

        for (const [label, subject] of [
          ["Config's default logger", config.logger],
          ["Deployer's logger wrapper", wrapped.logger],
          ['console', console],
          ['a bare receipt function', (): void => {}],
        ] as const) {
          expect(
            ownEnumerableRoutes(subject, SENTINEL_PRIVATE_KEY, 6),
            `${label} should reach no credential`,
          ).toEqual([]);
        }
        expect(Object.keys(config.logger as object)).toEqual(['log']);

        // Non-vacuous: the same enumerator finds the credential where it is.
        expect(
          ownEnumerableRoutes(config, SENTINEL_PRIVATE_KEY, 6).length,
        ).toBeGreaterThan(0);

        // `chain.tronWrap` is deliberately absent from this list. A live `TronWrap`
        // needs a reachable node, so it cannot be probed here — INV-29 covers it **by
        // rule, not by measurement**, and the seam relies on neither the module-scope
        // `let privateKeyByAccount` nor the host's own `HIDDEN_PROPS` mask. An
        // unprobed handle is not a safe one; see `sensitive-data.test.ts`.
      });

      it('INV-43 / INV-49: refuses the bare name while every subpath resolves', () => {
        // **Corrected at revision 3.** This case previously read "is not requirable,
        // so the seam cannot import a singleton from it" — which is half true and the
        // wrong half was load-bearing. Bare-name resolution *is* impossible: no
        // `main`, no `exports`, no root `index.js`, only a `bin`. But the **absent
        // `exports` map is exactly what leaves every file in the published tree
        // addressable** — an `exports` map is what closes a package, so its absence is
        // the opposite of a promise that internals will stay reachable.
        //
        // So the boundary is defeatable by subpath, which is why INV-49 exists as a
        // stated invariant with its own regression test
        // (`inv-49-host-import-boundary.test.ts`) rather than resting on the host
        // being unimportable. INV-43's conclusion survives its reason: everything the
        // plugin needs still arrives through the handles, and the seam's only injected
        // dependency is a reader — now because that is the right boundary, not because
        // the alternative is impossible.
        const root = tronBoxRoot(installName);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
        ) as { main?: string; exports?: unknown; bin?: Record<string, string> };
        expect(manifest.main).toBeUndefined();
        expect(manifest.exports).toBeUndefined();
        expect(Object.keys(manifest.bin ?? {})).toEqual(['tronbox']);
        expect(fs.existsSync(path.join(root, 'index.js'))).toBe(false);

        // The consequence, executed rather than inferred.
        const require_ = createRequire(path.join(repoRoot, 'package.json'));
        expect(() => require_.resolve(installName)).toThrow(/Cannot find module/);
        expect(() =>
          require_.resolve(`${installName}/build/components/TronWrap`),
        ).not.toThrow();
        expect(require_.resolve(`${installName}/package.json`)).toBe(
          path.join(root, 'package.json'),
        );
      });

      it('resolves a composite from real host objects, not only from fixtures', () => {
        // End to end against the tool: a real `Deployer` and a real `Resolver`
        // through the real `ResolverIntercept`, with the seam's own entry point.
        // Everything above is a premise; this is the seam actually working.
        const config = liveConfig(installName);
        const Resolver = hostModule<new (config: unknown) => object>(
          installName,
          'components/Resolver/index.js',
        );
        const Intercept = hostModule<new (resolver: unknown) => object>(
          installName,
          'components/Resolver/intercept.js',
        );
        config.resolver = new Resolver(config);
        const Deployer = hostModule<new (options: Record<string, unknown>) => object>(
          installName,
          'components/Deployer/index.js',
        );
        const deployer = new Deployer({
          options: config,
          logger: { log(): void {} },
          network: 'development',
          network_id: '*',
        });

        const env = resolveEnvironment(
          handles({
            deployer,
            artifacts: new Intercept(config.resolver),
          }),
          { require: ['paths', 'network', 'scheduling', 'output'] },
        );

        expect(env.paths.root).toBe('/proj');
        expect(env.paths.contractsBuildDirectoryIsExternal).toBe(false);
        expect(env.network.name).toBe('development');
        expect(env.network.configuredId).toEqual({
          value: '*',
          syntax: 'wildcard',
        });
        expect(env.network.txDefaults.feeLimit).toBe(
          DEPLOY_PARAMETER_FEE_LIMIT,
        );
        expect(env.network.txDefaults.callValue).toBeNull();
        expect(env.network.signingKeyConfigured).toBe(true);
        expect(env.output.origin).toBe('deployer');
        expect(env.provenance.configLineages).toMatchObject({
          viaDeployer: 'live-config',
          viaArtifacts: 'live-config',
          crossChecked: true,
          sameObject: true,
        });

        // INV-40 through the real host: the sentinel is nowhere in what a user
        // could paste into an issue, even though it is reachable from the handle.
        expect(JSON.stringify(env)).not.toContain(SENTINEL_PRIVATE_KEY);
        expect(JSON.stringify(env.provenance)).not.toContain(
          SENTINEL_PRIVATE_KEY,
        );
      });
    });
  },
);

describe.skipIf(installedVersions.length === 0 || !fs.existsSync(PROBES))(
  'evidence/probes.js promoted to a test case',
  () => {
    it.each(installedVersions)(
      'runs every research probe green against %s',
      installName => {
        // SF-0 Research's ⚗ claims, executable. Each probe pins a fact the seam is
        // built on, and running the whole file per version is what makes an
        // upstream change fail loudly here instead of surfacing as a behavioural
        // bug somewhere downstream.
        const output = execFileSync(
          process.execPath,
          [PROBES, tronBoxRoot(installName)],
          { encoding: 'utf8', cwd: repoRoot },
        );
        expect(output).toContain('all probes passed');
        expect(output).not.toContain('FAIL');
        expect(output).toMatch(/TronBox \d+\.\d+\.\d+ — 10 probe\(s\)/);
        expect(output.match(/^ {2}ok {2}/gm) ?? []).toHaveLength(10);
      },
    );

    it('names every probe the suite expects, so a silently removed probe fails', () => {
      // `10 probe(s)` above counts whatever the file defines. This pins *which*
      // ten, so deleting one and adding another still fails.
      const source = fs.readFileSync(PROBES, 'utf8');
      const defined = [...source.matchAll(/^probes\.(\w+) = /gm)].map(
        match => match[1],
      );
      expect([...defined].sort()).toEqual([
        'artifactResolution',
        'compilerConfiguration',
        'configLineages',
        'deferredChain',
        'deployerConfigDepth',
        'parityDeployPort',
        'perMigrationBinding',
        'sandboxVisibility',
        'tronboxNotRequirable',
        'wildcardAndSnapshot',
      ]);
    });
  },
);
