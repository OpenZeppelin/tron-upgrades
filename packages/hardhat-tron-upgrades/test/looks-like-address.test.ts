import { expect } from 'chai';
import { looksLikeAddress } from '../src/utils/ethers';

// Fabricated hre stubs — looksLikeAddress only ever reaches into hre.tre, so
// these avoid the live TRE dependency entirely (same pattern as
// test/namespaced-fallback.test.ts).
function brokenHre() {
  return { tre: { makeTronWeb: () => { throw new Error('no TRE'); } } } as any;
}
function workingHre(isAddress: boolean) {
  return { tre: { makeTronWeb: () => ({ tronWeb: { isAddress: () => isAddress } }) } } as any;
}

const BASE58 = 'TVj7RNVHy6thbM7BWdSe9G6gXwKhjhdNaS';
const HEX0X = '0x' + '1'.repeat(40);
const HEX41 = '41' + '1'.repeat(40);

describe('looksLikeAddress', function () {
  it('names the TRE limitation when a Base58 address cannot be checked', function () {
    const hre = brokenHre();
    expect(() => looksLikeAddress(hre, BASE58)).to.throw(/Base58.*TRON runtime|TRE/i);
    // non-address strings still fall through to the contract-name branch:
    expect(looksLikeAddress(hre, 'MyContract')).to.equal(false);
  });

  it('confirms a Base58 address when TRE is available', function () {
    expect(looksLikeAddress(workingHre(true), BASE58)).to.equal(true);
  });

  it('returns false for a non-address string when TRE is available', function () {
    expect(looksLikeAddress(workingHre(false), 'MyContract')).to.equal(false);
  });

  for (const [label, hexAddress] of [
    ['0x-hex', HEX0X],
    ['41-hex', HEX41],
  ] as const) {
    it(`recognizes ${label} addresses without consulting TRE`, function () {
      expect(looksLikeAddress(brokenHre(), hexAddress)).to.equal(true);
      expect(looksLikeAddress(workingHre(false), hexAddress)).to.equal(true);
    });
  }

  it('treats non-string targets as addresses', function () {
    expect(looksLikeAddress(brokenHre(), { getAddress: async () => HEX0X })).to.equal(true);
  });
});
