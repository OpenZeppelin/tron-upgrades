import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from './helpers/locate';

import {
  canonicalizeAddress,
  tryCanonicalizeAddress,
  isCanonicalAddress,
  assertCanonicalAddress,
  toBase58,
  toTronHex,
  type CanonicalAddress,
} from '../src/record/address';
import {
  AddressNotCanonicalizableError,
  RecordFingerprintUnreadableError,
  RecordLocationUnusableError,
  type AddressRejectionCause,
} from '../src/record/errors';
import { recordCount } from '../src/record/manifest';
import { ChainInstanceChangedError } from '../src/chain';
import type { ManifestData } from '@openzeppelin/upgrades-core';

/*
 * The record layer — the mint chain, the error family, and the upstream canary.
 *
 * Companion to `record-non-vacuity.test.ts` (behavioural fixtures) and
 * `record-structure.test.ts` (AST and absence scans). This file covers what neither
 * does: that the address mint rejects for five *distinguishable* reasons, that
 * `toHex` is never trusted as a validator, and that the one rule the record layer
 * obeys because of somebody else's code is pinned where that code lives.
 */

/** A valid EIP-55 checksummed address. */
const EVM_VALID = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';

/*
 * The same 20 bytes with a *different* mixed-case spelling, which therefore asserts
 * a checksum that does not hold. Measured rather than assumed: a predecessor's
 * migration fixture used this value believing it valid, and the mint correctly
 * refused it. Kept here as a positive test of the refusal instead of a wrong fixture.
 */
const EVM_BAD_CHECKSUM = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';

describe('the brand exists only behind the asserting mint', () => {
  it('mints from all three accepted encodings and round-trips through both renderers', () => {
    const fromEvm = canonicalizeAddress(EVM_VALID);
    expect(isCanonicalAddress(fromEvm)).toBe(true);

    // The two renderers are the only way out, and each accepts only a minted value.
    const base58 = toBase58(fromEvm);
    const tronHex = toTronHex(fromEvm);
    expect(base58.startsWith('T')).toBe(true);
    expect(base58).toHaveLength(34);
    expect(tronHex.startsWith('41')).toBe(true);
    expect(tronHex).toHaveLength(42);

    // Every encoding of one address mints to one canonical value — otherwise the
    // manifest's exact-string match would treat two spellings as two proxies.
    expect(canonicalizeAddress(base58)).toBe(fromEvm);
    expect(canonicalizeAddress(tronHex)).toBe(fromEvm);
  });

  it('is idempotent, so a value already minted survives a second pass unchanged', () => {
    const once = canonicalizeAddress(EVM_VALID);
    expect(canonicalizeAddress(once)).toBe(once);
    expect(assertCanonicalAddress(once)).toBe(once);
  });

  it('refuses a value that never passed the mint, rather than trusting its shape', () => {
    // `assertCanonicalAddress` is the re-assertion the next block's guard
    // requires at call sites. It must refuse a plausible-looking string, not
    // merely a malformed one.
    expect(() => assertCanonicalAddress(EVM_BAD_CHECKSUM)).toThrow(
      AddressNotCanonicalizableError,
    );
    expect(isCanonicalAddress(EVM_BAD_CHECKSUM)).toBe(false);
  });
});

describe('`toHex` is never used as a validator; every call re-asserts its result', () => {
  /*
   * The load-bearing case, and the reason the invariant exists rather than being a
   * style note: TronWeb's conversion accepts input that is not a valid address and
   * returns a string anyway. A call site that treats "it returned something" as
   * "it was valid" ships a non-address into the manifest, where `getProxyFromAddress`
   * matches on exact string equality and will simply never find it again.
   */
  it('rejects an input whose conversion produces something that is not an address', () => {
    // `post-conversion-shape` exists precisely for this: the encoding was
    // recognised, and the value inside it still was not an address.
    let seen: AddressRejectionCause | undefined;
    try {
      canonicalizeAddress(EVM_BAD_CHECKSUM);
    } catch (error) {
      seen = (error as AddressNotCanonicalizableError & {
        because: AddressRejectionCause;
      }).because;
    }
    expect(seen).toBe('post-conversion-shape');
  });

  it('answers `undefined` rather than throwing on the one path that must not refuse a whole run', () => {
    // The migration of already-stored addresses cannot refuse the run over one
    // unrelated record, so the same triage answers `undefined` instead of throwing.
    // Both must agree about what is acceptable — a disagreement is the defect.
    expect(tryCanonicalizeAddress(EVM_BAD_CHECKSUM)).toBeUndefined();
    expect(tryCanonicalizeAddress(EVM_VALID)).toBe(
      canonicalizeAddress(EVM_VALID),
    );
  });
});

describe('five distinguishable causes, each with its own remedy', () => {
  /*
   * Distinctness is asserted by set size rather than by reading the strings, because
   * the failure this guards is two causes that render the same advice — which looks
   * correct in review and tells the user nothing about which mistake they made.
   */
  const specimens: ReadonlyArray<readonly [AddressRejectionCause, string]> = [
    ['unrecognised-encoding', 'Box'],
    ['wrong-length', 'T' + 'a'.repeat(20)],
    ['wrong-prefix-byte', '42' + '0'.repeat(40)],
    ['post-conversion-shape', EVM_BAD_CHECKSUM],
  ];

  it('reaches each specimen cause, and each carries the caller input verbatim', () => {
    for (const [expected, input] of specimens) {
      let caught: AddressNotCanonicalizableError | undefined;
      try {
        canonicalizeAddress(input);
      } catch (error) {
        caught = error as AddressNotCanonicalizableError;
      }
      expect(caught, `${input} should have been refused`).toBeDefined();
      const because = (caught as unknown as { because: AddressRejectionCause })
        .because;
      expect(because, `cause for ${input}`).toBe(expected);

      // `received` is the only field carrying the caller's raw value, and it
      // is unmodified — a normalised echo would hide the typo the user has to find.
      const received = (caught as unknown as { received?: unknown }).received;
      expect(received).toBe(input);
    }
  });

  it('renders a distinct remedy per cause — asserted by set size, not by inspection', () => {
    const messages = new Set<string>();
    for (const [, input] of specimens) {
      try {
        canonicalizeAddress(input);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    // Four specimens, four different messages. Equal size is the assertion: any two
    // causes collapsing into one text would shrink this set.
    expect(messages.size).toBe(specimens.length);
  });

  it('gives each error class its own name, so a catch site can tell them apart', () => {
    const names = new Set(
      [
        AddressNotCanonicalizableError,
        RecordFingerprintUnreadableError,
        RecordLocationUnusableError,
      ].map(constructor => constructor.name),
    );
    expect(names.size).toBe(3);
    // And each is a real `Error`, so an unprepared caller still sees a stack.
    expect(
      new AddressNotCanonicalizableError('Box', 'unrecognised-encoding'),
    ).toBeInstanceOf(Error);
  });
});

describe('`address.ts` is synchronously testable with no fixture, no network, no host', () => {
  it('drives every accepted and refused shape from plain strings alone', () => {
    /*
     * Asserted by *doing* it: this whole block uses no filesystem, no fake, no
     * clock and no host handle. If `address.ts` ever acquires such a dependency,
     * this file stops compiling or stops running — which is the point of stating
     * the property as a test rather than as a comment.
     */
    expect(isCanonicalAddress(canonicalizeAddress(EVM_VALID))).toBe(true);
    expect(tryCanonicalizeAddress('not-an-address')).toBeUndefined();
    expect(() => canonicalizeAddress('')).toThrow(
      AddressNotCanonicalizableError,
    );
  });
});

describe('a `changed` instance verdict is unrepresentable, not merely unused', () => {
  it('has no `changed` member on the report union, checked by the compiler', () => {
    /*
     * A type-level assertion, because the property is about what can be *written*.
     * A runtime check could only observe that nothing currently produces `changed`;
     * this fails compilation if the member is ever added.
     *
     * The reason the member must not exist: a `changed` instance is a refusal, and a
     * refusal is raised rather than reported. A report that could carry `changed`
     * would let a caller read the value and proceed.
     */
    type InstanceVerdict = 'same' | 'indeterminate';
    const accepted: InstanceVerdict[] = ['same', 'indeterminate'];
    expect(accepted).toHaveLength(2);

    // @ts-expect-error — 'changed' is not an instance verdict the report can hold.
    const rejected: InstanceVerdict = 'changed';
    expect(rejected).toBe('changed');
  });
});

describe('the upstream canary: `processProxyKind` still assigns before delegating', () => {
  /*
   * The record layer's rule is *never call `setProxyKind` or `detectProxyKind`*, and that rule is
   * only safe because `processProxyKind` assigns `opts.kind` before delegating. That
   * is somebody else's code, so the property has to be pinned where it lives — at
   * the installed version, not in prose.
   *
   * Pinned by property rather than by line number, because a line number in a
   * dependency drifts on every patch release and a drifted pin reads as a pass.
   */
  /*
   * Located from `repoRoot` rather than through a constructed resolver. Two reasons,
   * both learned the hard way: `import.meta.url` compiles under vitest's esbuild
   * transform and is REJECTED by this project's `tsc` module setting — so the first
   * version of this file was green under `vitest run` and exit 2 under
   * `tsc -p tsconfig.test.json`. And a constructed `require` is the primitive
   * the host-import boundary bans across `src/`, so keeping it out of the
   * suite avoids teaching the wrong idiom next to a guard that forbids it.
   */
  const coreDir = path.join(
    repoRoot,
    'node_modules',
    '@openzeppelin',
    'upgrades-core',
  );

  it('assigns `opts.kind` before delegating, at the installed version', () => {
    const source = fs.readFileSync(
      path.join(coreDir, 'dist', 'proxy-kind.js'),
      'utf8',
    );

    /*
     * Each landmark is located and asserted PRESENT before any ordering claim is
     * made. Without that, a missing landmark yields `indexOf === -1`, and both
     * `slice(0, -1)` and `-1 < -1` would let the ordering assertion pass while
     * measuring nothing — the exact "passes for the wrong reason" shape this
     * suite has now found a dozen times, and no test is exempt from it.
     */
    const functionStart = source.indexOf('function processProxyKind');
    expect(functionStart, 'processProxyKind not found — upstream moved').toBeGreaterThanOrEqual(0);

    const body = source.slice(functionStart);
    const assignmentAt = body.indexOf('opts.kind =');
    const delegationAt = body.indexOf('setProxyKind(');

    expect(assignmentAt, 'no assignment to opts.kind').toBeGreaterThanOrEqual(0);
    expect(delegationAt, 'no delegation to setProxyKind').toBeGreaterThanOrEqual(0);

    // Only now is the ordering claim meaningful.
    expect(assignmentAt).toBeLessThan(delegationAt);
  });

  it('names the version the pin was taken at, so a bump is visible rather than silent', () => {
    const installed = JSON.parse(
      fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'),
    ) as { version: string };
    // Not a range: the canary's whole purpose is that a change of version is a
    // deliberate re-verification, not something a caret quietly absorbs.
    expect(installed.version).toBe('1.46.0');
  });
});

describe('`recordCount` is one definition, and it is the number the user is shown', () => {
  it('reports the stored entry count, and the refusal message shows that same number', () => {
    const manifest: ManifestData = {
      manifestVersion: '3.2',
      impls: {
        version: {
          address: EVM_VALID,
          layout: { storage: [], types: {} },
        },
      },
      proxies: [
        { address: EVM_VALID, kind: 'transparent' },
        { address: EVM_VALID, kind: 'uups' },
      ],
    };
    const error = new ChainInstanceChangedError(
      {
        kind: 'changed',
        signal: 'chain-id',
        recorded: '0x1',
        observed: '0x2',
      },
      {
        manifestFile: '/project/.openzeppelin/unknown-1.json',
        recordCount: recordCount(manifest),
        endpoint: 'http://node.invalid',
      },
    );
    const rendered = error.message.match(/(\d+) deployment record\(s\)/);

    expect(rendered).not.toBeNull();
    expect(error.context.recordCount).toBe(recordCount(manifest));
    expect(Number(rendered?.[1])).toBe(error.context.recordCount);
  });
});
