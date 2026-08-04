import { describe, expect, it } from 'vitest';

import {
  decideDeployReplay,
  isAlreadyCurrent,
} from '../src/proxy/replay';
import { canonicalizeAddress, toBase58 } from '../src/record';
// `toTronHex` is deliberately NOT on the record face; the suite reaches it the
// same way the SF-3 tests do — a test-only deep import.
import { toTronHex } from '../src/record/address';
import type { ProxyRecordVerdict } from '../src/record';

/*
 * SF-5 — replay recognition as pure decisions (INV-9, INV-10). The send-count
 * halves of both invariants belong to the operation tests; what this file
 * pins is that the DECISIONS are canonical and closed, because the operation
 * can only be as right as the decision it acts on.
 */

const PROXY = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';
const OTHER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

function verdictFor(
  address: string,
  status: ProxyRecordVerdict['status'],
): ProxyRecordVerdict {
  return {
    address: canonicalizeAddress(address),
    status,
    kindProvenance: 'recorded' as ProxyRecordVerdict['kindProvenance'],
    kind: 'transparent',
  };
}

describe('INV-9: the deploy replay decision', () => {
  it('is fresh with no prior address, whatever the record holds', () => {
    expect(decideDeployReplay(null, [verdictFor(PROXY, 'authoritative')])).toEqual(
      { kind: 'fresh' },
    );
  });

  it('reuses an authoritative prior — matched canonically across encodings', () => {
    const canonical = canonicalizeAddress(PROXY);
    // The artifact may hold any of the three spellings; the verdict list holds
    // canonical form. Recognition must be identity, not string equality.
    for (const spelling of [PROXY, toBase58(canonical), toTronHex(canonical)]) {
      expect(
        decideDeployReplay(spelling, [verdictFor(PROXY, 'authoritative')]),
      ).toEqual({ kind: 'reuse', address: canonical });
    }
  });

  it('refuses a prior whose record is not authoritative, carrying the verdict', () => {
    for (const status of ['no-code-at-address', 'unrecorded'] as const) {
      expect(decideDeployReplay(PROXY, [verdictFor(PROXY, status)])).toEqual({
        kind: 'refuse',
        address: canonicalizeAddress(PROXY),
        because: status,
      });
    }
  });

  it('refuses a prior the record layer never saw — out-of-band deployments are not redeploy licenses', () => {
    expect(decideDeployReplay(PROXY, [])).toEqual({
      kind: 'refuse',
      address: canonicalizeAddress(PROXY),
      because: 'no-verdict',
    });
    // A verdict for a DIFFERENT proxy does not vouch for this one.
    expect(
      decideDeployReplay(PROXY, [verdictFor(OTHER, 'authoritative')]),
    ).toMatchObject({ kind: 'refuse', because: 'no-verdict' });
  });
});

describe('INV-10: already-current recognition is identity, never spelling', () => {
  it('recognizes the same implementation across all three encodings', () => {
    const canonical = canonicalizeAddress(PROXY);
    expect(isAlreadyCurrent(toTronHex(canonical), toBase58(canonical))).toBe(true);
    expect(isAlreadyCurrent(PROXY, toTronHex(canonical))).toBe(true);
  });

  it('does not recognize a genuinely different implementation', () => {
    expect(isAlreadyCurrent(PROXY, OTHER)).toBe(false);
  });
});
