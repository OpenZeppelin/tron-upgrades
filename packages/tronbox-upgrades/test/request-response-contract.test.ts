import { describe, expect, it } from 'vitest';
import {
  EnvironmentIncompleteError,
  normalizeArtifactName,
  resolveEnvironment,
  slotNames,
  type SlotName,
} from '../src/environment';
import {
  DEPLOY_PARAMETER_FEE_LIMIT,
  DEPLOY_PARAMETER_ORIGIN_ENERGY_LIMIT,
  DEPLOY_PARAMETER_USER_FEE_PERCENTAGE,
  mutableNetworkEntry,
  networkEntry,
} from './helpers/config-fixtures';
import {
  artifactsOnlyHandles,
  handles,
  migrateShapedHandles,
  testShapedHandles,
  tronWrapHandle,
} from './helpers/handles';
import {
  collectKeys,
  reachableObjects,
  serializedTree,
  sortedOwnKeys,
} from './helpers/introspect';
import {
  absentReader,
  collidingReader,
  singleContractReader,
} from './helpers/readers';
import { environmentSources } from './helpers/source-scan';

/**
 * Input/Output Contract — the invariants governing what `resolveEnvironment`
 * returns and reports.
 *
 * Technique: entry-point integration. Every test drives `resolveEnvironment`
 * from a handle set and asserts both the returned shape and what the composite
 * reports, because the shape *is* the enforcement for most of this category.
 */

function incompleteFrom(act: () => unknown): EnvironmentIncompleteError {
  let caught: unknown;
  try {
    act();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EnvironmentIncompleteError);
  if (!(caught instanceof EnvironmentIncompleteError)) {
    throw new Error('unreachable');
  }
  return caught;
}

describe('slot narrowing is total and exact', () => {
  it('returns an own value for every required slot and nothing outside R ∪ O', () => {
    const cases: readonly {
      readonly label: string;
      readonly require: readonly SlotName[];
      readonly optional: readonly SlotName[];
      readonly expected: readonly string[];
    }[] = [
      {
        label: 'every slot required',
        require: slotNames,
        optional: [],
        expected: [...slotNames, 'provenance'],
      },
      {
        label: 'paths only',
        require: ['paths'],
        optional: [],
        expected: ['paths', 'provenance'],
      },
      {
        label: 'chain only',
        require: ['chain'],
        optional: [],
        expected: ['chain', 'provenance'],
      },
      {
        label: 'paths required, network optional and constructible',
        require: ['paths'],
        optional: ['network'],
        expected: ['network', 'paths', 'provenance'],
      },
      {
        label: 'duplicate entries in require',
        require: ['paths', 'paths'],
        optional: [],
        expected: ['paths', 'provenance'],
      },
      {
        label: 'a slot named in both lists is treated as required',
        require: ['paths'],
        optional: ['paths'],
        expected: ['paths', 'provenance'],
      },
      {
        label: 'nothing required at all',
        require: [],
        optional: [],
        expected: ['provenance'],
      },
    ];

    for (const testCase of cases) {
      const shape = migrateShapedHandles();
      const env = resolveEnvironment(
        shape.handles,
        { require: testCase.require, optional: testCase.optional },
        { buildInfoReader: singleContractReader() },
      );
      expect(sortedOwnKeys(env), testCase.label).toEqual(
        [...testCase.expected].sort(),
      );
      for (const slot of testCase.require) {
        expect(
          Object.prototype.hasOwnProperty.call(env, slot),
          `${testCase.label}: ${slot} must be an own property`,
        ).toBe(true);
      }
    }
  });

  it('never returns a required slot whose value is undefined', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    for (const slot of slotNames) {
      expect(env[slot], `slot ${slot}`).not.toBeUndefined();
    }
    expect(env.provenance).toBeDefined();
  });

  it('omits an optional slot whose handle is absent, and says so in provenance', () => {
    const shape = artifactsOnlyHandles();
    const env = resolveEnvironment(shape.handles, {
      require: ['paths'],
      optional: ['receipts', 'scheduling'],
    });
    expect(sortedOwnKeys(env)).toEqual(['paths', 'provenance']);
    expect(env.provenance.slots.receipts).toBe('absent');
    expect(env.provenance.slots.scheduling).toBe('absent');
    expect(env.provenance.slots.paths).toBe('present');
  });

  it('omits an optional slot that cannot be constructed rather than failing', () => {
    // A misconfigured network makes the `network` slot unconstructible. Declared
    // optional, that must cost the caller nothing — total slot narrowing is what
    // lets a consumer omit null checks, and a slot nobody required must not be
    // able to fail a resolution.
    const shape = migrateShapedHandles({ networks: {} });
    const env = resolveEnvironment(shape.handles, {
      require: ['chain'],
      optional: ['network'],
    });
    expect(sortedOwnKeys(env)).toEqual(['chain', 'provenance']);
    expect(env.provenance.slots.network).toBe('absent');
  });

  it('provenance is always present, even with an empty require list', () => {
    const env = resolveEnvironment(handles({}), { require: [] });
    expect(env.provenance.slots).toBeDefined();
    expect(sortedOwnKeys(env)).toEqual(['provenance']);
  });

  it('reports every slot name in provenance.slots, present or absent', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect(sortedOwnKeys(env.provenance.slots)).toEqual([...slotNames].sort());
  });
});

describe('AbsolutePath is mintable only by assertion, never by resolution', () => {
  it('refuses a relative working_directory instead of resolving it', () => {
    const shape = migrateShapedHandles({ root: '../shared' });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error.unsatisfied).toHaveLength(1);
    expect(error.unsatisfied[0]?.cause.kind).toBe('invariant-violated');
    expect(error.message).toContain('"working_directory" must be absolute');
    expect(error.message).toContain('../shared');
    expect(error.message).toContain(
      'refuses a relative project anchor rather than resolving it',
    );
  });

  it.each([
    ['a number', 42, 'of type number'],
    ['null', null, 'null'],
    ['an object', { toString: (): string => '/proj' }, 'of type object'],
    ['a boolean', false, 'of type boolean'],
  ])(
    'refuses a working_directory that is %s, naming the type and not the value',
    (_label, value, expectedType) => {
      const shape = migrateShapedHandles({ root: value });
      const error = incompleteFrom(() =>
        resolveEnvironment(shape.handles, { require: ['paths'] }),
      );
      expect(error.message).toContain(
        '"working_directory" must be an absolute path string',
      );
      expect(error.message).toContain(expectedType);
    },
  );

  it('passes an absolute path through byte for byte, with no normalization', () => {
    // A cross-lineage comparison must see what the tool holds, so the seam
    // normalizes nothing — not a trailing separator, not a redundant segment.
    const root = '/proj/./sub/../sub';
    const shape = migrateShapedHandles({
      root,
      contractsDirectory: `${root}/contracts`,
      contractsBuildDirectory: `${root}/build/contracts`,
      buildInfoDirectory: `${root}/build/build-info`,
    });
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect(env.paths.root).toBe(root);
  });
});

describe('derived paths are absolute and external-ness is observed', () => {
  it('reports contractsBuildDirectoryIsExternal false for the default layout', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect(env.paths.contractsBuildDirectoryIsExternal).toBe(false);
    expect(env.paths.root).toBe('/proj');
    expect(env.paths.contractsDirectory).toBe('/proj/contracts');
    expect(env.paths.contractsBuildDirectory).toBe('/proj/build/contracts');
    expect(env.paths.buildInfoDirectory).toBe('/proj/build/build-info');
  });

  it('observes an escaping contracts_build_directory and still resolves', () => {
    // This is how `build/lib/commands/test.js` points the build tree at a
    // temporary directory: `resolvePathInWorkingDirectory` returns early for
    // that one key when `_allowExternalContractsBuildDirectory` is set.
    const shape = migrateShapedHandles({
      contractsBuildDirectory: '/tmp/sf0-external/contracts',
    });
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    expect(env.paths.contractsBuildDirectoryIsExternal).toBe(true);
    expect(env.paths.contractsBuildDirectory).toBe(
      '/tmp/sf0-external/contracts',
    );
  });

  it('refuses an escaping build_info_directory, which TronBox never permits', () => {
    const shape = migrateShapedHandles({
      buildInfoDirectory: '/elsewhere/build-info',
    });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error.message).toContain('"build_info_directory"');
    expect(error.message).toContain('/elsewhere/build-info');
    expect(error.message).toContain('/proj');
    expect(error.message).toContain(
      'TronBox only permits "contracts_build_directory" to escape',
    );
  });

  it('carries exactly one field for the external-ness fact', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    const externalFields = sortedOwnKeys(env.paths).filter(key =>
      /external/i.test(key),
    );
    expect(externalFields).toEqual(['contractsBuildDirectoryIsExternal']);
  });

  it.each([
    'contracts_directory',
    'contracts_build_directory',
    'build_info_directory',
  ])(
    'asserts %s independently rather than inheriting absoluteness from root',
    field => {
      // `Config.prototype.addProp` applies a path key's `transform` on set but
      // calls its `default()` on get, and every path default is a bare
      // `path.join(self.working_directory, …)` that never passes through
      // `transform`. Absoluteness on the default path is inherited, not
      // enforced — so each key is asserted on its own.
      const relative = 'relative/segment';
      const spec: Record<string, unknown> = {};
      if (field === 'contracts_directory') {
        spec.contractsDirectory = relative;
      } else if (field === 'contracts_build_directory') {
        spec.contractsBuildDirectory = relative;
      } else {
        spec.buildInfoDirectory = relative;
      }
      const shape = migrateShapedHandles(spec);
      const error = incompleteFrom(() =>
        resolveEnvironment(shape.handles, { require: ['paths'] }),
      );
      expect(error.message).toContain(`"${field}" must be absolute`);
    },
  );
});

describe('no declared slot field is ever undefined', () => {
  it('normalizes an unconfigured txDefault to null, not to undefined', () => {
    // `deployParameters` declares `tokenValue: undefined`, `tokenId: undefined`
    // and `from: undefined` — not null — and `Config`'s getters forward that
    // verbatim. A downstream `=== null` check for "not configured" silently
    // never fires without this normalization.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.txDefaults.tokenValue).toBeNull();
    expect(env.network.txDefaults.tokenId).toBeNull();
    expect(env.network.txDefaults.callValue).toBeNull();
    expect(env.network.sender.address).toBeNull();
  });

  it('reports the deployParameters constants a real Config would hand back', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.txDefaults.feeLimit).toBe(DEPLOY_PARAMETER_FEE_LIMIT);
    expect(env.network.txDefaults.userFeePercentage).toBe(
      DEPLOY_PARAMETER_USER_FEE_PERCENTAGE,
    );
    expect(env.network.txDefaults.originEnergyLimit).toBe(
      DEPLOY_PARAMETER_ORIGIN_ENERGY_LIMIT,
    );
  });

  it('normalizes an explicit null the same way, and keeps 0 as 0', () => {
    const shape = migrateShapedHandles({
      feeLimit: null,
      callValue: 0,
      tokenId: 0,
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.txDefaults.feeLimit).toBeNull();
    expect(env.network.txDefaults.callValue).toBe(0);
    expect(env.network.txDefaults.tokenId).toBe(0);
  });

  it.each([
    ['feeLimit', '1000000000', 'of type string'],
    ['userFeePercentage', true, 'of type boolean'],
    ['originEnergyLimit', [1], 'an array'],
    ['tokenId', { value: 1 }, 'of type object'],
  ])(
    'refuses a %s that inhabits the wrong type, naming the type not the value',
    (field, value, expectedType) => {
      const shape = migrateShapedHandles({ [field]: value });
      const error = incompleteFrom(() =>
        resolveEnvironment(shape.handles, { require: ['network'] }),
      );
      expect(error.message).toContain(
        `Config field "${field}" must be a number or absent`,
      );
      expect(error.message).toContain(expectedType);
    },
  );

  it('refuses a non-string from rather than coercing it', () => {
    const shape = migrateShapedHandles({ from: 42 });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain(
      'Config field "from" must be a string or absent',
    );
  });

  it('leaves no undefined leaf anywhere in a fully populated composite', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    // `JSON.stringify` drops undefined-valued keys, so a key present in the
    // live composite but missing from the serialized tree held `undefined`.
    const tree = serializedTree(env);
    const liveKeys = new Set(
      reachableObjects(env.network)
        .flatMap(entry => Object.keys(entry.value))
        .concat(Object.keys(env.paths)),
    );
    const serializedKeys = new Set(collectKeys(tree));
    for (const key of liveKeys) {
      expect(serializedKeys.has(key), `key ${key} serialized`).toBe(true);
    }
  });
});

describe('ArtifactResolution is total and only `unique` names `contract`', () => {
  it('returns `unique` with a contract and a source path', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader('Box', 'contracts/Box.sol') },
    );
    const resolution = env.artifacts.resolve('Box');
    expect(resolution.status).toBe('unique');
    if (resolution.status !== 'unique') {
      throw new Error('unreachable');
    }
    expect(resolution.name).toBe('Box');
    expect(resolution.sourcePath).toBe('contracts/Box.sol');
    expect(resolution.contract).toBeDefined();
    expect('unverifiedContract' in resolution).toBe(false);
  });

  it('returns `ambiguous` with every candidate and its originating build-info file', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: collidingReader() },
    );
    const resolution = env.artifacts.resolve('Box');
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') {
      throw new Error('unreachable');
    }
    expect(resolution.candidates).toHaveLength(2);
    expect(resolution.candidates.map(c => c.sourcePath)).toEqual([
      'contracts/Box.sol',
      'contracts/vendor/Box.sol',
    ]);
    for (const candidate of resolution.candidates) {
      expect(candidate.buildInfoFile).toMatch(/build-info/);
      expect(candidate.contractName).toBe('Box');
    }
    // The abstraction is present, but under the name that forbids treating it
    // as verified.
    expect(resolution.unverifiedContract).toBeDefined();
    expect('contract' in resolution).toBe(false);
  });

  it('returns `indeterminate` with a reason naming the mechanism', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: absentReader() },
    );
    const resolution = env.artifacts.resolve('Box');
    expect(resolution.status).toBe('indeterminate');
    if (resolution.status !== 'indeterminate') {
      throw new Error('unreachable');
    }
    expect(resolution.reason.kind).toBe('build-info-absent');
    expect(resolution.unverifiedContract).toBeDefined();
    expect('contract' in resolution).toBe(false);
  });

  it('never carries both names and never substitutes a boolean flag', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: collidingReader() },
    );
    for (const name of ['Box', 'Unique']) {
      const resolution = env.artifacts.resolve(name);
      const keys = sortedOwnKeys(resolution);
      expect(
        keys.includes('contract') && keys.includes('unverifiedContract'),
        `${name} must not carry both abstraction names`,
      ).toBe(false);
      expect(keys.some(key => /^is[A-Z]/.test(key))).toBe(false);
      expect(['unique', 'ambiguous', 'indeterminate']).toContain(
        resolution.status,
      );
    }
  });
});

describe('network identity is three separate fields', () => {
  it.each([
    ['*', 'wildcard'],
    ['**', 'exact'],
    ['*3', 'exact'],
    ['3*', 'exact'],
    [' *', 'exact'],
    ['* ', 'exact'],
    ['', 'exact'],
    ['3', 'exact'],
  ])(
    'derives syntax by strict equality: network_id %j is %s',
    (configuredId, expectedSyntax) => {
      const shape = migrateShapedHandles({
        networks: { development: networkEntry({ networkId: configuredId }) },
      });
      const env = resolveEnvironment(shape.handles, { require: ['network'] });
      expect(env.network.configuredId.value).toBe(configuredId);
      expect(env.network.configuredId.syntax).toBe(expectedSyntax);
    },
  );

  it('keeps artifactNetworkId and configuredId.value as separate facts', () => {
    // `network_id` (what TronBox provisions abstractions with) and
    // `networks[name].network_id` (what the user configured) are read from
    // different places and can differ — under a wildcard the artifact key
    // becomes the literal `networks['*']`.
    const shape = migrateShapedHandles({
      networkId: '3',
      networks: { development: networkEntry({ networkId: '*' }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.artifactNetworkId).toBe('3');
    expect(env.network.configuredId.value).toBe('*');
    expect(env.network.configuredId.syntax).toBe('wildcard');
    expect(env.network.name).toBe('development');
  });

  it('exposes no chain-observed identity field, not even as null', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(sortedOwnKeys(env.network)).toEqual([
      'artifactNetworkId',
      'configuredId',
      'name',
      'sender',
      'signingKeyConfigured',
      'txDefaults',
    ]);
    const allKeys = collectKeys(serializedTree(env.network));
    expect(allKeys).not.toContain('observed');
    expect(allKeys.filter(key => /observed|chainId|live/i.test(key))).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// value normalization — added after the first pass
// ---------------------------------------------------------------------------

describe('value normalization is a closed, enumerated two-entry list', () => {
  /** Both `network_id` sites at once: the raw entry's, and the getter's. */
  function withNetworkId(entryId: unknown, getterId: unknown = entryId) {
    return migrateShapedHandles({
      networkId: getterId,
      networks: { development: networkEntry({ networkId: entryId }) },
    });
  }

  function networkFor(entryId: unknown, getterId: unknown = entryId) {
    return resolveEnvironment(withNetworkId(entryId, getterId).handles, {
      require: ['network'],
    }).network;
  }

  it('produces a deep-equal composite for a numeric and a string network_id', () => {
    // The invariant's own stated test, and the reason the coercion is admitted at
    // all: `build/components/Contract/contract.js:setNetwork` does
    // `network_id + ""` and `:hasNetwork` keys the saved artifact's `networks` map
    // the same way, so `1` and `'1'` reach the host as one string either way. A
    // seam-side refusal would reject a config `Environment.detect` already accepted.
    expect(networkFor(1)).toEqual(networkFor('1'));
    expect(networkFor(1).configuredId).toEqual({ value: '1', syntax: 'exact' });
    expect(networkFor(1).artifactNetworkId).toBe('1');
  });

  it('normalizes at site 1 independently, with the getter already a string', () => {
    // The two-site hazard, made observable. `configuredNetworkId` runs *first* and
    // throws, so before that change the seam was uniform by accident of ordering.
    // Making entry and getter disagree in type isolates each site: here only the
    // entry is numeric, so a fix confined to the getter would fail this.
    expect(networkFor(1, '1')).toEqual(networkFor('1', '1'));
    expect(networkFor(1, '1').configuredId.value).toBe('1');
  });

  it('normalizes at site 2 independently, with the entry already a string', () => {
    // The reverse, and the case that proves site 2 is no longer unreachable: with
    // the entry a string, site 1 no longer throws, so a numeric getter reaches
    // `artifactNetworkId` — where an earlier shape would have relocated the refusal.
    expect(networkFor('1', 1)).toEqual(networkFor('1', '1'));
    expect(networkFor('1', 1).artifactNetworkId).toBe('1');
  });

  it.each([
    ['zero', 0],
    ['negative zero', -0],
    ['NaN', Number.NaN],
  ])('refuses a falsy numeric network_id (%s) rather than coercing it', (
    _label,
    id,
  ) => {
    // `Environment.detect`'s gate reproduced verbatim: `if (!network_id)`. The host
    // refuses `0` while accepting `'0'`, and reproducing that asymmetry is what
    // makes the seam's acceptance set *equal* to the host's rather than a superset.
    // Coercing `0` to `'0'` would have the seam bless a config TronBox then refuses.
    const error = incompleteFrom(() =>
      resolveEnvironment(withNetworkId(id).handles, { require: ['network'] }),
    );
    expect(error.message).toContain('configured without a');
    expect(error.message).toContain('network_id');
    expect(error.message).not.toContain('must be a string');
  });

  it('gives a falsy numeric the same diagnosis as an absent key, not a lookalike', () => {
    // One shared helper, two callers. Those are the same state to the host, so the
    // seam reports what the host reports instead of inventing a second wording for
    // a configuration the host also refuses — and a *shared* function is what keeps
    // the two from drifting into two nearly-identical messages.
    const absent = incompleteFrom(() =>
      resolveEnvironment(
        migrateShapedHandles({
          networks: { development: networkEntry({ omit: ['network_id'] }) },
        }).handles,
        { require: ['network'] },
      ),
    );
    const falsyNumeric = incompleteFrom(() =>
      resolveEnvironment(withNetworkId(0).handles, { require: ['network'] }),
    );
    expect(falsyNumeric.message).toBe(absent.message);
  });

  it("accepts the string '0', pinning the host's asymmetry as intentional", () => {
    const network = networkFor('0');
    expect(network.configuredId).toEqual({ value: '0', syntax: 'exact' });
    expect(network.artifactNetworkId).toBe('0');
  });

  it("leaves '*' a wildcard, which the number branch cannot reach", () => {
    // Condition 4: the coercion runs only on `number` and no number is `'*'`, so
    // the network-identity slot's strict-equality wildcard derivation is
    // structurally out of reach. Asserted rather than reasoned, because the
    // failure mode would be silent.
    expect(networkFor('*').configuredId).toEqual({
      value: '*',
      syntax: 'wildcard',
    });
    for (const numeric of [1, 42, -1, 0.5]) {
      expect(String(numeric)).not.toBe('*');
    }
  });

  it.each([
    ['a bigint', 1n],
    ['a boolean', true],
    ['an object with a toString', { toString: () => '1' }],
    ['an array', ['1']],
  ])('refuses %s, since no other type is coercible', (_label, id) => {
    // Condition 3. `{ toString: … }` is the interesting one: it would coerce
    // perfectly well, and is refused anyway — the list is bounded by evidence that
    // the *host* treats both forms as the same value, not by what JavaScript can
    // stringify.
    const error = incompleteFrom(() =>
      resolveEnvironment(withNetworkId(id).handles, { require: ['network'] }),
    );
    expect(error.message).toContain('must be a string');
  });

  it.each([
    ['a negative integer', -1, '-1'],
    ['an exponential-range integer', 1e21, '1e+21'],
    ['a non-integer', 3.5, '3.5'],
  ])(
    "renders %s exactly as the host's own coercion does",
    (_label, id, expected) => {
      // `String(value)` *is* `network_id + ""`, not a re-implementation of it — so
      // the awkward numbers must render identically rather than plausibly. `1e21`
      // is the case a hand-rolled formatter gets wrong.
      expect(expected).toBe(`${id}`);
      expect(networkFor(id).configuredId.value).toBe(expected);
      expect(networkFor(id).artifactNetworkId).toBe(expected);
    },
  );

  it('reports no fictional disagreement when the two lineages differ only in type', () => {
    // The hazard that makes covering both sites mandatory rather than tidy. Both
    // fields are members of the cross-lineage comparison's closed field set, so
    // one coerced and one raw would compare a number against a string across
    // lineages and report an `inconsistent` that does not exist.
    const shape = testShapedHandles(
      { networkId: 1, networks: { development: networkEntry({ networkId: 1 }) } },
      { networkId: '1' },
    );
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.artifactNetworkId).toBe('1');
    expect(env.network.configuredId.value).toBe('1');
  });

  it('routes both sites through one helper with exactly two call sites', () => {
    // "One place" made mechanical. The AST scan is the same technique the suite
    // uses for the ten absence invariants: adding a third coercion by analogy is
    // exactly how a closed list becomes a precedent, and this is what fails then.
    const networkSource = environmentSources().find(
      source => source.relative === 'network.ts',
    );
    expect(networkSource).toBeDefined();
    const calls = (networkSource?.identifiers ?? []).filter(
      use =>
        use.name === 'normalizeNetworkId' &&
        !use.inTypePosition &&
        !use.isPropertyName,
    );
    // One declaration plus exactly two call sites.
    expect(calls).toHaveLength(3);

    // Module-private: the helper is not exported, so no other module can grow a
    // third site without moving the coercion into the enumerated file first.
    expect(networkSource?.text).toContain('function normalizeNetworkId(');
    expect(networkSource?.text).not.toContain('export function normalizeNetworkId');

    // And `requireString` remains the refusal for every non-enumerated field, so
    // the coercion did not leak outward from `network_id`. Numeric parsing is the
    // shape a second entry would most plausibly arrive as.
    for (const source of environmentSources()) {
      const namespaced = new Set(
        source.accessChains.map(chain => chain.split('.')[0]),
      );
      const coercions = source.identifiers.filter(
        use =>
          !use.inTypePosition &&
          !use.isPropertyName &&
          /^(Number|parseInt|parseFloat)$/.test(use.name) &&
          // `Number.isFinite` is a predicate, not a coercion — the forbidden form
          // is the bare call.
          !namespaced.has(use.name),
      );
      expect(coercions, `${source.relative} coerces a value`).toEqual([]);
    }

    // `String(…)` lives in exactly two modules, and they are different things —
    // worth separating, because conflating them is how the closed list would gain
    // an entry unnoticed. `network.ts`'s is value normalization's coercion and
    // reaches a *slot*; `errors.ts`'s is the cross-lineage comparison's
    // allow-listed value rendering inside `formatValue` and reaches only a
    // *message*, where no cross-lineage comparison can be corrupted by it.
    const stringUsers = new Set(
      environmentSources()
        .filter(source =>
          source.identifiers.some(
            use =>
              use.name === 'String' &&
              !use.inTypePosition &&
              !use.isPropertyName,
          ),
        )
        .map(source => source.relative),
    );
    expect([...stringUsers].sort()).toEqual(['errors.ts', 'network.ts']);
    const errorsSource = environmentSources().find(
      source => source.relative === 'errors.ts',
    );
    expect(errorsSource?.text).toContain('function formatValue(');
  });
});

describe('addresses are tool-verbatim and the sender is always wrapped', () => {
  it.each([
    'TQ5NMqJjhpQGK7YJbESmqLZKmqSXvfRWMR',
    '41aaaabbbbccccddddeeeeffff0000111122223333',
    '0xAAAAbbbbCCCCddddEEEEffff0000111122223333',
  ])('reproduces the configured from byte for byte: %s', address => {
    const shape = migrateShapedHandles({
      networks: { development: networkEntry({ from: address }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.sender.address).toBe(address);
  });

  it('reaches the sender only through the non-authoritative wrapper', () => {
    const address = 'TQ5NMqJjhpQGK7YJbESmqLZKmqSXvfRWMR';
    const shape = migrateShapedHandles({
      networks: { development: networkEntry({ from: address }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.sender.kind).toBe('configured-not-authoritative');

    // Driven from the slot's own key enumeration, so a future field carrying a
    // bare address fails this rather than passing review.
    const leaves = collectKeys(serializedTree(env.network));
    const addressBearing = Object.entries(env.network).filter(
      ([, value]) => value === address,
    );
    expect(addressBearing).toEqual([]);
    expect(leaves).toContain('sender');
    expect(sortedOwnKeys(env.network.sender)).toEqual(['address', 'kind']);
  });

  it('defines no address type and canonicalizes nothing', () => {
    const mixedCase = 'TqQ5nMqJjhpQGK7YJbESmqLZKmqSXvfRWm';
    const shape = migrateShapedHandles({
      networks: { development: networkEntry({ from: mixedCase }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.sender.address).toBe(mixedCase);
    expect(typeof env.network.sender.address).toBe('string');
  });
});

describe('bare-name normalization is one function shared by both key spaces', () => {
  it.each([
    ['Box', 'Box'],
    ['./Box', 'Box'],
    ['Box.sol', 'Box'],
    ['./Box.sol', 'Box'],
    ['./Box.SOL', 'Box'],
    ['Box.sol.sol', 'Box.sol'],
    ['contracts/Box.sol', 'contracts/Box'],
    ['./contracts/Box.sol', 'contracts/Box'],
    ['Box.Sol', 'Box'],
    ['.Box.sol', '.Box'],
    ['././Box.sol', './Box'],
    ['Box.solidity', 'Box.solidity'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeArtifactName(input)).toBe(expected);
  });

  it('uses the same normalization for the resolve path and the index', () => {
    // The index keys on `normalizeArtifactName(contractName)` and `resolve`
    // normalizes its argument with the same function. If the two drifted, the
    // seam would index `Box` while looking up `Box.sol` and report a real
    // collision as unique.
    const shape = migrateShapedHandles({}, { resolvable: ['Box'] });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: collidingReader() },
    );
    for (const input of ['Box', './Box', 'Box.sol', './Box.SOL']) {
      const resolution = env.artifacts.resolve(input);
      expect(resolution.name, input).toBe('Box');
      expect(resolution.status, input).toBe('ambiguous');
    }
    expect(shape.intercept.calls).toEqual(['Box', 'Box', 'Box', 'Box']);
  });

  it('treats a separator-bearing name as a failure with a named diagnosis', () => {
    // `build/components/Resolver/fs.js:FS.prototype.require` returns null for
    // any name containing a path separator, so this is not an addressing form
    // to support — it is a name that must fail informatively.
    const shape = migrateShapedHandles({}, { resolvable: ['Box'] });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    const error = incompleteFrom(() =>
      env.artifacts.resolve('contracts/Box.sol'),
    );
    expect(error.message).toContain('contracts/Box');
    expect(error.message).toContain('The name contains a path separator');
    expect(error.message).toContain('resolvePackaged');
  });
});

describe('the composite is immutable and aliases nothing the host mutates', () => {
  it('is unaffected by a post-resolution mutation of the live network entry', () => {
    const shape = migrateShapedHandles({
      liveGetters: true,
      networks: { development: networkEntry({ from: 'TBefore' }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.sender.address).toBe('TBefore');

    mutableNetworkEntry(shape.config).from = 'TAfter';

    // The host now reports the new value…
    expect(shape.config.from).toBe('TAfter');
    // …and the composite still reports what it resolved.
    expect(env.network.sender.address).toBe('TBefore');
  });

  it('the fixture is genuinely late-bound, so the mutation test is not vacuous', () => {
    // Guards the test above. On a real live `Config` every derived scalar is
    // late-bound through the freshly merged `network_config`; if this fixture
    // were data-property-shaped, the assertion above would pass because the
    // *fixture* copied rather than because the seam did.
    const shape = migrateShapedHandles({
      liveGetters: true,
      networks: { development: networkEntry({ from: 'TBefore' }) },
    });
    expect(shape.config.from).toBe('TBefore');
    mutableNetworkEntry(shape.config).from = 'TAfter';
    expect(shape.config.from).toBe('TAfter');
  });

  it('freezes the composite, every slot, and every nested projection', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const frozen: readonly object[] = [
      env,
      env.paths,
      env.network,
      env.network.txDefaults,
      env.network.configuredId,
      env.network.sender,
      env.chain,
      env.receipts,
      env.scheduling,
      env.output,
      env.artifacts,
      env.provenance,
      env.provenance.slots,
      env.provenance.configLineages,
      env.provenance.internalPathsRead,
    ];
    for (const value of frozen) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('rejects a write to a slot field at runtime, not only in the type', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths'] });
    // `Reflect.set` is the assertion rather than a bare assignment, because the
    // bare assignment would need a type assertion to write through a `readonly`
    // field — and `Reflect.set` reports the same fact precisely: the write is
    // refused, not silently dropped.
    expect(Reflect.set(env.paths, 'root', '/hijacked')).toBe(false);
    expect(() =>
      Object.defineProperty(env.paths, 'root', { value: '/hijacked' }),
    ).toThrow(TypeError);
    expect(env.paths.root).toBe('/proj');
  });

  it('holds no reference to the Config, the networks map, or a network entry', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths', 'network'] });
    const networks = shape.config.networks;
    const forbidden = new Set<unknown>([shape.config, networks]);
    if (typeof networks === 'object' && networks !== null) {
      for (const entry of Object.values(networks)) {
        forbidden.add(entry);
      }
    }
    const reachable = reachableObjects({
      paths: env.paths,
      network: env.network,
      provenance: env.provenance,
    });
    for (const entry of reachable) {
      expect(
        forbidden.has(entry.value),
        `${entry.path} aliases a host-owned object`,
      ).toBe(false);
    }
  });

  it('exposes no host-owned object under the projection slots', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['paths', 'network'] });
    const keys = collectKeys(
      serializedTree({ paths: env.paths, network: env.network }),
    );
    for (const forbidden of ['network_config', '_values', 'networks', 'basePath']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('copies scalars out rather than sharing the merged object', () => {
    // `network_config` is `_.extend({}, default_tx_values, networks[network]||{})`
    // on **every** access, so it cannot be identity-compared and cannot be
    // cached. The composite therefore holds values, and `txDefaults` must be an
    // object the seam minted rather than anything the host produced.
    const shape = migrateShapedHandles({ liveGetters: true });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    const hostObjects = new Set(
      reachableObjects(shape.config).map(entry => entry.value),
    );
    expect(hostObjects.has(env.network.txDefaults)).toBe(false);
    expect(hostObjects.has(env.network.sender)).toBe(false);
    expect(hostObjects.has(env.network.configuredId)).toBe(false);
    expect(Object.keys(tronWrapHandle())).toEqual(['trx']);
  });
});
