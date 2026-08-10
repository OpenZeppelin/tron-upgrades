import { describe, expect, it } from 'vitest';

import { createOperationToolkit } from '../src/proxy/toolkit';
import { DEPLOY_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/deploy-proxy';
import { UPGRADE_PROXY_ACCEPTED_OPTIONS } from '../src/proxy/upgrade-proxy';
import { LinkVerificationFailedError } from '../src/deploy';
import { migrateShapedHandles } from './helpers/handles';

/*
 * The toolkit seam, exercised through the REAL `createOperationToolkit` —
 * never a fake — because the defect this suite pins (B1) lived exactly in the
 * production mapping between the resolver's output and
 * `OperationContext.resolved`: the toolkit read the resolver's result through
 * a widening cast at the wrong nesting level, so six option reads were always
 * empty and a caller's `kind` arrived downstream as `undefined`.
 *
 * `validate-only` mode is the vehicle: it resolves exactly the five slots the
 * `migrateShapedHandles` fixture can satisfy without a chain (`paths`,
 * `network`, `artifacts`, `output`, `compiler` — `VALIDATE_ONLY_SLOTS`),
 * opens no record session, and still runs the one code path under test — the
 * rawOptions → resolver → `context.resolved` mapping, which is identical in
 * both modes.
 *
 * `processEnv` is a fresh object per test: `configureRecordLocation` writes
 * the manifest-directory variable into the env it is handed, and this suite
 * must not leak that write into the real `process.env`.
 */
describe('the toolkit reads the resolver output at the right level (B1)', () => {
  it('kind:uups survives from rawOptions to context.resolved and engineOptions', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: { kind: 'uups' },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.kind).toBe('uups');
    expect(context.resolved.engineOptions['kind']).toBe('uups');
  });

  it('initializer, call, initialOwner and both unsafe flags survive', async () => {
    const shape = migrateShapedHandles();
    // The accepted-options spread is deliberate: `UPGRADE_PROXY_ACCEPTED_OPTIONS`
    // gates unknown keys per operation, and this test is about the seam
    // threading every accepted key, not about any one operation's accepted set.
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: {
        initializer: 'setUp',
        call: 'migrate',
        initialOwner: 'T...',
        unsafeSkipProxyAdminCheck: true,
        unsafeAllow: ['external-library-linking'],
      },
      acceptedOptions: [
        ...UPGRADE_PROXY_ACCEPTED_OPTIONS,
        'initializer',
        'initialOwner',
        'unsafeSkipProxyAdminCheck',
      ],
      processEnv: {},
      mode: 'validate-only',
    });
    expect(context.resolved.initializer).toBe('setUp');
    expect(context.resolved.call).toBe('migrate');
    expect(context.resolved.initialOwner).toBe('T...');
    expect(context.resolved.unsafeSkipProxyAdminCheck).toBe(true);
    // One level DOWN on the resolver's result: the flag lives at
    // `resolved.validation.unsafeAllowLinkedLibraries`, where upstream's
    // `withValidationDefaults` derives it from the `unsafeAllow` grant.
    expect(context.resolved.unsafeAllowLinkedLibraries).toBe(true);
  });
});

/*
 * `hostDeploy` is the single seam every operation's deploy funnels through
 * (deploy-proxy, upgrade-proxy, beacon, standalone all call
 * `toolkit.hostDeploy` and nothing else `.new()`s an abstraction) — so it is
 * where `assertFullyLinked` belongs, verifying the bytecode about to deploy
 * carries no unresolved library placeholder even when
 * `unsafeAllowLinkedLibraries` opted the deploy in at entry.
 *
 * The REAL toolkit is built here, through `createOperationToolkit` in
 * `validate-only` mode — never a fake `hostDeploy` — because a fake toolkit's
 * `hostDeploy` is exactly the thing under test and would make this
 * tautological. `validate-only` is the vehicle: `hostDeploy` touches no chain
 * before `.new()`, so it is fully reachable without a live network.
 */
describe('hostDeploy verifies linking before it deploys (review §3 M4)', () => {
  it('refuses bytecode with an unresolved placeholder even under the linking opt-out, before any deploy attempt', async () => {
    const shape = migrateShapedHandles();
    const context = await createOperationToolkit({
      handles: shape.handles,
      rawOptions: { unsafeAllow: ['external-library-linking'] },
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      processEnv: {},
      mode: 'validate-only',
    });
    // `binary` is the field the host's own `Contract.new()` deploys
    // (`tx_params.data = self.binary`) — the library-linked form computed
    // from `bytecode` and the host's `links` map, not `bytecode` itself.
    const abstraction = {
      contractName: 'Lib',
      binary: '0x60__$deadbeefdeadbeefdeadbeefdeadbeefde$__',
      new: async (): Promise<never> => {
        throw new Error('must not be reached');
      },
    };
    await expect(
      context.toolkit.hostDeploy(abstraction as never, []),
    ).rejects.toThrow(LinkVerificationFailedError);
  });
});
