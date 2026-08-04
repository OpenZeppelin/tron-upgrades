import { describe, expect, it } from 'vitest';

import {
  planUpgradeDispatch,
  type DispatchProbe,
  type UpgradePlan,
} from '../src/proxy/dispatch';
import {
  PROXY_CONTRACT_NAMES,
  requireProxyArtifact,
} from '../src/proxy/artifacts';
import {
  BeaconProxyRefusedError,
  EmptyInitializerRefusedError,
  NotTransparentProxyError,
  ProxyAdminAsOwnerError,
  ProxyArtifactCollisionError,
  ProxyArtifactMissingError,
  ProxyOperationRefusedError,
  UnknownProxyGenerationError,
  UpgradeVerificationFailedError,
} from '../src/proxy/errors';
import type { ArtifactAccess } from '../src/environment';

/*
 * SF-5 — the host-free half: the dispatch matrix, artifact triage, and the
 * refusal family. Everything here is a pure function of its arguments, which
 * is the property INV-5 and INV-8 rely on: the matrix can be asserted as
 * data, and no test needs a chain.
 */

// ---------------------------------------------------------------------------
// INV-5 — the dispatch matrix, row by row, closed
// ---------------------------------------------------------------------------

describe('INV-5: the four dispatch rows, asserted as data', () => {
  const matrix: ReadonlyArray<readonly [DispatchProbe, UpgradePlan]> = [
    // admin v5: upgradeAndCall ALWAYS — with data and with 0x alike.
    [
      { kind: 'transparent', interfaceVersion: '5.0.0', hasCallData: true },
      { route: 'admin-v5', call: 'upgradeAndCall', carriesData: true },
    ],
    [
      { kind: 'transparent', interfaceVersion: '5.0.0', hasCallData: false },
      { route: 'admin-v5', call: 'upgradeAndCall', carriesData: true },
    ],
    // admin v4: plain upgrade WITHOUT data, because v4's upgradeAndCall
    // force-calls the implementation.
    [
      { kind: 'transparent', interfaceVersion: undefined, hasCallData: false },
      { route: 'admin-v4', call: 'upgrade', carriesData: false },
    ],
    [
      { kind: 'transparent', interfaceVersion: undefined, hasCallData: true },
      { route: 'admin-v4', call: 'upgradeAndCall', carriesData: true },
    ],
    // uups v5: upgradeToAndCall always.
    [
      { kind: 'uups', interfaceVersion: '5.0.0', hasCallData: false },
      { route: 'uups-v5', call: 'upgradeToAndCall', carriesData: true },
    ],
    // uups pre-5: upgradeTo plain, upgradeToAndCall with data.
    [
      { kind: 'uups', interfaceVersion: undefined, hasCallData: false },
      { route: 'uups-pre5', call: 'upgradeTo', carriesData: false },
    ],
    [
      { kind: 'uups', interfaceVersion: undefined, hasCallData: true },
      { route: 'uups-pre5', call: 'upgradeToAndCall', carriesData: true },
    ],
  ];

  it.each(matrix)('%j → %j', (probe, plan) => {
    expect(planUpgradeDispatch(probe)).toEqual(plan);
  });

  it('refuses any version outside the closed set, naming the subject and the version', () => {
    for (const kind of ['transparent', 'uups'] as const) {
      let caught: UnknownProxyGenerationError | undefined;
      try {
        planUpgradeDispatch({ kind, interfaceVersion: '6.0.0', hasCallData: false });
      } catch (error) {
        caught = error as UnknownProxyGenerationError;
      }
      expect(caught).toBeInstanceOf(UnknownProxyGenerationError);
      expect(caught?.reportedVersion).toBe('6.0.0');
      expect(caught?.subject).toBe(kind === 'transparent' ? 'admin' : 'proxy');
    }
  });

  it('never plans a call taken from the new implementation: the call set is closed', () => {
    // The four names are the CURRENT generation's entry points. Enumerated so
    // a fifth name (say, one read off a new implementation's ABI) cannot be
    // added without failing here.
    const calls = new Set(
      matrix.map(([probe]) => planUpgradeDispatch(probe).call),
    );
    expect([...calls].sort()).toEqual([
      'upgrade',
      'upgradeAndCall',
      'upgradeTo',
      'upgradeToAndCall',
    ]);
  });
});

// ---------------------------------------------------------------------------
// INV-8 — artifact triage: three outcomes, none silent
// ---------------------------------------------------------------------------

function artifactAccessWith(
  resolve: ArtifactAccess['resolve'],
): ArtifactAccess {
  const untouched = (member: string) => (): never => {
    throw new Error(`${member} must not be consulted by artifact triage`);
  };
  return {
    resolve,
    resolvePackaged: untouched('resolvePackaged'),
    ambiguities: untouched('ambiguities'),
    record: untouched('record'),
    intercept: new Proxy(
      {},
      { get: untouched('intercept') },
    ) as ArtifactAccess['intercept'],
  };
}

describe('INV-8: proxy-artifact triage', () => {
  const abstraction = { contractName: 'TransparentUpgradeableProxy' };

  it('returns the unique artifact untouched', () => {
    const access = artifactAccessWith(() => ({
      status: 'unique',
      name: 'TransparentUpgradeableProxy',
      contract: abstraction,
      sourcePath: '/proj/contracts/Proxies.sol',
    }));
    expect(
      requireProxyArtifact(access, PROXY_CONTRACT_NAMES.transparent),
    ).toBe(abstraction);
  });

  it('treats same-source duplicates as unique — recompiles accumulate build records, and that is not a user collision', () => {
    // Found by the first live migration: two compiles left two build-info
    // files, both carrying the proxy, and the triage refused a "collision"
    // whose two paths were identical.
    const access = artifactAccessWith(() => ({
      status: 'ambiguous',
      name: 'TransparentUpgradeableProxy',
      candidates: [
        {
          sourcePath: 'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
          contractName: 'TransparentUpgradeableProxy',
          buildInfoFile: '/proj/build/info/a.json' as never,
        },
        {
          sourcePath: 'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
          contractName: 'TransparentUpgradeableProxy',
          buildInfoFile: '/proj/build/info/b.json' as never,
        },
      ],
      unverifiedContract: abstraction,
    }));
    expect(
      requireProxyArtifact(access, PROXY_CONTRACT_NAMES.transparent),
    ).toBe(abstraction);
  });

  it('refuses a collision naming every candidate path', () => {
    const access = artifactAccessWith(() => ({
      status: 'ambiguous',
      name: 'TransparentUpgradeableProxy',
      candidates: [
        {
          sourcePath: 'contracts/Proxies.sol',
          contractName: 'TransparentUpgradeableProxy',
          buildInfoFile: '/proj/build/info/a.json' as never,
        },
        {
          sourcePath: 'contracts/vendored/Proxy.sol',
          contractName: 'TransparentUpgradeableProxy',
          buildInfoFile: '/proj/build/info/b.json' as never,
        },
      ],
      unverifiedContract: abstraction,
    }));
    let caught: ProxyArtifactCollisionError | undefined;
    try {
      requireProxyArtifact(access, PROXY_CONTRACT_NAMES.transparent);
    } catch (error) {
      caught = error as ProxyArtifactCollisionError;
    }
    expect(caught).toBeInstanceOf(ProxyArtifactCollisionError);
    expect(caught?.message).toContain('contracts/Proxies.sol');
    expect(caught?.message).toContain('contracts/vendored/Proxy.sol');
  });

  it('maps indeterminate and a throwing resolver both onto the missing refusal with the import-file remedy', () => {
    const indeterminate = artifactAccessWith(() => ({
      status: 'indeterminate',
      name: 'TRC1967Proxy',
      reason: { kind: 'build-info-absent' } as never,
      unverifiedContract: abstraction,
    }));
    const throwing = artifactAccessWith(() => {
      throw new Error("Could not find artifacts for TRC1967Proxy");
    });
    for (const access of [indeterminate, throwing]) {
      let caught: ProxyArtifactMissingError | undefined;
      try {
        requireProxyArtifact(access, PROXY_CONTRACT_NAMES.trc1967);
      } catch (error) {
        caught = error as ProxyArtifactMissingError;
      }
      expect(caught).toBeInstanceOf(ProxyArtifactMissingError);
      expect(caught?.message).toContain('tronbox compile');
      expect(caught?.message).toContain('openzeppelin-tron-solidity');
    }
  });
});

// ---------------------------------------------------------------------------
// The refusal family
// ---------------------------------------------------------------------------

describe('the proxy refusal family: distinct codes, distinct messages, one base', () => {
  const specimens: readonly ProxyOperationRefusedError[] = [
    new UnknownProxyGenerationError('admin', '6.0.0'),
    new ProxyArtifactMissingError('TRC1967Proxy'),
    new ProxyArtifactCollisionError('ProxyAdmin', ['a.sol', 'b.sol']),
    new BeaconProxyRefusedError('TProxy', 'TBeacon'),
    new NotTransparentProxyError('TProxy'),
    new UpgradeVerificationFailedError('TProxy', 'TNew', 'TOld'),
    new EmptyInitializerRefusedError('uups', 'initializer-false'),
    new ProxyAdminAsOwnerError('TAdmin'),
  ];

  it('every refusal is in the family with a distinct code and message', () => {
    for (const specimen of specimens) {
      expect(specimen).toBeInstanceOf(Error);
      expect(specimen).toBeInstanceOf(ProxyOperationRefusedError);
    }
    expect(new Set(specimens.map(s => s.code)).size).toBe(specimens.length);
    expect(new Set(specimens.map(s => s.message)).size).toBe(specimens.length);
  });

  it('distinguishes the two empty-initializer mistakes inside one class', () => {
    const explicit = new EmptyInitializerRefusedError('uups', 'initializer-false');
    const missing = new EmptyInitializerRefusedError('uups', 'no-default-initializer');
    expect(explicit.message).not.toBe(missing.message);
    expect(explicit.message).toContain('initializer: false');
    expect(missing.message).toContain('no default initializer');
  });
});
