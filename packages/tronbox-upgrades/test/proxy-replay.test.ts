import { describe, expect, it } from 'vitest';

import {
  decideDeployReplay,
  isAlreadyCurrent,
} from '../src/proxy/replay';
import { canonicalizeAddress, toBase58 } from '../src/record';
// `toTronHex` is deliberately NOT on the record face; the suite reaches it the
// same way the record layer's tests do — a test-only deep import.
import { toTronHex } from '../src/record/address';
import type { ProxyRecordVerdict } from '../src/record';

/*
 * The proxy operations — replay recognition as pure decisions. The
 * send-count halves of both decisions belong to the operation tests; what
 * this file pins is that the DECISIONS are canonical and closed, because the
 * operation can only be as right as the decision it acts on.
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

describe('the deploy replay decision', () => {
  it('proceeds with no prior address, whatever the record holds', () => {
    expect(decideDeployReplay(null, [verdictFor(PROXY, 'authoritative')])).toEqual(
      { kind: 'proceed' },
    );
  });

  it('proceeds past an authoritative prior — matched canonically across encodings — deployProxy never reuses it', () => {
    const canonical = canonicalizeAddress(PROXY);
    // The artifact may hold any of the three spellings; the verdict list holds
    // canonical form. Recognition must be identity, not string equality —
    // `deployProxy` still deploys fresh regardless, but a spelling mismatch
    // must not be misread as an unrecorded (refused) address.
    for (const spelling of [PROXY, toBase58(canonical), toTronHex(canonical)]) {
      expect(
        decideDeployReplay(spelling, [verdictFor(PROXY, 'authoritative')]),
      ).toEqual({ kind: 'proceed' });
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

describe('implementation identity comparison is canonical, never spelling', () => {
  it('recognizes the same implementation across all three encodings', () => {
    const canonical = canonicalizeAddress(PROXY);
    expect(isAlreadyCurrent(toTronHex(canonical), toBase58(canonical))).toBe(true);
    expect(isAlreadyCurrent(PROXY, toTronHex(canonical))).toBe(true);
  });

  it('does not recognize a genuinely different implementation', () => {
    expect(isAlreadyCurrent(PROXY, OTHER)).toBe(false);
  });
});
