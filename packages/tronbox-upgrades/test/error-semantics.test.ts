import { describe, expect, it } from 'vitest';
import {
  ArtifactNameAmbiguousError,
  compilerConfigLineageFields,
  configLineageFields,
  EnvironmentAbsentError,
  EnvironmentIncompleteError,
  EnvironmentInconsistentError,
  getDeclaredTronBoxRange,
  networkConfigLineageFields,
  pathConfigLineageFields,
  resolveEnvironment,
  slotNames,
  slotRequirements,
  TronBoxEnvironmentError,
  type ConfigScalarField,
  type SlotName,
} from '../src/environment';
import * as errorsModule from '../src/environment/errors';
import {
  mutableNetworkEntry,
  networkEntry,
  type ConfigFixtureSpec,
} from './helpers/config-fixtures';
import {
  artifactsOnlyHandles,
  deployerOnlyHandles,
  handles,
  interceptFixture,
  migrateShapedHandles,
  shallowDeployerHandle,
  testShapedHandles,
  tronWrapHandle,
} from './helpers/handles';
import { collectLeaves, serializedTree } from './helpers/introspect';
import { environmentSources } from './helpers/source-scan';
import { readJsonFile } from './helpers/locate';
import path from 'node:path';
import { packageRoot } from './helpers/locate';
import {
  absolute,
  existenceProbeReader,
  singleContractReader,
  throwingProbeReader,
} from './helpers/readers';

/**
 * Error Semantics — INV-10 … INV-19.
 *
 * Technique: fault injection. Every guard at the seam boundary gets a fault that
 * exercises it, and every assertion names the typed error class rather than
 * asserting that "something threw" — a bare `toThrow()` here would let a
 * `TypeError` from an unguarded host read pass for a diagnosis.
 */

const ABSENT_PHRASE = 'outside a TronBox migration context';

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

function inconsistentFrom(act: () => unknown): EnvironmentInconsistentError {
  const error = caught(act);
  expect(error).toBeInstanceOf(EnvironmentInconsistentError);
  if (!(error instanceof EnvironmentInconsistentError)) {
    throw new Error('unreachable');
  }
  return error;
}

describe('INV-10: exactly three diagnoses, with code derived from diagnosis', () => {
  it('exports exactly three TronBoxEnvironmentError subclasses', () => {
    // Enumerated from the module rather than listed by hand, so a fourth
    // "config problem" class added later fails a test instead of passing review.
    const family = Object.entries(errorsModule)
      .filter(
        ([, value]) =>
          typeof value === 'function' &&
          value.prototype instanceof TronBoxEnvironmentError,
      )
      .map(([name]) => name)
      .sort();
    expect(family).toEqual([
      'EnvironmentAbsentError',
      'EnvironmentIncompleteError',
      'EnvironmentInconsistentError',
    ]);
  });

  it('derives every code from its diagnosis', () => {
    const instances: readonly TronBoxEnvironmentError[] = [
      new EnvironmentAbsentError(['paths']),
      new EnvironmentIncompleteError([
        {
          slot: 'paths',
          cause: { kind: 'invariant-violated', detail: 'detail' },
          providedIn: [],
          absentIn: [],
        },
      ]),
      new EnvironmentInconsistentError([{ kind: 'chain-handle-conflict' }]),
    ];
    const diagnoses = new Set<string>();
    for (const instance of instances) {
      expect(instance.code).toBe(
        `TRONBOX_ENV_${instance.diagnosis.toUpperCase()}`,
      );
      expect(instance).toBeInstanceOf(Error);
      expect(instance.name).toBe(instance.constructor.name);
      diagnoses.add(instance.diagnosis);
    }
    expect([...diagnoses].sort()).toEqual([
      'absent',
      'incomplete',
      'inconsistent',
    ]);
  });

  it('keeps ArtifactNameAmbiguousError outside the family', () => {
    // SF-5 throws it if refusal is the policy it chooses; SF-0 never does. It is
    // deliberately not a fourth member of a three-member taxonomy.
    const error = new ArtifactNameAmbiguousError('Box', [
      {
        sourcePath: 'contracts/Box.sol',
        contractName: 'Box',
        buildInfoFile: absolute('/proj/build/build-info/a.output.json'),
      },
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TronBoxEnvironmentError);
    expect(error.message).toContain('Box');
    expect(error.message).toContain('contracts/Box.sol');
    expect(error.message).toContain('a.output.json');
  });
});

describe('INV-11: the diagnosis partition is total and mutually exclusive', () => {
  it('absent: no handle bearing on any requested slot was supplied', () => {
    const error = caught(() =>
      resolveEnvironment(handles({}), { require: ['paths'] }),
    );
    expect(error).toBeInstanceOf(EnvironmentAbsentError);
    if (!(error instanceof EnvironmentAbsentError)) {
      throw new Error('unreachable');
    }
    expect(error.message).toContain(ABSENT_PHRASE);
    expect(error.requested).toEqual(['paths']);
  });

  it('absent: an omitted handles argument is the same diagnosis', () => {
    const error = caught(() =>
      resolveEnvironment(undefined, { require: ['paths', 'chain'] }),
    );
    expect(error).toBeInstanceOf(EnvironmentAbsentError);
  });

  it('incomplete: a handle bearing on another requested slot was supplied', () => {
    const shape = artifactsOnlyHandles();
    const error = incompleteFrom(() =>
      resolveEnvironment(
        shape.handles,
        { require: ['artifacts', 'scheduling'] },
        { buildInfoReader: singleContractReader() },
      ),
    );
    expect(error.message).not.toContain(ABSENT_PHRASE);
    expect(error.unsatisfied.map(item => item.slot)).toContain('scheduling');
  });

  it('incomplete: a handle present but lacking the property path', () => {
    const error = incompleteFrom(() =>
      resolveEnvironment(
        handles({ deployer: shallowDeployerHandle(1) }),
        { require: ['paths'] },
      ),
    );
    expect(error.message).not.toContain(ABSENT_PHRASE);
    expect(error.message).toContain('"deployer.options.options"');
  });

  it('incomplete: a boundary invariant violated', () => {
    const shape = migrateShapedHandles({ root: 'relative' });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error.message).not.toContain(ABSENT_PHRASE);
    expect(error.unsatisfied[0]?.cause.kind).toBe('invariant-violated');
  });

  it('inconsistent: every required capability constructed and the sources disagree', () => {
    const shape = testShapedHandles(
      {},
      { contractsDirectory: '/proj/contracts-alt' },
    );
    const error = inconsistentFrom(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error.message).not.toContain(ABSENT_PHRASE);
    expect(error.inconsistencies).toHaveLength(1);
    expect(error.inconsistencies[0]).toEqual({
      kind: 'config-lineage-field',
      field: 'contracts_directory',
      viaDeployer: '/proj/contracts-alt',
      viaArtifacts: '/proj/contracts',
    });
  });

  it('uses the "outside a migration context" phrase for absent only', () => {
    // This is acceptance scenario 3's requirement. The common real mistake — a
    // developer inside a migration who omitted one handle — used to be reported
    // as "you are not in a migration", which sends them to the wrong docs.
    const nonAbsent: readonly (() => unknown)[] = [
      () =>
        resolveEnvironment(handles({ deployer: shallowDeployerHandle(1) }), {
          require: ['paths'],
        }),
      () =>
        resolveEnvironment(migrateShapedHandles({ root: 'rel' }).handles, {
          require: ['paths'],
        }),
      () =>
        resolveEnvironment(migrateShapedHandles({ networks: {} }).handles, {
          require: ['network'],
        }),
      () =>
        resolveEnvironment(
          testShapedHandles({}, { contractsDirectory: '/x/y' }).handles,
          { require: ['paths'] },
        ),
    ];
    for (const act of nonAbsent) {
      const error = caught(act);
      expect(error).toBeInstanceOf(TronBoxEnvironmentError);
      expect(error).not.toBeInstanceOf(EnvironmentAbsentError);
      expect((error as Error).message).not.toContain(ABSENT_PHRASE);
    }
  });

  it('throws incomplete strictly before inconsistent', () => {
    // Both faults are present: the network slot cannot be constructed, and the
    // two chain handles are different objects. The staging rule means the
    // unconstructible capability is reported, never the disagreement.
    const shape = migrateShapedHandles({ networks: {} });
    const conflicted = handles({
      deployer: shape.handles.deployer,
      artifacts: shape.handles.artifacts,
      tronWrap: tronWrapHandle(),
      tronWeb: tronWrapHandle(),
    });
    const error = incompleteFrom(() =>
      resolveEnvironment(conflicted, { require: ['network', 'chain'] }),
    );
    expect(error.unsatisfied.map(item => item.slot)).toEqual(['network']);

    // With the network configured, the very same handle set reports the
    // disagreement — so it was the ordering, not the absence of a conflict.
    const healthy = migrateShapedHandles();
    const alsoConflicted = handles({
      deployer: healthy.handles.deployer,
      artifacts: healthy.handles.artifacts,
      tronWrap: tronWrapHandle(),
      tronWeb: tronWrapHandle(),
    });
    const conflict = inconsistentFrom(() =>
      resolveEnvironment(alsoConflicted, { require: ['network', 'chain'] }),
    );
    expect(conflict.inconsistencies).toEqual([{ kind: 'chain-handle-conflict' }]);
  });
});

describe('INV-12: no preference path exists between the two Config lineages', () => {
  it('carries both disagreeing values verbatim', () => {
    const shape = testShapedHandles({}, { feeLimit: 42 });
    const error = inconsistentFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.inconsistencies).toHaveLength(1);
    expect(error.message).toContain('Config field "feeLimit" disagrees');
    expect(error.message).toContain('via deployer=42');
    expect(error.message).toContain('via artifacts=1000000000');
  });

  it('does not throw for a single reachable lineage, and states the reduced mode', () => {
    const deployerOnly = resolveEnvironment(
      deployerOnlyHandles().handles,
      { require: ['paths', 'network'] },
    );
    expect(deployerOnly.provenance.configLineages.crossChecked).toBe(false);
    expect(
      deployerOnly.provenance.configLineages.crossCheckSkippedBecause,
    ).toBe('only-deployer-lineage-available');

    const artifactsOnly = resolveEnvironment(artifactsOnlyHandles().handles, {
      require: ['paths', 'network'],
    });
    expect(artifactsOnly.provenance.configLineages.crossChecked).toBe(false);
    expect(
      artifactsOnly.provenance.configLineages.crossCheckSkippedBecause,
    ).toBe('only-artifacts-lineage-available');
  });

  it('refuses to use the lineage that worked when the other one cannot construct', () => {
    // Preferring the working lineage would be exactly the silent preference
    // INV-12 forbids, and it would be a third reduced-verification mode, which
    // INV-34 caps at two. Both lineages reachable means both must construct.
    const shape = testShapedHandles({}, { omit: ['contracts_directory'] });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error.unsatisfied).toHaveLength(1);
    expect(error.message).toContain(
      'property path "deployer.options.options.contracts_directory" is absent',
    );
  });

  it('the word "fallback" describes no code path in config-lineage.ts', () => {
    const lineageModule = environmentSources().find(
      source => source.relative === 'config-lineage.ts',
    );
    expect(lineageModule).toBeDefined();
    const identifiers = lineageModule?.identifiers ?? [];
    expect(
      identifiers.filter(use => /fallback|prefer/i.test(use.name)),
    ).toEqual([]);
    expect(
      (lineageModule?.stringLiterals ?? []).filter(literal =>
        /fallback/i.test(literal),
      ),
    ).toEqual([]);
  });
});

/**
 * One disagreement per allow-listed field.
 *
 * This is simultaneously INV-12's "no preference at any nesting depth", INV-13's
 * "the list covers every exposed scalar" and INV-41's "the payload is
 * allow-listed" — a field that is exposed but *not* compared silently
 * reinstates the preference hole for that one field, and this table is what
 * makes the coverage mechanical rather than asserted in prose.
 */
interface FieldDisagreement {
  readonly field: ConfigScalarField;
  readonly require: readonly SlotName[];
  readonly live?: ConfigFixtureSpec;
  readonly snapshot: ConfigFixtureSpec;
  readonly viaDeployer: unknown;
  readonly viaArtifacts: unknown;
}

const sameIdNetworks = {
  development: networkEntry({ networkId: '*' }),
  nile: networkEntry({ networkId: '*' }),
};

const fieldDisagreements: readonly FieldDisagreement[] = [
  {
    field: 'working_directory',
    require: ['paths'],
    snapshot: {
      root: '/proj/',
      contractsDirectory: '/proj/contracts',
      contractsBuildDirectory: '/proj/build/contracts',
      buildInfoDirectory: '/proj/build/build-info',
    },
    viaDeployer: '/proj/',
    viaArtifacts: '/proj',
  },
  {
    field: 'contracts_directory',
    require: ['paths'],
    snapshot: { contractsDirectory: '/proj/contracts-alt' },
    viaDeployer: '/proj/contracts-alt',
    viaArtifacts: '/proj/contracts',
  },
  {
    field: 'contracts_build_directory',
    require: ['paths'],
    snapshot: { contractsBuildDirectory: '/proj/build/contracts-alt' },
    viaDeployer: '/proj/build/contracts-alt',
    viaArtifacts: '/proj/build/contracts',
  },
  {
    field: 'build_info_directory',
    require: ['paths'],
    snapshot: { buildInfoDirectory: '/proj/build/build-info-alt' },
    viaDeployer: '/proj/build/build-info-alt',
    viaArtifacts: '/proj/build/build-info',
  },
  {
    field: 'network',
    require: ['network'],
    live: { networks: sameIdNetworks },
    snapshot: { network: 'nile', networks: sameIdNetworks },
    viaDeployer: 'nile',
    viaArtifacts: 'development',
  },
  {
    field: 'network_id',
    require: ['network'],
    snapshot: { networkId: '9' },
    viaDeployer: '9',
    viaArtifacts: '*',
  },
  {
    field: 'networks[network].network_id',
    require: ['network'],
    snapshot: {
      networkId: '*',
      networks: { development: networkEntry({ networkId: '3' }) },
    },
    viaDeployer: '3',
    viaArtifacts: '*',
  },
  {
    field: 'from',
    require: ['network'],
    snapshot: { from: 'TOther' },
    viaDeployer: 'TOther',
    viaArtifacts: null,
  },
  {
    field: 'feeLimit',
    require: ['network'],
    snapshot: { feeLimit: 123 },
    viaDeployer: 123,
    viaArtifacts: 1_000_000_000,
  },
  {
    field: 'userFeePercentage',
    require: ['network'],
    snapshot: { userFeePercentage: 50 },
    viaDeployer: 50,
    viaArtifacts: 100,
  },
  {
    field: 'originEnergyLimit',
    require: ['network'],
    snapshot: { originEnergyLimit: 1 },
    viaDeployer: 1,
    viaArtifacts: 10_000_000,
  },
  {
    field: 'callValue',
    require: ['network'],
    snapshot: { callValue: 5 },
    viaDeployer: 5,
    viaArtifacts: null,
  },
  {
    field: 'tokenValue',
    require: ['network'],
    snapshot: { tokenValue: 7 },
    viaDeployer: 7,
    viaArtifacts: null,
  },
  {
    field: 'tokenId',
    require: ['network'],
    snapshot: { tokenId: 9 },
    viaDeployer: 9,
    viaArtifacts: null,
  },
  {
    field: 'signingKeyConfigured',
    require: ['network'],
    snapshot: {
      networks: { development: networkEntry({ omit: ['privateKey'] }) },
    },
    viaDeployer: false,
    viaArtifacts: true,
  },
  // The five compiler scalars. Each one is *isolated* — the host's precedence
  // chain derives all five from the same keys, so the obvious fixture for one of
  // them moves three, and this catalogue's `toHaveLength(1)` is what forces each
  // entry to name a configuration that moves exactly one.
  {
    field: 'compiler.resolvedVersion',
    require: ['compiler'],
    // Both lineages configure a version, so `versionIsHostDefault` is `false` on
    // both and only the version itself differs.
    live: { extra: { compilers: { solc: { version: '0.8.20' } } } },
    snapshot: { extra: { compilers: { solc: { version: '0.8.19' } } } },
    viaDeployer: '0.8.19',
    viaArtifacts: '0.8.20',
  },
  {
    field: 'compiler.family',
    require: ['compiler'],
    snapshot: { extra: { evm: true } },
    viaDeployer: 'evm',
    viaArtifacts: 'tvm',
  },
  {
    field: 'compiler.viaLegacyFlag',
    require: ['compiler'],
    // The snapshot configures the *same* version the flag would have selected, so
    // `resolvedVersion` and `versionIsHostDefault` agree and only the attribution
    // differs — which is the whole point of reporting the flag separately.
    live: {
      networks: { development: networkEntry(), useZeroFourCompiler: true },
    },
    snapshot: {
      networks: { development: networkEntry() },
      extra: { compilers: { solc: { version: '0.4.25' } } },
    },
    viaDeployer: null,
    viaArtifacts: 'useZeroFourCompiler',
  },
  {
    field: 'compiler.versionIsHostDefault',
    require: ['compiler'],
    // Configuring exactly the host's own default is the only way to move this
    // flag without also moving `resolvedVersion`.
    snapshot: { extra: { compilers: { solc: { version: '0.8.26' } } } },
    viaDeployer: false,
    viaArtifacts: true,
  },
  {
    field: 'compiler.settingsSource',
    require: ['compiler'],
    live: {
      extra: {
        compilers: { solc: { settings: { optimizer: { enabled: true } } } },
      },
    },
    snapshot: { extra: {} },
    viaDeployer: 'none',
    viaArtifacts: 'compilers.solc.settings',
  },
];

describe('INV-13 / INV-41: the cross-check allow-list covers every exposed scalar', () => {
  it.each(fieldDisagreements.map(entry => [entry.field, entry] as const))(
    'reports a disagreement on %s and on nothing else',
    (_field, entry) => {
      const shape = testShapedHandles(entry.live ?? {}, entry.snapshot);
      const error = inconsistentFrom(() =>
        resolveEnvironment(shape.handles, { require: entry.require }),
      );
      expect(error.inconsistencies).toHaveLength(1);
      expect(error.inconsistencies[0]).toEqual({
        kind: 'config-lineage-field',
        field: entry.field,
        viaDeployer: entry.viaDeployer,
        viaArtifacts: entry.viaArtifacts,
      });
    },
  );

  it('covers every member of ConfigScalarField', () => {
    expect([...configLineageFields].sort()).toEqual(
      [...fieldDisagreements.map(entry => entry.field)].sort(),
    );
  });

  it('is the union of the three field groups, with no duplicates', () => {
    expect(configLineageFields).toEqual([
      ...pathConfigLineageFields,
      ...networkConfigLineageFields,
      ...compilerConfigLineageFields,
    ]);
    expect(new Set(configLineageFields).size).toBe(configLineageFields.length);
    expect(configLineageFields).toHaveLength(20);
  });

  it('maps every lineage-derived scalar the composite exposes to a compared field', () => {
    // Derived from the composite at runtime, so adding a slot field without
    // adding it to the allow-list fails here rather than passing review.
    const derivedInsteadOfRead: readonly string[] = [
      'paths.contractsBuildDirectoryIsExternal',
      'network.configuredId.syntax',
      'network.sender.kind',
    ];
    // `CompilerConfiguration.settings` is the one lineage-derived member that is
    // not a scalar, so it is deliberately outside the compared groups — INV-41
    // renders every compared field verbatim, and a user-supplied object must never
    // be subjected to that. It is cross-checked by identity instead, and a
    // disagreement is the payload-free `compiler-settings-conflict`. Listed here so
    // the exclusion is a named fact rather than a gap in this assertion.
    const comparedByIdentityInstead: readonly string[] = [
      'compiler.settings.evmVersion',
    ];
    const exposedToField: Readonly<Record<string, ConfigScalarField>> = {
      'paths.root': 'working_directory',
      'paths.contractsDirectory': 'contracts_directory',
      'paths.contractsBuildDirectory': 'contracts_build_directory',
      'paths.buildInfoDirectory': 'build_info_directory',
      'network.name': 'network',
      'network.artifactNetworkId': 'network_id',
      'network.configuredId.value': 'networks[network].network_id',
      'network.sender.address': 'from',
      'network.txDefaults.feeLimit': 'feeLimit',
      'network.txDefaults.userFeePercentage': 'userFeePercentage',
      'network.txDefaults.originEnergyLimit': 'originEnergyLimit',
      'network.txDefaults.callValue': 'callValue',
      'network.txDefaults.tokenValue': 'tokenValue',
      'network.txDefaults.tokenId': 'tokenId',
      'network.signingKeyConfigured': 'signingKeyConfigured',
      'compiler.resolvedVersion': 'compiler.resolvedVersion',
      'compiler.family': 'compiler.family',
      'compiler.viaLegacyFlag': 'compiler.viaLegacyFlag',
      'compiler.versionIsHostDefault': 'compiler.versionIsHostDefault',
      'compiler.settingsSource': 'compiler.settingsSource',
    };

    const shape = migrateShapedHandles({
      // The legacy flag makes `viaLegacyFlag` present rather than absent, and one
      // scalar inside `settings` makes that exclusion an observed leaf: both
      // fields would otherwise be silently skipped by an assertion whose whole
      // job is to leave nothing out.
      networks: {
        development: networkEntry({ from: 'TFrom' }),
        useZeroFourCompiler: true,
      },
      callValue: 1,
      tokenValue: 2,
      tokenId: 3,
      extra: {
        compilers: { solc: { settings: { evmVersion: 'istanbul' } } },
      },
    });
    const env = resolveEnvironment(shape.handles, {
      require: ['paths', 'network', 'compiler'],
    });
    const observed = collectLeaves(
      serializedTree({
        paths: env.paths,
        network: env.network,
        compiler: env.compiler,
      }),
    ).map(leaf => leaf.path);

    expect([...observed].sort()).toEqual(
      [
        ...Object.keys(exposedToField),
        ...derivedInsteadOfRead,
        ...comparedByIdentityInstead,
      ].sort(),
    );
    expect([...new Set(Object.values(exposedToField))].sort()).toEqual(
      [...configLineageFields].sort(),
    );
  });

  it('compares only the fields it was handed, never Object.keys of the lineage', () => {
    // An extra own key on the lineage — the "next upstream release adds a key"
    // scenario — must never enter a comparison or a message.
    const shape = testShapedHandles(
      { extra: { futureUpstreamKey: 'live-value' } },
      { extra: { futureUpstreamKey: 'snapshot-value' }, feeLimit: 5 },
    );
    const error = inconsistentFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.inconsistencies).toHaveLength(1);
    expect(error.inconsistencies[0]?.kind).toBe('config-lineage-field');
    expect(error.message).not.toContain('futureUpstreamKey');
    expect(error.message).not.toContain('live-value');
    expect(error.message).not.toContain('snapshot-value');
  });
});

describe('INV-14: incomplete names the property path and the providing contexts', () => {
  it('exports a slot table that partitions the five invocation contexts', () => {
    expect([...Object.keys(slotRequirements)].sort()).toEqual(
      [...slotNames].sort(),
    );
    const allContexts = new Set([
      'tronbox migrate',
      'tronbox test migration phase',
      'tronbox test mocha files',
      'tronbox console',
      'plain node',
    ]);
    for (const slot of slotNames) {
      const requirement = slotRequirements[slot];
      const provided = new Set(requirement.providedIn);
      const absent = new Set(requirement.absentIn);
      expect(provided.size, `${slot} providedIn is a set`).toBe(
        requirement.providedIn.length,
      );
      expect(
        [...provided].filter(context => absent.has(context)),
        `${slot} providedIn and absentIn are disjoint`,
      ).toEqual([]);
      expect(
        new Set([...provided, ...absent]),
        `${slot} covers every context`,
      ).toEqual(allContexts);
      expect(requirement.handles.length, `${slot} names a handle`).toBeGreaterThan(0);
      expect(Object.isFrozen(requirement)).toBe(true);
      expect(Object.isFrozen(requirement.providedIn)).toBe(true);
      expect(Object.isFrozen(requirement.absentIn)).toBe(true);
    }
  });

  it('matches the invocation-context matrix Research established', () => {
    // The one place the matrix is restated. Every message assertion below reads
    // the table instead, so a table edit that contradicts Research fails here
    // and nowhere else.
    expect(
      Object.fromEntries(
        slotNames.map(slot => [slot, [...slotRequirements[slot].providedIn]]),
      ),
    ).toEqual({
      paths: [
        'tronbox migrate',
        'tronbox test migration phase',
        'tronbox test mocha files',
      ],
      network: [
        'tronbox migrate',
        'tronbox test migration phase',
        'tronbox test mocha files',
      ],
      artifacts: [
        'tronbox migrate',
        'tronbox test migration phase',
        'tronbox test mocha files',
      ],
      chain: [
        'tronbox migrate',
        'tronbox test migration phase',
        'tronbox test mocha files',
        'tronbox console',
      ],
      receipts: [
        'tronbox migrate',
        'tronbox test migration phase',
        'tronbox test mocha files',
      ],
      scheduling: ['tronbox migrate', 'tronbox test migration phase'],
      output: [
        'tronbox migrate',
        'tronbox test migration phase',
        // Re-pinned at revision 3. `output` moved from `deployerContexts` to
        // `configContexts` because the table was internally inconsistent: the
        // `artifacts` handle *is* present under `tronbox test` mocha files, and
        // `output.handles` has always named it, so listing that context as absent
        // described a capability the seam does have as one it does not. Design
        // Decision 13 chose widening `providedIn` over narrowing `handles`
        // precisely because narrowing would have decided SF-4's still-open
        // mocha-scope question by omission.
        'tronbox test mocha files',
      ],
      // Added at revision 5 with the compiler slot. Purely lineage-derived, so it
      // reads `paths`/`network`'s row: wherever a Config lineage is reachable the
      // compiler configuration is constructible, and nowhere else.
      compiler: [
        'tronbox migrate',
        'tronbox test migration phase',
        'tronbox test mocha files',
      ],
    });
    expect(
      Object.fromEntries(
        slotNames.map(slot => [slot, [...slotRequirements[slot].handles]]),
      ),
    ).toEqual({
      paths: ['deployer', 'artifacts'],
      network: ['deployer', 'artifacts'],
      artifacts: ['artifacts'],
      chain: ['tronWrap', 'tronWeb'],
      receipts: ['waitForTransactionReceipt'],
      scheduling: ['deployer'],
      output: ['deployer', 'artifacts'],
      compiler: ['deployer', 'artifacts'],
    });
  });

  it('keeps scheduling narrow while output widened, and derives absentIn from it', () => {
    // The three facts the re-pin above does not state, each of which is a way the
    // correction could have been made wrongly and passed.
    //
    // (1) `scheduling` did **not** widen alongside `output`. Both slots read
    // `deployerContexts`, so the most plausible careless form of this edit — moving
    // the *shared constant* instead of the one slot — would widen `scheduling` too
    // and silently claim the deployer is available under `tronbox test` mocha files,
    // where it is not. Asserted explicitly rather than relied on from the matrix
    // above, because that assertion would still pass if both rows moved together and
    // somebody updated both expectations.
    expect([...slotRequirements.scheduling.providedIn]).toEqual([
      'tronbox migrate',
      'tronbox test migration phase',
    ]);
    expect([...slotRequirements.scheduling.absentIn]).toEqual([
      'tronbox test mocha files',
      'tronbox console',
      'plain node',
    ]);

    // (2) `absentIn` derived itself. `contextsExcept` computes it, which is why the
    // table could be internally inconsistent in the first place without any
    // mechanism noticing — and why the corrected row needed no second edit.
    expect([...slotRequirements.output.absentIn]).toEqual([
      'tronbox console',
      'plain node',
    ]);

    // (3) `output` now agrees with `paths`, which is the shape the correction was
    // aiming at: both are satisfiable from either Config lineage, so both are
    // available wherever a lineage is.
    expect([...slotRequirements.output.providedIn]).toEqual([
      ...slotRequirements.paths.providedIn,
    ]);
    expect([...slotRequirements.output.handles]).toEqual(['deployer', 'artifacts']);

    // And the two slots that share the `deployer` handle are now provably distinct
    // in the table, so a future edit cannot conflate them without failing here.
    expect([...slotRequirements.output.providedIn]).not.toEqual([
      ...slotRequirements.scheduling.providedIn,
    ]);
    expect(slotRequirements.scheduling.handles).toContain('deployer');
    expect(slotRequirements.output.handles).toContain('deployer');
  });

  it.each(slotNames.filter(slot => slot !== 'chain'))(
    'renders %s context lists from the table, never from the throw site',
    slot => {
      const error = incompleteFrom(() =>
        resolveEnvironment(handles({ tronWrap: tronWrapHandle() }), {
          require: [slot, 'chain'],
        }),
      );
      const requirement = slotRequirements[slot];
      expect(error.message).toContain(
        `provided in ${requirement.providedIn.join(', ')}`,
      );
      expect(error.message).toContain(
        `absent in ${requirement.absentIn.join(', ')}`,
      );
      expect(error.message).toContain(`slot "${slot}"`);
    },
  );

  it('renders the chain slot context lists from the table too', () => {
    const shape = deployerOnlyHandles();
    const error = incompleteFrom(() =>
      resolveEnvironment(handles({ deployer: shape.deployer }), {
        require: ['chain', 'scheduling'],
      }),
    );
    const requirement = slotRequirements.chain;
    expect(error.message).toContain(
      `provided in ${requirement.providedIn.join(', ')}`,
    );
    expect(error.message).toContain(
      `absent in ${requirement.absentIn.join(', ')}`,
    );
  });

  it('names the handle for a handle-missing cause', () => {
    const shape = artifactsOnlyHandles();
    const error = incompleteFrom(() =>
      resolveEnvironment(
        shape.handles,
        { require: ['artifacts', 'scheduling'] },
        { buildInfoReader: singleContractReader() },
      ),
    );
    const scheduling = error.unsatisfied.find(item => item.slot === 'scheduling');
    expect(scheduling?.cause).toEqual({
      kind: 'handle-missing',
      handle: 'deployer',
    });
    expect(error.message).toContain(
      'slot "scheduling" needs one of [deployer]; handle "deployer" was not supplied',
    );
  });

  it('names the exact property path for a handle-malformed cause that is absent', () => {
    const error = incompleteFrom(() =>
      resolveEnvironment(handles({ deployer: shallowDeployerHandle(0) }), {
        require: ['paths'],
      }),
    );
    expect(error.unsatisfied[0]?.cause).toEqual({
      kind: 'handle-malformed',
      handle: 'deployer',
      expectedPath: 'deployer.options',
      because: 'missing',
    });
    expect(error.message).toContain(
      'property path "deployer.options" is absent',
    );
  });

  it('says "threw when read" when a host accessor raised', () => {
    const shape = migrateShapedHandles({ throwOn: ['contracts_directory'] });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error.unsatisfied[0]?.cause).toEqual({
      kind: 'handle-malformed',
      handle: 'deployer',
      expectedPath: 'deployer.options.options.contracts_directory',
      because: 'threw',
    });
    expect(error.message).toContain('threw when read');
    expect(error.message).not.toContain('is absent');
  });

  it('names the detail for an invariant-violated cause', () => {
    const shape = migrateShapedHandles({ networks: {} });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain(
      'slot "network" violates an environment invariant:',
    );
    expect(error.message).toContain('the selected network "development"');
  });

  it('regression: an unsupplied deployer is handle-missing, not handle-malformed', () => {
    // Code Draft defect 4: the external draft reported `handle-malformed` with
    // `expectedPath: 'deployer.options.options'` when the handle had simply not
    // been supplied, which sends the user hunting for a broken object they do
    // not have.
    const shape = artifactsOnlyHandles();
    const error = incompleteFrom(() =>
      resolveEnvironment(
        shape.handles,
        { require: ['artifacts', 'scheduling'] },
        { buildInfoReader: singleContractReader() },
      ),
    );
    for (const item of error.unsatisfied) {
      if (item.cause.kind === 'handle-malformed') {
        expect(item.cause.expectedPath).not.toBe('deployer.options.options');
      }
    }
    expect(error.message).not.toContain('malformed handle "deployer"');
  });

  /**
   * D-1, fixed at its root and now a regression test.
   *
   * The defect: for the `output` slot only, an `artifacts` handle that was never
   * supplied was diagnosed `handle-malformed` naming `artifacts.resolver.options`
   * — a property path on an object the caller was never asked to supply. The
   * cause was `output.ts:fromLineageAttempt` mapping the `absent` lineage attempt
   * onto `malformed(handle, fallbackPath, 'missing')`; that function is gone,
   * `OutputSlotAttempt` gained a path-free `noBearingHandle` member, and
   * `resolve.ts` mints `handle-missing` from the slot table exactly as it does for
   * the other six slots.
   *
   * Reachable whenever another requested slot has a bearing handle — e.g.
   * `require: ['chain', 'output']` under `tronbox console`, which the slot table
   * itself lists as providing `chain` and not `output`. Kept as a named test
   * rather than folded into INV-11's coverage, so a re-regression is reported as
   * D-1 rather than as a generic partition failure.
   */
  it('D-1: an unsupplied artifacts handle is handle-missing for the output slot', () => {
    const error = incompleteFrom(() =>
      resolveEnvironment(handles({ tronWrap: tronWrapHandle() }), {
        require: ['chain', 'output'],
      }),
    );
    const output = error.unsatisfied.filter(item => item.slot === 'output');
    // One entry per bearing handle the caller did not supply, read from the slot
    // table — so `output` reports the same two-handle shape `paths` and `network`
    // do, rather than a single invented one.
    expect(output.map(item => item.cause)).toEqual([
      { kind: 'handle-missing', handle: 'deployer' },
      { kind: 'handle-missing', handle: 'artifacts' },
    ]);
    expect(
      slotRequirements.output.handles,
      'the diagnosis must be derived from the slot table, not restated',
    ).toEqual(['deployer', 'artifacts']);
  });

  it('D-1: names no property path on a handle nobody supplied', () => {
    // The user-visible half. The old message sent someone hunting for a broken
    // `artifacts.resolver.options`; there is no such object to inspect when no
    // `artifacts` was passed, so naming it is worse than saying nothing.
    const error = incompleteFrom(() =>
      resolveEnvironment(handles({ tronWrap: tronWrapHandle() }), {
        require: ['chain', 'output'],
      }),
    );
    expect(error.message).not.toContain('artifacts.resolver.options');
    expect(error.message).not.toContain('malformed handle');
    expect(error.message).toContain('output');
    for (const item of error.unsatisfied) {
      expect(item.cause.kind).toBe('handle-missing');
      expect(JSON.stringify(item.cause)).not.toContain('expectedPath');
    }
  });

  it('D-1: still reports handle-malformed when the handle was supplied and its lineage is broken', () => {
    // The fix narrowed the diagnosis rather than weakening it. A *supplied*
    // deployer whose Config hop is truncated is a genuinely malformed handle with
    // a genuine property path to name, and it must keep naming it — otherwise
    // "missing" would start absorbing a second, differently-actionable state.
    const error = incompleteFrom(() =>
      resolveEnvironment(
        handles({
          deployer: shallowDeployerHandle(1),
          tronWrap: tronWrapHandle(),
        }),
        { require: ['chain', 'output'] },
      ),
    );
    const output = error.unsatisfied.filter(item => item.slot === 'output');
    expect(output).toHaveLength(1);
    expect(output[0]?.cause.kind).toBe('handle-malformed');
    if (output[0]?.cause.kind !== 'handle-malformed') {
      throw new Error('unreachable');
    }
    expect(output[0].cause.handle).toBe('deployer');
    expect(output[0].cause.expectedPath).toBe('deployer.options.options');
  });
});

describe('INV-15: no host failure escapes the seam untranslated', () => {
  it('translates a throwing resolver into an SF-0 error naming the input', () => {
    const shape = migrateShapedHandles({}, {
      mode: 'throw',
      throwMessage: 'Could not find artifacts for Box from any sources',
    });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    const error = incompleteFrom(() => env.artifacts.resolve('Box'));
    expect(error.message).toContain('contract "Box"');
    expect(error.message).toContain('injected ResolverIntercept');
    expect(error.message).toContain('every resolver source reported no artifact');
    // The host's own message is not forwarded — it is accurate but not
    // attributable to a plugin, so a user files a bug against TronBox.
    expect(error.message).not.toContain('from any sources');
  });

  it.each(['null', 'undefined', 'primitive'] as const)(
    'translates a resolver source returning a %s value',
    mode => {
      const shape = migrateShapedHandles({}, { mode });
      const env = resolveEnvironment(
        shape.handles,
        { require: ['artifacts'] },
        { buildInfoReader: singleContractReader() },
      );
      const error = incompleteFrom(() => env.artifacts.resolve('Box'));
      expect(error.message).toContain(
        'a resolver source returned no usable artifact object',
      );
    },
  );

  it('never returns a nullish value from resolve', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    const resolution = env.artifacts.resolve('Box');
    expect(resolution).not.toBeNull();
    expect(resolution).not.toBeUndefined();
    expect(env.artifacts.ambiguities()).not.toBeNull();
  });

  it('translates a throwing Config getter into a named diagnosis', () => {
    const shape = migrateShapedHandles({ throwOn: ['networks'] });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error).toBeInstanceOf(EnvironmentIncompleteError);
    expect(error.message).toContain(
      'property path "deployer.options.options.networks" threw when read',
    );
    expect(error.message).not.toContain('Network not set');
  });

  it('never lets a TypeError out for a structurally wrong handle', () => {
    const wrongHandles: readonly unknown[] = [
      {},
      null,
      42,
      'deployer',
      true,
      [],
      { options: null },
      { options: { options: 7 } },
    ];
    for (const deployer of wrongHandles) {
      const error = caught(() =>
        resolveEnvironment(handles({ deployer }), { require: ['paths'] }),
      );
      expect(error, JSON.stringify(deployer) ?? 'undefined').toBeInstanceOf(
        TronBoxEnvironmentError,
      );
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });
});

describe('INV-16: the network slot is validated at the source of truth', () => {
  it('refuses an empty networks map, which is the Config constructor default', () => {
    const shape = migrateShapedHandles({ networks: {} });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain('the selected network "development"');
    expect(error.message).toContain('Configured networks: none');
    expect(error.message).toContain(
      "TronBox's own getters would report a complete but fictional configuration",
    );
  });

  it('refuses a selected network absent from networks, naming what is configured', () => {
    const shape = migrateShapedHandles({
      network: 'nile',
      networks: {
        development: networkEntry(),
        shasta: networkEntry({ networkId: '2' }),
      },
    });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain('the selected network "nile"');
    expect(error.message).toContain('Configured networks: development, shasta');
  });

  it('documents the trap: the unvalidated getters report a full fictional config', () => {
    // The fixture reproduces what `Config`'s getters hand back for a network
    // absent from `networks` — `deployParameters` constants, no error at all.
    // The seam must refuse this state, which is why the check is against
    // `networks` rather than against getter plausibility.
    const shape = migrateShapedHandles({
      network: 'nile',
      networks: { development: networkEntry() },
      networkId: null,
    });
    expect(shape.config.feeLimit).toBe(1_000_000_000);
    expect(shape.config.userFeePercentage).toBe(100);
    expect(shape.config.originEnergyLimit).toBe(10_000_000);
    expect(shape.config.network_id).toBeNull();

    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.unsatisfied[0]?.cause.kind).toBe('invariant-violated');
  });

  it('gives a nullish selected network its own diagnosis', () => {
    // `Config.prototype.addProp`'s getter is truthiness-guarded and `network`'s
    // default is a bare no-op, so a `network` configured as `''` reads back as
    // `undefined`. Reporting a type error there would misdirect.
    const shape = migrateShapedHandles({ network: undefined });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain('no network is selected');
    expect(error.message).toContain('--network');
    expect(error.message).not.toContain('must be a string');
  });

  it.each([
    ['an empty string', '', 'must not be empty'],
    ['a number', 123, 'must be a string'],
    ['an object', { name: 'dev' }, 'must be a string'],
  ])('refuses a network that is %s', (_label, value, expected) => {
    const shape = migrateShapedHandles({ network: value });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain(expected);
  });

  it('refuses a networks value that is not an object', () => {
    const shape = migrateShapedHandles({ networks: 'development' });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain(
      'Config field "networks" must be an object mapping network names',
    );
  });

  it('refuses a network entry that is not an object', () => {
    const shape = migrateShapedHandles({ networks: { development: 'yes' } });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain('has no entry in "networks"');
  });

  it('refuses a configured network with no network_id', () => {
    const shape = migrateShapedHandles({
      networks: { development: networkEntry({ omit: ['network_id'] }) },
    });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain('is configured without a "network_id"');
  });

  it('validates before reading any derived getter', () => {
    // The derived getters all throw in this fixture. A resolution that reports
    // the `networks` problem rather than a "threw when read" on `feeLimit`
    // proves the order.
    const shape = migrateShapedHandles({
      networks: {},
      throwOn: ['feeLimit', 'userFeePercentage', 'from', 'network_id'],
    });
    const error = incompleteFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.unsatisfied[0]?.cause.kind).toBe('invariant-violated');
    expect(error.message).toContain('has no entry in "networks"');
    expect(error.message).not.toContain('feeLimit');
  });
});

describe('INV-17: lineage reads test own-property presence, not truthiness', () => {
  it('distinguishes an omitted key from an empty-string value', () => {
    const omitted = incompleteFrom(() =>
      resolveEnvironment(
        migrateShapedHandles({ omit: ['contracts_directory'] }).handles,
        { require: ['paths'] },
      ),
    );
    expect(omitted.unsatisfied[0]?.cause.kind).toBe('handle-malformed');
    expect(omitted.message).toContain('is absent');

    const empty = incompleteFrom(() =>
      resolveEnvironment(
        migrateShapedHandles({ contractsDirectory: '' }).handles,
        { require: ['paths'] },
      ),
    );
    expect(empty.unsatisfied[0]?.cause.kind).toBe('invariant-violated');
    expect(empty.message).toContain('"contracts_directory" must be absolute');
  });

  it('distinguishes three states of the network key', () => {
    const diagnoses = [
      { spec: { omit: ['network'] }, kind: 'handle-malformed', text: 'is absent' },
      {
        spec: { network: undefined },
        kind: 'invariant-violated',
        text: 'no network is selected',
      },
      {
        spec: { network: '' },
        kind: 'invariant-violated',
        text: 'must not be empty',
      },
    ] as const;
    const messages = new Set<string>();
    for (const entry of diagnoses) {
      const error = incompleteFrom(() =>
        resolveEnvironment(migrateShapedHandles(entry.spec).handles, {
          require: ['network'],
        }),
      );
      expect(error.unsatisfied[0]?.cause.kind).toBe(entry.kind);
      expect(error.message).toContain(entry.text);
      messages.add(error.message);
    }
    expect(messages.size).toBe(3);
  });

  it('preserves a falsy-but-valid value rather than treating it as absent', () => {
    const shape = migrateShapedHandles({
      feeLimit: 0,
      userFeePercentage: 0,
      networks: { development: networkEntry({ from: '' }) },
      from: '',
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.txDefaults.feeLimit).toBe(0);
    expect(env.network.txDefaults.userFeePercentage).toBe(0);
    expect(env.network.sender.address).toBe('');
    expect(env.network.sender.address).not.toBeNull();
  });

  it('treats an empty-string privateKey as no key configured', () => {
    const shape = migrateShapedHandles({
      networks: { development: networkEntry({ privateKey: '' }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.signingKeyConfigured).toBe(false);
  });
});

describe('INV-18: resolvePackaged never returns nullish and its failures are diagnosed', () => {
  const packagedPath =
    '@openzeppelin/upgrades-core/artifacts/proxy/ERC1967Proxy.json';

  function accessFor(mode: 'resolve' | 'throw' = 'resolve') {
    const shape = migrateShapedHandles(
      {},
      mode === 'resolve'
        ? { mode, resolvable: [packagedPath] }
        : { mode },
    );
    return resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    ).artifacts;
  }

  it('returns the abstraction for a valid packaged path', () => {
    const contract = accessFor().resolvePackaged(packagedPath);
    expect(contract).toBeDefined();
    expect(contract).not.toBeNull();
  });

  it.each([
    ['a leading ./', './local.json', 'must not\nbegin with "./"'],
    ['an absolute path', '/etc/passwd.json', 'must stay within an'],
    ['an upward escape', '../escape.json', 'must stay within an'],
    ['a normalized upward escape', 'pkg/../../escape.json', 'must stay within an'],
    ['a Windows drive path', 'C:/secrets.json', 'must stay within an'],
    ['a bare ".."', '..', 'must stay within an'],
  ])(
    'refuses %s by name, with zero filesystem access',
    (_label, input, _fragment) => {
      const error = incompleteFrom(() => accessFor().resolvePackaged(input));
      expect(error.message).toContain(input);
      expect(error.message).toContain('must stay within an installed package');
    },
  );

  it('refuses a path that does not name a JSON artifact', () => {
    const error = incompleteFrom(() => accessFor().resolvePackaged('pkg/Box'));
    expect(error.message).toContain('must name a JSON artifact');
  });

  it.each([
    ['an empty string', '', 'must not be empty'],
    ['a NUL byte', 'pkg/a\0b.json', 'must not contain a NUL byte'],
  ])('refuses %s', (_label, input, fragment) => {
    const error = incompleteFrom(() => accessFor().resolvePackaged(input));
    expect(error.message).toContain(fragment);
  });

  it('names the exact host-resolved path for the residual failure', () => {
    const error = incompleteFrom(() =>
      accessFor('throw').resolvePackaged(packagedPath),
    );
    expect(error.message).toContain(packagedPath);
    expect(error.message).toContain(
      path.join('/proj', 'node_modules', packagedPath),
    );
  });

  /**
   * INV-18's three messages, one test each, all driven from `exists` fixtures.
   *
   * This is what the reader amendment bought. Revision 1 delivered two messages
   * and recorded the third as a skipped deferral, because splitting *missing* from
   * *malformed* looked like it needed a content read INV-31 confines to
   * `ambiguity.ts`. It does not: it needs a `boolean`. The existence probe is a
   * strictly weaker capability on the dependency that was already injected, so all
   * three causes are now reachable from a unit test with no broken file on disk —
   * which is also what SF-5's acceptance scenario 6 needs, since the remedy
   * differs per cause.
   */
  function packagedFailure(
    exists: boolean,
    input: string = packagedPath,
  ): string {
    const shape = migrateShapedHandles({}, { mode: 'null' });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: existenceProbeReader(exists) },
    );
    return incompleteFrom(() => env.artifacts.resolvePackaged(input)).message;
  }

  it('reports the escaping cause with no filesystem access at all', () => {
    const message = packagedFailure(true, '../escape.json');
    expect(message).toContain('must stay within an installed package');
    expect(message).not.toMatch(/does not exist/);
    expect(message).not.toMatch(/unreadable or is not valid JSON/);
  });

  it('reports a missing packaged artifact as missing, naming the host-resolved path', () => {
    const message = packagedFailure(false);
    expect(message).toContain('does not exist at');
    expect(message).toContain(path.join('/proj', 'node_modules', packagedPath));
    expect(message).toContain('install or update the package');
    // The remedy is install-shaped, and must not also suggest the other two.
    expect(message).not.toContain('not valid JSON');
    expect(message).not.toContain('must stay within an installed package');
  });

  it('reports a present-but-unloadable artifact as malformed, never as missing', () => {
    // INV-18's normative sentence, now assertable directly rather than by the
    // absence of a claim: "malformed" is concluded from the *conjunction* of
    // existence and the host's `null`, so it cannot be reported for an absent file
    // and "missing" cannot be reported for a corrupt one.
    const message = packagedFailure(true);
    expect(message).toContain('exists at');
    expect(message).toContain('unreadable or is not valid JSON');
    expect(message).toContain('Reinstall the package');
    expect(message).not.toMatch(/\bnot found\b/);
    expect(message).not.toMatch(/does not exist/);
  });

  it('gives the three causes three pairwise-distinct messages and three remedies', () => {
    // Stated as one assertion over the set, because "distinct" is a property of
    // the set and two of the three could drift into agreement without any single
    // message looking wrong.
    const messages = [
      packagedFailure(true, '../escape.json'),
      packagedFailure(false),
      packagedFailure(true),
    ];
    expect(new Set(messages).size).toBe(3);
    const remedies = [
      'must stay within an installed package',
      'install or update the package',
      'Reinstall the package',
    ];
    messages.forEach((message, index) => {
      const matched = remedies.filter(remedy => message.includes(remedy));
      expect(matched, `message ${index} names exactly one remedy`).toEqual([
        remedies[index],
      ]);
    });
  });

  it('refuses rather than guesses when the injected probe throws', () => {
    // A probe that answers neither yes nor no gets its own refusal. Folding it into
    // "missing" would report a file absent on the strength of a question that
    // failed — the exact false-confidence INV-18 exists to remove. Unreachable
    // through `fileSystemBuildInfoReader`, whose probe cannot throw.
    const shape = migrateShapedHandles({}, { mode: 'null' });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      {
        buildInfoReader: throwingProbeReader(
          new Error('EIO: the probe read /proj/secret-plans.txt'),
        ),
      },
    );
    const error = incompleteFrom(() =>
      env.artifacts.resolvePackaged(packagedPath),
    );
    expect(error.message).toContain("existence probe for that path failed");
    expect(error.message).toContain(
      'cannot say whether the file is missing or malformed',
    );
    expect(error.message).not.toMatch(/does not exist/);
    // INV-42: the injected error's own message is not forwarded.
    expect(error.message).not.toContain('secret-plans');
    expect(error.message).not.toContain('EIO');
  });

  it('refuses a non-string argument rather than coercing it', () => {
    // Reached through a structurally weaker view rather than a type assertion:
    // TypeScript method parameters are bivariant, so `ArtifactAccess` satisfies
    // this shape as written and the untrusted-input path stays reachable from a
    // test with no casts.
    const loose: {
      resolve(name: unknown): unknown;
      resolvePackaged(value: unknown): unknown;
    } = accessFor();
    const packagedError = incompleteFrom(() => loose.resolvePackaged(7));
    expect(packagedError.message).toContain(
      'must be addressed by a string path relative to node_modules',
    );
    expect(packagedError.message).toContain('of type number');

    const resolveError = incompleteFrom(() => loose.resolve({ name: 'Box' }));
    expect(resolveError.message).toContain(
      'must be addressed by a string bare name',
    );
    expect(resolveError.message).toContain('of type object');
  });
});

describe('INV-19: the version guard is structural and the range has one home', () => {
  it('reads the declared range from the plugin manifest', () => {
    const manifest = readJsonFile(path.join(packageRoot, 'package.json'));
    const declared =
      typeof manifest === 'object' &&
      manifest !== null &&
      'peerDependencies' in manifest
        ? (manifest as { peerDependencies: Record<string, string> })
            .peerDependencies.tronbox
        : undefined;
    expect(declared).toBeDefined();
    expect(getDeclaredTronBoxRange()).toBe(declared);
  });

  it('interpolates the declared range into every incomplete message', () => {
    const error = incompleteFrom(() =>
      resolveEnvironment(handles({ deployer: shallowDeployerHandle(1) }), {
        require: ['paths'],
      }),
    );
    expect(error.message).toContain(
      `Declared TronBox peer range: ${getDeclaredTronBoxRange()}.`,
    );
  });

  it('never parses or compares a TronBox version string', () => {
    // `require('tronbox')` cannot resolve — the package declares no `main` and
    // has no root `index.js` — so any version check must be structural. A
    // comparison against the range would refuse a working 4.10 before anyone had
    // tested whether it works.
    // The three **solc** versions the compiler slot must restate, allow-listed by
    // exact value and exact file. INV-19 is about a *TronBox* version: a version
    // this seam might compare against `peerDependencies.tronbox` to decide whether
    // the host is supported. These are neither — they are the compiler versions
    // TronBox itself would select, restated because INV-49 forbids importing the
    // host and `TronSolc.js` keeps them module-private. Nothing compares them; the
    // seam reports the resolved string and leaves every range judgement to its
    // consumer. Allow-listed this narrowly so a *fourth* literal, or the same three
    // in any other module, still fails here.
    const solcVersionLiterals: Readonly<Record<string, readonly string[]>> = {
      'compiler.ts': ['0.8.26', '0.4.25', '0.5.4'],
    };

    for (const source of environmentSources()) {
      const permitted = solcVersionLiterals[source.relative] ?? [];
      const semverLiterals = source.stringLiterals.filter(
        literal =>
          /^[\s^~><=]*\d+\.\d+(\.\d+)?/.test(literal) &&
          !permitted.includes(literal),
      );
      expect(semverLiterals, `${source.relative} has no semver literal`).toEqual(
        [],
      );
      const versionIdentifiers = source.identifiers.filter(use =>
        /^(semver|satisfies|coerce|gte|lte|compareVersions)$/.test(use.name),
      );
      expect(versionIdentifiers, `${source.relative}`).toEqual([]);
    }
  });

  it('reads the manifest in exactly one module', () => {
    const readers = environmentSources().filter(source =>
      source.importSpecifiers.some(specifier =>
        specifier.endsWith('package.json'),
      ),
    );
    expect(readers.map(source => source.relative)).toEqual(['errors.ts']);
  });

  it('holds no second copy of the range anywhere in the seam', () => {
    const declared = getDeclaredTronBoxRange();
    for (const source of environmentSources()) {
      const copies = source.stringLiterals.filter(
        literal => literal === declared,
      );
      expect(copies, `${source.relative} restates the declared range`).toEqual(
        [],
      );
    }
  });
});
