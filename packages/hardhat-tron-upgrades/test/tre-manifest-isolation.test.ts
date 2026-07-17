import { expect } from 'chai';
import * as os from 'node:os';
import * as path from 'node:path';
import { manifestForHre } from '../src/utils/manifest';

// A restarted local TRE replays the same chainId but a new genesis, so a
// chainId-only manifest name would resolve deterministic addresses to STALE
// layout entries. When the runtime exposes a per-instance id (hre.tre.instanceId),
// the manifest is keyed by chain + instance and lives in the OS temp dir, so a
// fresh instance gets a fresh namespace. Networks without that seam are
// unchanged. The installed hardhat-tron here has no instanceId, so these tests
// stub it to exercise the active path.

const CHAIN_ID = 728126428; // not in upgrades-core's networkNames map

function stubHre(opts: { tre?: any } = {}) {
  return {
    network: {
      name: 'tre',
      provider: {
        send: async (method: string) => {
          if (method === 'eth_chainId') return '0x' + CHAIN_ID.toString(16);
          throw new Error(`unsupported RPC ${method}`); // dev-instance probes → public path
        },
      },
    },
    config: { paths: { root: os.tmpdir() } },
    ...(opts.tre !== undefined ? { tre: opts.tre } : {}),
  } as any;
}

const publicFile = path.join('.openzeppelin', `unknown-${CHAIN_ID}.json`);

function devFile(instanceId: string) {
  return path.join(os.tmpdir(), 'openzeppelin-upgrades', `tre-${CHAIN_ID}-${instanceId}.json`);
}

describe('TRE manifest isolation', function () {
  it('keys the manifest by chain + instance when hre.tre.instanceId exists', async () => {
    const m = await manifestForHre(stubHre({ tre: { instanceId: async () => '0xaaa1' } }));
    expect(m.file).to.equal(devFile('0xaaa1'));
  });

  it('reuses the same manifest namespace for the same instanceId', async () => {
    const a = await manifestForHre(stubHre({ tre: { instanceId: async () => '0xsame' } }));
    const b = await manifestForHre(stubHre({ tre: { instanceId: async () => '0xsame' } }));
    expect(a.file).to.equal(b.file);
  });

  it('gets a fresh manifest namespace when the instanceId changes', async () => {
    const a = await manifestForHre(stubHre({ tre: { instanceId: async () => '0xinst-a' } }));
    const b = await manifestForHre(stubHre({ tre: { instanceId: async () => '0xinst-b' } }));
    expect(a.file).to.not.equal(b.file);
  });

  it('keeps default naming when hre.tre exists but exposes no instanceId', async () => {
    const m = await manifestForHre(stubHre({ tre: { makeTronWeb: () => ({}) } }));
    expect(m.file).to.equal(publicFile);
  });

  it('keeps default naming on a non-TRE network (no hre.tre)', async () => {
    const m = await manifestForHre(stubHre());
    expect(m.file).to.equal(publicFile);
  });
});
