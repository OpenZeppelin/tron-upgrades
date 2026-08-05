import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvironmentInconsistentError,
  REDACTED_HOST_HANDLE,
  resolveEnvironment,
  slotNames,
  TronBoxEnvironmentError,
  type HandleName,
  type SlotName,
  type UnsatisfiedSlot,
} from '../src/environment';
import { EnvironmentIncompleteError } from '../src/environment';
import { networkEntry } from './helpers/config-fixtures';
import {
  artifactsOnlyHandles,
  deployerHandle,
  handles,
  interceptFixture,
  migrateShapedHandles,
  ownPropertyInterceptFixture,
  tronWrapHandle,
} from './helpers/handles';
import {
  collectKeys,
  collectStrings,
  serializedTree,
  sortedOwnKeys,
} from './helpers/introspect';
import { singleContractReader } from './helpers/readers';
import {
  allSources,
  environmentSources,
  nonEnvironmentSources,
} from './helpers/source-scan';

/**
 * Trust & Capability Boundary, covering the handle-entry guard, the
 * deployer-resolver pairing check, chain-handle normalization, the
 * internal-property-path scope, and the no-raw-host-object rule.
 *
 * The environment seam has no authorization surface: it signs nothing and calls
 * nothing. What it
 * has is a trust boundary — handles arrive from a `vm` sandbox, unvalidated, and
 * the seam is the single place permitted to reach TronBox internals. The
 * technique is therefore auth-boundary testing in the shape that applies:
 * malformed and missing inputs must both be refused with a named diagnosis, and
 * the observable consequence must be that nothing internal escapes.
 */

function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected the resolution to throw, and it returned normally');
}

function incompleteFrom(act: () => unknown): EnvironmentIncompleteError {
  const error = caught(act);
  expect(error).toBeInstanceOf(EnvironmentIncompleteError);
  if (!(error instanceof EnvironmentIncompleteError)) {
    throw new Error('unreachable');
  }
  return error;
}

function pathOf(cause: UnsatisfiedSlot['cause']): string | undefined {
  return cause.kind === 'handle-malformed' ? cause.expectedPath : undefined;
}

interface MalformedCase {
  readonly handle: HandleName;
  readonly require: readonly SlotName[];
  readonly slot: SlotName;
  readonly value: unknown;
  readonly label: string;
  readonly expectedPath: string;
}

function withValid(
  handle: HandleName,
  value: unknown,
): Record<string, unknown> {
  const base = migrateShapedHandles();
  const built: Record<string, unknown> = {
    tronWrap: tronWrapHandle(),
    waitForTransactionReceipt: (): void => {},
    deployer: base.deployer,
    artifacts: base.intercept,
  };
  built[handle] = value;
  return built;
}

const malformedCases: readonly MalformedCase[] = (
  [
    ['deployer', 'scheduling', 'an empty object', {}, 'deployer.then'],
    ['deployer', 'scheduling', 'null', null, 'deployer'],
    ['deployer', 'scheduling', 'a number', 42, 'deployer'],
    ['deployer', 'scheduling', 'a string', 'deployer', 'deployer'],
    ['deployer', 'scheduling', 'a boolean', true, 'deployer'],
    ['deployer', 'scheduling', 'an array', [], 'deployer.then'],
    [
      'deployer',
      'scheduling',
      'a plausible-but-wrong object',
      { options: { options: {} } },
      'deployer.then',
    ],
    ['artifacts', 'artifacts', 'an empty object', {}, 'artifacts.require'],
    ['artifacts', 'artifacts', 'null', null, 'artifacts'],
    ['artifacts', 'artifacts', 'a number', 42, 'artifacts'],
    [
      'artifacts',
      'artifacts',
      'an intercept without a resolver',
      { require: (): void => {}, contracts: (): void => {} },
      'artifacts.resolver',
    ],
    [
      'artifacts',
      'artifacts',
      'an intercept whose require is not callable',
      { require: 'nope', contracts: (): void => {}, resolver: {} },
      'artifacts.require',
    ],
    [
      'artifacts',
      'artifacts',
      'an intercept without contracts',
      { require: (): void => {}, resolver: {} },
      'artifacts.contracts',
    ],
    ['tronWrap', 'chain', 'an empty object', {}, 'tronWrap.trx'],
    ['tronWrap', 'chain', 'null', null, 'tronWrap'],
    ['tronWrap', 'chain', 'a number', 42, 'tronWrap'],
    [
      'tronWrap',
      'chain',
      'a client whose trx is a primitive',
      { trx: 'yes' },
      'tronWrap.trx',
    ],
    [
      'waitForTransactionReceipt',
      'receipts',
      'an object',
      {},
      'waitForTransactionReceipt',
    ],
    [
      'waitForTransactionReceipt',
      'receipts',
      'null',
      null,
      'waitForTransactionReceipt',
    ],
    [
      'waitForTransactionReceipt',
      'receipts',
      'a string',
      'wait',
      'waitForTransactionReceipt',
    ],
  ] as const
).map(([handle, slot, label, value, expectedPath]) => ({
  handle,
  slot,
  label,
  value,
  expectedPath,
  require: [slot, 'chain'] as readonly SlotName[],
}));

describe('handles enter as unknown and reach a slot only through a guard', () => {
  it.each(
    malformedCases.map(entry => [
      `${entry.handle} as ${entry.label}`,
      entry,
    ] as const),
  )('refuses %s with a named diagnosis, never a TypeError', (_label, entry) => {
    const requireList: readonly SlotName[] =
      entry.slot === 'chain' ? ['chain', 'scheduling'] : entry.require;
    const error = caught(() =>
      resolveEnvironment(
        handles(withValid(entry.handle, entry.value)),
        { require: requireList },
        { buildInfoReader: singleContractReader() },
      ),
    );
    expect(error).toBeInstanceOf(EnvironmentIncompleteError);
    expect(error).not.toBeInstanceOf(TypeError);
    if (!(error instanceof EnvironmentIncompleteError)) {
      throw new Error('unreachable');
    }
    const forSlot = error.unsatisfied.filter(item => item.slot === entry.slot);
    expect(forSlot.length).toBeGreaterThan(0);
    expect(forSlot.map(item => pathOf(item.cause))).toContain(
      entry.expectedPath,
    );
  });

  it('never lets a raw TypeError escape for any malformed handle combination', () => {
    const junk: readonly unknown[] = [
      null,
      0,
      '',
      false,
      [],
      {},
      Symbol.iterator,
      () => undefined,
    ];
    for (const value of junk) {
      const error = caught(() =>
        resolveEnvironment(
          handles({
            deployer: value,
            artifacts: value,
            tronWrap: value,
            tronWeb: value,
            waitForTransactionReceipt: value,
          }),
          { require: slotNames },
        ),
      );
      expect(error, String(value)).toBeInstanceOf(TronBoxEnvironmentError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it('accepts prototype-borne members and own members alike', () => {
    // `ResolverIntercept.prototype.require` and `Deployer.prototype.then` live on
    // prototypes; `artifacts.resolver` and every Config prop are own properties.
    // Using own-property checks for the former would reject a valid handle.
    const prototypeShape = migrateShapedHandles();
    const prototypeEnv = resolveEnvironment(
      prototypeShape.handles,
      { require: ['artifacts', 'scheduling'] },
      { buildInfoReader: singleContractReader() },
    );
    expect(prototypeEnv.artifacts.intercept).toBe(prototypeShape.intercept);

    const resolver: Record<string, unknown> = {};
    const ownShape = migrateShapedHandles();
    resolver.options = ownShape.config;
    const ownIntercept = ownPropertyInterceptFixture(ownShape.resolver);
    const ownEnv = resolveEnvironment(
      handles({
        deployer: ownShape.deployer,
        artifacts: ownIntercept,
        tronWrap: tronWrapHandle(),
      }),
      { require: ['artifacts', 'scheduling'] },
      { buildInfoReader: singleContractReader() },
    );
    expect(ownEnv.artifacts.intercept).toBe(ownIntercept);
  });

  it('accepts a deployer whose then lives on the prototype', () => {
    const shape = migrateShapedHandles();
    const prototypeDeployer = deployerHandle(shape.config, {
      thenOnPrototype: true,
    });
    const env = resolveEnvironment(
      handles({ deployer: prototypeDeployer, tronWrap: tronWrapHandle() }),
      { require: ['scheduling'] },
    );
    expect(env.scheduling.deployer).toBe(prototypeDeployer);
  });
});

describe('when both are present, artifacts must wrap the deployer resolver', () => {
  it('refuses an intercept wrapping a foreign resolver', () => {
    const shape = migrateShapedHandles();
    const foreignResolver: Record<string, unknown> = {};
    foreignResolver.options = shape.config;
    const error = caught(() =>
      resolveEnvironment(
        handles({
          deployer: shape.deployer,
          artifacts: interceptFixture(foreignResolver),
          tronWrap: tronWrapHandle(),
        }),
        { require: ['paths'] },
      ),
    );
    expect(error).toBeInstanceOf(EnvironmentInconsistentError);
    if (!(error instanceof EnvironmentInconsistentError)) {
      throw new Error('unreachable');
    }
    expect(error.inconsistencies).toEqual([
      { kind: 'artifacts-not-wrapping-deployer-resolver' },
    ]);
    expect(error.message).toContain(
      'does not wrap the resolver owned by the supplied deployer',
    );
    expect(error.message).toContain('different migrations');
  });

  it('resolves normally with only artifacts, proving no deployer is presupposed', () => {
    // This is what leaves the deploy seam free to refuse when no deployer is
    // present: the check is conditioned on both handles being present, never on
    // a deployer existing.
    const shape = artifactsOnlyHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['paths', 'network', 'artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    expect(env.paths.root).toBe('/proj');
    expect(env.provenance.configLineages.viaDeployer).toBe('absent');
    expect(env.provenance.configLineages.viaArtifacts).toBe('live-config');
  });

  it('resolves when the intercept wraps the deployer Config resolver', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect(env.provenance.configLineages.sameObject).toBe(true);
  });

  it('reports a mispairing whatever slots were declared', () => {
    // Reported unconditionally on handle presence, as the invariant states. The
    // read *failure* branch below is the one scoped to declared slots.
    const shape = migrateShapedHandles();
    const foreignResolver: Record<string, unknown> = {};
    foreignResolver.options = shape.config;
    const error = caught(() =>
      resolveEnvironment(
        handles({
          deployer: shape.deployer,
          artifacts: interceptFixture(foreignResolver),
          tronWrap: tronWrapHandle(),
        }),
        { require: ['chain'] },
      ),
    );
    expect(error).toBeInstanceOf(EnvironmentInconsistentError);
  });

  it('refuses a deployer Config carrying no resolver, for the slots that need it', () => {
    const shape = migrateShapedHandles({ omit: ['resolver'] });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error.message).toContain(
      'property path "deployer.options.options.resolver" is absent',
    );
  });

  it('does not let that read failure fail a resolution that declared no lineage slot', () => {
    // implementation defect 3, in its second shape: a slot the caller never declared
    // must not be able to fail the resolution, or the declared-slots-only
    // guarantee's purpose is defeated.
    const shape = migrateShapedHandles({ omit: ['resolver'] });
    const env = resolveEnvironment(shape.handles, { require: ['chain'] });
    expect(env.chain).toBeDefined();
  });

  it('regression: a misconfigured network cannot fail a paths-only resolution', () => {
    // implementation defect 3: the external draft ran the cross-check whenever both
    // lineages were present, so `require: ['paths']` against a config with a
    // misconfigured network threw naming slot `network`.
    const shape = migrateShapedHandles({ networks: {} });
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect(env.paths.root).toBe('/proj');
    expect(env.provenance.slots.network).toBe('absent');
  });
});

describe('the chain handle is normalized one-way and a conflict is inconsistent', () => {
  it('accepts both names for one object', () => {
    const wrap = tronWrapHandle();
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      handles({
        deployer: shape.deployer,
        artifacts: shape.intercept,
        tronWrap: wrap,
        tronWeb: wrap,
      }),
      { require: ['chain'] },
    );
    expect(env.chain.tronWrap).toBe(wrap);
  });

  it('refuses two different objects rather than preferring one', () => {
    const error = caught(() =>
      resolveEnvironment(
        handles({ tronWrap: tronWrapHandle(), tronWeb: tronWrapHandle() }),
        { require: ['chain'] },
      ),
    );
    expect(error).toBeInstanceOf(EnvironmentInconsistentError);
    if (!(error instanceof EnvironmentInconsistentError)) {
      throw new Error('unreachable');
    }
    expect(error.inconsistencies).toEqual([{ kind: 'chain-handle-conflict' }]);
    expect(error.message).toContain(
      'TronBox injects them as two names for one object',
    );
  });

  it('accepts tronWeb alone and never re-exports the misleading name', () => {
    // `build/components/Migrate/index.js:Migration` builds the sandbox with
    // `tronWeb: tronWrap`, so the misleading name is the host's, not the user's.
    // Refusing it would push the host's inconsistency onto the user;
    // re-exporting it would invite the chain layer to reach for TronWeb methods
    // that are not there.
    const wrap = tronWrapHandle();
    const env = resolveEnvironment(handles({ tronWeb: wrap }), {
      require: ['chain'],
    });
    expect(env.chain.tronWrap).toBe(wrap);
    expect(sortedOwnKeys(env.chain)).toEqual(['tronWrap']);
    expect(Object.keys(env.chain)).not.toContain('tronWeb');
    expect(collectKeys(serializedTree(env))).not.toContain('tronWeb');
  });

  it('accepts tronWrap alone', () => {
    const wrap = tronWrapHandle();
    const env = resolveEnvironment(handles({ tronWrap: wrap }), {
      require: ['chain'],
    });
    expect(env.chain.tronWrap).toBe(wrap);
  });

  it('validates both supplied names rather than stopping at the first good one', () => {
    const error = incompleteFrom(() =>
      resolveEnvironment(
        handles({ tronWrap: tronWrapHandle(), tronWeb: {} }),
        { require: ['chain'] },
      ),
    );
    expect(
      error.unsatisfied.map(item => pathOf(item.cause)),
    ).toContain('tronWeb.trx');
  });
});

describe('only src/environment/** reads a TronBox-internal property path', () => {
  it('finds no internal property path outside the seam', () => {
    const outside = nonEnvironmentSources();
    const forbidden =
      /\.options\.options|\.resolver\.options|\.basePath|_values|network_config|_json/;
    for (const source of outside) {
      expect(
        source.accessChains.filter(chain => forbidden.test(chain)),
        `${source.relative}`,
      ).toEqual([]);
    }

    /*
     * **Why the pattern is the thing that has to grow, not the scan's scope.**
     * `nonEnvironmentSources()` roots at `srcDir` and subtracts only
     * `environment/`, so it already ranges over `chain`, `options`, `output`,
     * `results` and `index.ts`, and picks up a new sibling directory the moment it
     * exists — `test/inv-49-host-import-boundary.test.ts` asserts that partition
     * rather than assuming it. What a new sibling can still slip past is an
     * internal path the *pattern* does not name, which is why `_json` is now in it:
     * TronBox stores the whole compiled artifact there, so a consumer reaching for
     * bytecode or source would go through `_json` and satisfy every other clause.
     * `src/environment/artifact-record.ts` is the seam's answer, and this is what
     * makes going around it fail.
     *
     * **What deliberately is *not* in the pattern, and why it cannot be.**
     * `bytecode`, `deployedBytecode`, `source` and `sourcePath` are member names on
     * the frozen record the seam hands out, so a consumer reading
     * `record.bytecode` is obeying the boundary, not breaking it — a pattern
     * covering those names would forbid the supported path along with the
     * unsupported one. The names that *can* be forbidden are the ones the seam's
     * own record never reuses, which is why the record's compiler field is called
     * `longCompilerVersion`.
     */
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.map(source => source.relative)).toContain('index.ts');
  });

  it('confines the name ContractHandle to the module family that declares it', () => {
    /*
     * **The second way past this invariant, closed by name rather than by path.**
     * `src/results/types.ts:ContractHandle` carries `[member: string]: any`, so
     * *any* property read compiles on a value cast to it — including
     * `(contract as ContractHandle).bytecode`, which the pattern above cannot see
     * because the access chain is `.bytecode` and not `_json`. A widening cast is
     * therefore a complete route around clause one that leaves no `_json` behind.
     *
     * **The index signature is not the thing to remove.** It is a documented
     * exception (`src/results/types.ts:28-35`) for the consumer base this plugin
     * exists to serve: JavaScript migrations calling arbitrary ABI-derived methods
     * on a returned contract, where a narrower type protects nobody and blocks
     * every legitimate call. Deleting it would close a hazard inside `src/` by
     * breaking every user outside it.
     *
     * So the instrument is scoped to where the hazard is. The migration path is a
     * *runtime* property read by user code that this scan never sees; the
     * validation path is a *cast written in this repository*, and it needs the name
     * `ContractHandle` in scope to be written at all. Confining the name to the
     * three modules that declare, re-export and construct it makes a cast anywhere
     * else fail here — while `ContractHandle` itself, and everything a migration
     * author may do with a returned contract, is untouched.
     *
     * Sibling sub-features read artifact fields off `ArtifactAccess.record`, whose
     * report is frozen plain data with no index signature, so nothing outside
     * `results/` has a reason to name this type.
     */
    const namers = allSources().filter(source =>
      source.identifiers.some(
        use => use.name === 'ContractHandle' && !use.isPropertyName,
      ),
    );
    // `index.ts` joined the family when the entry module gained its type-only
    // surface, and `proxy/toolkit.ts` when the operations landed: the toolkit
    // DECLARES `contractAt`'s return type, still not a cast site — the fifth
    // member is a signature, not a value read. Any module beyond these five
    // naming the type fails here.
    expect(namers.map(source => source.relative).sort()).toEqual([
      'index.ts',
      path.join('proxy', 'toolkit.ts'),
      path.join('results', 'index.ts'),
      path.join('results', 'limitations.ts'),
      path.join('results', 'types.ts'),
    ]);
  });

  it('keeps both private hops in config-lineage.ts alone', () => {
    const hopOwners = environmentSources().filter(source =>
      source.stringArrayLiterals.some(literal =>
        /^'options','options'$|^'resolver','options'$/.test(literal),
      ),
    );
    expect(hopOwners.map(source => source.relative)).toEqual([
      'config-lineage.ts',
    ]);
  });

  it('reads no Config private backing store anywhere in the seam', () => {
    for (const source of environmentSources()) {
      expect(
        source.accessChains.filter(chain =>
          /_values|network_config/.test(chain),
        ),
        `${source.relative}`,
      ).toEqual([]);
      expect(
        source.readPropertyKeys.filter(key =>
          /^(_values|network_config|basePath)$/.test(key),
        ),
        `${source.relative}`,
      ).toEqual([]);
    }
  });

  it('enumerates the exact set of host keys the seam reads by literal name', () => {
    // The drift surface, as data. A new key read here is a new upstream
    // dependency, and `internalPathsRead` recording it is the runtime corroboration.
    const keys = new Set<string>();
    for (const source of environmentSources()) {
      for (const key of source.readPropertyKeys) {
        keys.add(key);
      }
    }
    expect([...keys].sort()).toEqual([
      // The seven artifact-record keys. `artifact-record.ts` spells each read out
      // with a literal key rather than walking an array of hops precisely so they
      // land here: a hop-walker passes the key as a variable and this scan would
      // report the drift surface as one key (`_json`) when it is seven.
      '_json',
      'bytecode',
      'compiler',
      'deployedBytecode',
      'log',
      'logger',
      'network_id',
      'networks',
      'privateKey',
      'quiet',
      'resolver',
      'source',
      'sourcePath',
      'then',
      'trx',
      'version',
    ]);
  });

  it('accounts for the three host keys reached through a non-literal read', () => {
    // Completes the enumeration above. `require` and `contracts` are probed from
    // a loop over an array literal, and `working_directory` is reached through
    // `Object.getOwnPropertyDescriptor` in `classifyBinding` rather than through
    // the read primitives — so a `readPropertyKeys` scan alone would understate
    // the drift surface by three keys.
    const sources = environmentSources();
    const methodProbe = sources.filter(source =>
      source.stringArrayLiterals.includes("'require','contracts'"),
    );
    expect(methodProbe.map(source => source.relative)).toEqual(['artifacts.ts']);

    const descriptorProbe = sources.filter(
      source =>
        source.stringLiterals.includes('working_directory') &&
        source.accessChains.some(chain =>
          chain.includes('getOwnPropertyDescriptor'),
        ),
    );
    expect(descriptorProbe.map(source => source.relative)).toEqual([
      'config-lineage.ts',
    ]);
  });
});

describe('no raw host object is exposed', () => {
  it('exposes no Config, network_config or basePath key anywhere in the composite', () => {
    const shape = migrateShapedHandles({
      networks: { development: networkEntry({ from: 'TFrom' }) },
    });
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const keys = collectKeys(serializedTree(env));
    for (const forbidden of [
      'network_config',
      '_values',
      'basePath',
      'networks',
      'privateKey',
      'artifactor',
      'migrations_directory',
    ]) {
      expect(keys, `composite exposes ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('exposes the deployer whole under the one slot that says so', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['scheduling'] });
    expect(sortedOwnKeys(env.scheduling)).toEqual(['deployer']);
    expect(env.scheduling.deployer).toBe(shape.deployer);
  });

  it('redacts every exposed handle on serialization, so the walk terminates', () => {
    // Five. The count was written down as four elsewhere and later corrected; this
    // assertion had five all along, which is why the correction cost nothing here —
    // a prose count drifts, an asserted one cannot. Pinned as a count *and* as a
    // per-slot enumeration so adding a sixth handle-bearing slot without redacting
    // it fails here.
    //
    // The rule is *all five are unsafe to log*, deliberately not keyed to the
    // two that are credential-reachable on v4.8.0 / v4.9.0 — a rule keyed to that
    // subset is one an upstream bump silently expires, while the five sealing sites
    // are the seam's own. `sensitive-data.test.ts` holds the reachability
    // measurements and the sealing-site set.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const strings = collectStrings(serializedTree(env));
    expect(strings.filter(value => value === REDACTED_HOST_HANDLE)).toHaveLength(
      5,
    );
    expect(serializedTree(env)).toMatchObject({
      chain: { tronWrap: REDACTED_HOST_HANDLE },
      scheduling: { deployer: REDACTED_HOST_HANDLE },
      artifacts: { intercept: REDACTED_HOST_HANDLE },
      output: { logger: REDACTED_HOST_HANDLE },
      receipts: { waitForTransactionReceipt: REDACTED_HOST_HANDLE },
    });
  });

  it('never exposes deployer.basePath, which is the migrations directory', () => {
    // `Deployer` sets `this.basePath = options.basePath || process.cwd()` and
    // `Migration` passes `path.dirname(this.file)`. It is absolute, plausible,
    // and named like a project root — the record layer anchoring a record on it
    // would put the record inside `migrations/`.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, {
      require: ['paths', 'scheduling'],
    });
    expect(env.paths.root).toBe('/proj');
    expect(collectKeys(serializedTree(env))).not.toContain('basePath');
    expect(collectStrings(serializedTree(env))).not.toContain(
      '/proj/migrations',
    );
  });
});
