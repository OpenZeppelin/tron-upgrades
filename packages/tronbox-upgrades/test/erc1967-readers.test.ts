import { describe, expect, it } from 'vitest';

import { erc1967, beacon } from '../src/erc1967';
import { ChainBeaconNotFoundError, ChainImplementationNotFoundError } from '../src/chain';
import { NothingToAdoptError } from '../src/adopt/errors';
import { canonicalizeAddress, toBase58 } from '../src/record';
import {
  createHandleFixture,
  defaultRpcTable,
  slotWordFor,
  type RpcTable,
} from './helpers/chain-fixtures';

/** `createChainAccess`'s one construction-time probe, plus whatever the test needs. */
function tableWith(extra: RpcTable): RpcTable {
  return { ...defaultRpcTable, ...extra };
}

/*
 * The public 1967 readers — `erc1967` and `beacon` — over a fixture handle,
 * never a live node. Each takes the migration's own handles (just
 * `tronWrap`/`tronWeb` here) the same way every operation does, so the
 * fixture that already drives the chain layer's own suite
 * (`createHandleFixture`) is the right one to drive these through too.
 */

const IMPL = '0x2222222222222222222222222222222222222222';
const ADMIN = '0x3333333333333333333333333333333333333333'.slice(0, 42);
const BEACON = '0x4444444444444444444444444444444444444444'.slice(0, 42);

function expectedBase58(hex: string): string {
  return toBase58(canonicalizeAddress(hex));
}

describe('erc1967 — the three standard proxy slots, in TRON base58', () => {
  it('getImplementationAddress reads the modern slot and returns base58, not hex', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getStorageAt: { result: slotWordFor(IMPL) } }),
    });
    const address = await erc1967.getImplementationAddress(IMPL, {
      tronWrap: handle.raw,
    });
    expect(address).toBe(expectedBase58(IMPL));
    expect(address.startsWith('T')).toBe(true);
  });

  it('getImplementationAddress throws ChainImplementationNotFoundError when both slots are empty', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getStorageAt: { result: `0x${'0'.repeat(64)}` } }),
    });
    await expect(
      erc1967.getImplementationAddress(IMPL, { tronWrap: handle.raw }),
    ).rejects.toBeInstanceOf(ChainImplementationNotFoundError);
  });

  it('getAdminAddress returns the base58 zero address for an empty slot — never throws', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getStorageAt: { result: `0x${'0'.repeat(64)}` } }),
    });
    const address = await erc1967.getAdminAddress(ADMIN, { tronWrap: handle.raw });
    expect(address).toBe(expectedBase58('0x0000000000000000000000000000000000000000'));
  });

  it('getAdminAddress reads a non-empty admin slot and returns base58', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getStorageAt: { result: slotWordFor(ADMIN) } }),
    });
    const address = await erc1967.getAdminAddress(ADMIN, { tronWrap: handle.raw });
    expect(address).toBe(expectedBase58(ADMIN));
  });

  it('getBeaconAddress reads the beacon slot and returns base58', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getStorageAt: { result: slotWordFor(BEACON) } }),
    });
    const address = await erc1967.getBeaconAddress(BEACON, { tronWrap: handle.raw });
    expect(address).toBe(expectedBase58(BEACON));
  });

  it('getBeaconAddress throws ChainBeaconNotFoundError when the beacon slot is empty', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getStorageAt: { result: `0x${'0'.repeat(64)}` } }),
    });
    await expect(
      erc1967.getBeaconAddress(BEACON, { tronWrap: handle.raw }),
    ).rejects.toBeInstanceOf(ChainBeaconNotFoundError);
  });

  it('accepts tronWeb as the handle too, exactly like every operation', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getStorageAt: { result: slotWordFor(IMPL) } }),
    });
    const address = await erc1967.getImplementationAddress(IMPL, {
      tronWeb: handle.raw,
    });
    expect(address).toBe(expectedBase58(IMPL));
  });
});

describe('beacon — the beacon\'s own implementation(), not an ERC-1967 slot', () => {
  it('getImplementationAddress calls implementation() and returns base58', async () => {
    const handle = createHandleFixture({
      table: tableWith({
        eth_getCode: { result: '0x60806040' },
        eth_call: { result: slotWordFor(IMPL) },
      }),
    });
    const address = await beacon.getImplementationAddress(BEACON, {
      tronWrap: handle.raw,
    });
    expect(address).toBe(expectedBase58(IMPL));
  });

  it('refuses with NothingToAdoptError when there is no code at the address', async () => {
    const handle = createHandleFixture({
      table: tableWith({ eth_getCode: { result: '0x' } }),
    });
    await expect(
      beacon.getImplementationAddress(BEACON, { tronWrap: handle.raw }),
    ).rejects.toBeInstanceOf(NothingToAdoptError);
  });

  it('refuses with NothingToAdoptError when the address has code but does not answer implementation()', async () => {
    const handle = createHandleFixture({
      table: tableWith({
        eth_getCode: { result: '0x60806040' },
        eth_call: { error: { code: -32600, message: 'Smart contract is not exist.' } },
      }),
    });
    await expect(
      beacon.getImplementationAddress(BEACON, { tronWrap: handle.raw }),
    ).rejects.toBeInstanceOf(NothingToAdoptError);
  });
});
