import { inspect } from 'node:util';
import { REDACTED_HOST_HANDLE, resolveEnvironment } from '../../src/environment';
import { networkEntry, SENTINEL_PRIVATE_KEY } from './config-fixtures';
import { projectedSurface } from './introspect';
import {
  artifactsOnlyHandles,
  deployerOnlyHandles,
  handles,
  interceptFixture,
  migrateShapedHandles,
  shallowDeployerHandle,
  testShapedHandles,
  tronWrapHandle,
} from './handles';
import {
  absentReader,
  collidingReader,
  existenceProbeReader,
  filesReader,
  singleContractReader,
  throwingProbeReader,
  throwingReader,
  unreadableReader,
} from './readers';

/**
 * Every fixture the suite drives, reduced to the strings it makes observable.
 *
 * The credential-redaction invariant's own stated test is *"assert the sentinel
 * appears nowhere in `JSON.stringify(composite)` … across **all** fixtures"* —
 * plural, deliberately. A leak that only shows up on the disagreement path, or
 * only in an `IndeterminateReason`, is exactly the leak a single-fixture
 * assertion misses. This catalogue is what makes "all fixtures" mechanical:
 * adding a fixture here subjects it to the sentinel sweep, and the sweeps for
 * the no-serialized-host-object and no-widened-exposure invariants reuse it.
 *
 * Every entry configures {@link SENTINEL_PRIVATE_KEY} on the selected network,
 * so the secret is genuinely one property away from the values the seam projects
 * — a real risk of leaking, not a hypothetical one.
 */
export interface FixtureProbe {
  readonly name: string;
  /** `'resolved'` when the composite was returned, `'threw'` otherwise. */
  readonly outcome: 'resolved' | 'threw';
  /**
   * Everything a user could see, in **both** rendering channels.
   *
   * The redaction guarantee makes this plural on purpose. `JSON.stringify`
   * consults `handles.ts:sealSlot`'s `toJSON`, so a sweep over serialization
   * alone tests the *backstop* and would pass on a composite that prints a
   * credential to a terminal. Each entry therefore contributes its
   * `util.inspect(…, { depth: null })` rendering of {@link projectedSurface}
   * as well — the same fixture, the channel `toJSON` is invisible to.
   */
  readonly observable: readonly string[];
}

const ALL_SLOTS = [
  'paths',
  'network',
  'artifacts',
  'chain',
  'receipts',
  'scheduling',
  'output',
] as const;

function serializeError(error: unknown): readonly string[] {
  if (!(error instanceof Error)) {
    return [
      String(error),
      JSON.stringify(error) ?? 'undefined',
      inspect(error, { depth: null }),
    ];
  }
  const own = JSON.stringify({ ...error }) ?? '{}';
  return [
    error.name,
    error.message,
    own,
    error.stack ?? '',
    // `console.error(err)` in a CI log — the channel that renders an error's own
    // enumerable payload (`unsatisfied`, `inconsistencies`) at full depth without
    // consulting any `toJSON`.
    inspect(error, { depth: null }),
  ];
}

function probe(name: string, act: () => readonly string[]): FixtureProbe {
  try {
    return { name, outcome: 'resolved', observable: act() };
  } catch (error) {
    return { name, outcome: 'threw', observable: serializeError(error) };
  }
}

/**
 * The `util.inspect` half of the sweep: full depth, no `toJSON`, over the surface
 * the seam projects. `depth: null` is required — the default of `2` would print
 * `[Object]` exactly where a nested credential would sit.
 */
function inspectProjected(env: unknown): readonly string[] {
  return [
    inspect(projectedSurface(env, REDACTED_HOST_HANDLE), { depth: null }),
  ];
}

/** Squeezes every observable string out of a composite, including lazy surfaces. */
function observeComposite(env: {
  readonly provenance: unknown;
  readonly artifacts?: {
    ambiguities(): unknown;
    resolve(name: string): unknown;
    resolvePackaged(pathValue: string): unknown;
  };
}): readonly string[] {
  const out: string[] = [
    JSON.stringify(env) ?? 'undefined',
    JSON.stringify(env.provenance) ?? 'undefined',
    ...inspectProjected(env),
    ...inspectProjected(env.provenance),
  ];
  const artifacts = env.artifacts;
  if (artifacts !== undefined) {
    out.push(JSON.stringify(artifacts.ambiguities()) ?? 'undefined');
    for (const name of ['Box', './Box.sol', 'contracts/Box.sol', 'Missing']) {
      try {
        out.push(JSON.stringify(artifacts.resolve(name)) ?? 'undefined');
      } catch (error) {
        out.push(...serializeError(error));
      }
    }
    for (const packaged of [
      '@openzeppelin/upgrades-core/artifacts/proxy/ERC1967Proxy.json',
      './local.json',
      '../escape.json',
      'nope',
    ]) {
      try {
        out.push(JSON.stringify(artifacts.resolvePackaged(packaged)) ?? 'undefined');
      } catch (error) {
        out.push(...serializeError(error));
      }
    }
  }
  return out;
}

export function allFixtureProbes(): readonly FixtureProbe[] {
  return [
    probe('migrate shape, every slot, index available', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }, {
          buildInfoReader: singleContractReader(),
        }),
      );
    }),

    probe('migrate shape, colliding build info', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }, {
          buildInfoReader: collidingReader(),
        }),
      );
    }),

    probe('migrate shape, build info absent', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }, {
          buildInfoReader: absentReader(),
        }),
      );
    }),

    probe('migrate shape, build info unreadable', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }, {
          buildInfoReader: unreadableReader(
            '/proj/build/build-info/aaa.output.json',
            'EACCES',
          ),
        }),
      );
    }),

    probe('migrate shape, build info lacks a contract map', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }, {
          buildInfoReader: filesReader([
            { name: 'aaa.output.json', output: { sources: {} } },
          ]),
        }),
      );
    }),

    probe('migrate shape, reader throws', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }, {
          buildInfoReader: throwingReader(
            new Error(`read failed for key ${SENTINEL_PRIVATE_KEY}`),
          ),
        }),
      );
    }),

    probe('tronbox test shape, lineages agree', () => {
      const shape = testShapedHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }, {
          buildInfoReader: singleContractReader(),
        }),
      );
    }),

    probe('tronbox test shape, lineages disagree on network', () => {
      const shape = testShapedHandles({}, { network: 'nile' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ALL_SLOTS }),
      );
    }),

    probe('tronbox test shape, lineages disagree on every path', () => {
      const shape = testShapedHandles({}, { root: '/other' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['paths'] }),
      );
    }),

    probe('artifacts only, no deployer', () => {
      const shape = artifactsOnlyHandles();
      return observeComposite(
        resolveEnvironment(
          shape.handles,
          { require: ['paths', 'network', 'artifacts', 'chain', 'output'] },
          { buildInfoReader: singleContractReader() },
        ),
      );
    }),

    probe('deployer only, no artifacts', () => {
      const shape = deployerOnlyHandles();
      return observeComposite(
        resolveEnvironment(shape.handles, {
          require: ['paths', 'network', 'chain', 'scheduling', 'output'],
        }),
      );
    }),

    probe('no handles at all', () =>
      observeComposite(
        resolveEnvironment(handles({}), { require: ['paths'] }),
      ),
    ),

    probe('relative working_directory', () => {
      const shape = migrateShapedHandles({ root: '../shared' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['paths'] }),
      );
    }),

    probe('build_info_directory outside the project', () => {
      const shape = migrateShapedHandles({
        buildInfoDirectory: '/elsewhere/build-info',
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['paths'] }),
      );
    }),

    probe('empty networks map', () => {
      const shape = migrateShapedHandles({ networks: {} });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('selected network absent from networks', () => {
      const shape = migrateShapedHandles({
        network: 'nile',
        networks: { development: networkEntry() },
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('selected network configured without network_id', () => {
      const shape = migrateShapedHandles({
        networks: { development: networkEntry({ omit: ['network_id'] }) },
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('wrong-typed feeLimit', () => {
      const shape = migrateShapedHandles({ feeLimit: '1000000000' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('credential-shaped wrong-typed from', () => {
      const shape = migrateShapedHandles({
        from: { privateKey: SENTINEL_PRIVATE_KEY },
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('config getter throws', () => {
      const shape = migrateShapedHandles({ throwOn: ['contracts_directory'] });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['paths'] }),
      );
    }),

    probe('truncated deployer handle', () =>
      observeComposite(
        resolveEnvironment(
          handles({
            deployer: shallowDeployerHandle(1),
            tronWrap: tronWrapHandle(),
          }),
          { require: ['paths', 'network', 'output'] },
        ),
      ),
    ),

    probe('chain handle conflict', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(
          handles({
            deployer: shape.handles.deployer,
            artifacts: shape.handles.artifacts,
            tronWrap: tronWrapHandle(),
            tronWeb: tronWrapHandle(),
          }),
          { require: ['chain'] },
        ),
      );
    }),

    probe('artifacts intercept wraps a foreign resolver', () => {
      const shape = migrateShapedHandles();
      const foreignResolver: Record<string, unknown> = {};
      foreignResolver.options = shape.config;
      return observeComposite(
        resolveEnvironment(
          handles({
            deployer: shape.handles.deployer,
            artifacts: interceptFixture(foreignResolver),
            tronWrap: tronWrapHandle(),
          }),
          { require: ['paths'] },
        ),
      );
    }),

    probe('receipts handle is not a function', () => {
      const shape = migrateShapedHandles();
      return observeComposite(
        resolveEnvironment(
          handles({
            deployer: shape.handles.deployer,
            artifacts: shape.handles.artifacts,
            waitForTransactionReceipt: { call: (): void => {} },
          }),
          { require: ['receipts'] },
        ),
      );
    }),

    probe('logger without log', () => {
      const shape = migrateShapedHandles({ logger: { warn: (): void => {} } });
      return observeComposite(
        resolveEnvironment(
          handles({ deployer: shape.deployer }),
          { require: ['output'] },
        ),
      );
    }),

    probe('quiet is not a boolean', () => {
      const shape = migrateShapedHandles({ quiet: 'yes' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['output'] }),
      );
    }),

    probe('intercept require throws with a secret-bearing message', () => {
      const shape = migrateShapedHandles({}, {
        mode: 'throw',
        throwMessage: `resolver blew up holding ${SENTINEL_PRIVATE_KEY}`,
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['artifacts'] }, {
          buildInfoReader: singleContractReader(),
        }),
      );
    }),

    probe('intercept require returns null', () => {
      const shape = migrateShapedHandles({}, { mode: 'null' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['artifacts'] }, {
          buildInfoReader: singleContractReader(),
        }),
      );
    }),

    // --- added later, so the new behaviour is swept like the rest -----------

    probe('packaged artifact missing (resolution cause 2)', () => {
      const shape = migrateShapedHandles({}, { mode: 'null' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['artifacts'] }, {
          buildInfoReader: existenceProbeReader(false),
        }),
      );
    }),

    probe('packaged artifact present but malformed (resolution cause 3)', () => {
      const shape = migrateShapedHandles({}, { mode: 'null' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['artifacts'] }, {
          buildInfoReader: existenceProbeReader(true),
        }),
      );
    }),

    probe('existence probe throws with a secret-bearing message', () => {
      const shape = migrateShapedHandles({}, { mode: 'null' });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['artifacts'] }, {
          buildInfoReader: throwingProbeReader(
            new Error(`probe failed holding ${SENTINEL_PRIVATE_KEY}`),
          ),
        }),
      );
    }),

    probe('numeric network_id on both lineages, normalized and accepted', () => {
      const shape = migrateShapedHandles({
        networkId: 1,
        networks: { development: networkEntry({ networkId: 1 }) },
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('falsy numeric network_id, refused', () => {
      const shape = migrateShapedHandles({
        networkId: 0,
        networks: { development: networkEntry({ networkId: 0 }) },
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('bigint network_id, refused by type', () => {
      const shape = migrateShapedHandles({
        networks: { development: networkEntry({ networkId: 1n }) },
      });
      return observeComposite(
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
    }),

    probe('unsupplied output handles under a chain-only context', () =>
      observeComposite(
        resolveEnvironment(handles({ tronWrap: tronWrapHandle() }), {
          require: ['chain', 'output'],
        }),
      ),
    ),
  ];
}
