import { expect } from 'chai';
import * as os from 'node:os';
import * as path from 'node:path';
import { manifestForHre } from '../src/utils/manifest';

// A restarted local TRE replays the same chainId but a new instance, so a
// chainId-only manifest name would resolve deterministic addresses to STALE
// layout entries. manifestForHre now delegates entirely to upgrades-core's
// Manifest.forNetwork, which resolves a dev instance by probing the provider's
// hardhat_metadata / anvil_metadata RPC. When the node reports an instance id
// (hardhat-tron's provider does this on a TRE it manages), the manifest is keyed
// by chain + instance and lives in the OS temp dir; a node that reports no
// metadata keeps the default chain-id naming, byte-for-byte. These tests stub
// the provider to exercise both paths.

const CHAIN_ID = 728126428; // not in upgrades-core's networkNames map, not 31337

// metadata? controls whether the stub reports a dev instance. anvil_metadata
// always errors, mirroring a real java-tron node, so forNetwork falls through to
// hardhat_metadata exactly as it does against hardhat-tron.
function stubHre(metadata?: { instanceId: string }) {
  return {
    network: {
      name: 'tre',
      provider: {
        send: async (method: string) => {
          if (method === 'eth_chainId') return '0x' + CHAIN_ID.toString(16);
          if (method === 'anvil_metadata') throw new Error(`unsupported RPC ${method}`);
          if (method === 'hardhat_metadata') {
            if (metadata === undefined) throw new Error(`unsupported RPC ${method}`);
            return {
              clientVersion: 'stub',
              chainId: CHAIN_ID,
              instanceId: metadata.instanceId,
              forkedNetwork: undefined,
            };
          }
          throw new Error(`unsupported RPC ${method}`);
        },
      },
    },
    config: { paths: { root: os.tmpdir() } },
  } as any;
}

const publicFile = path.join('.openzeppelin', `unknown-${CHAIN_ID}.json`);

// forNetwork labels a hardhat_metadata-reporting node 'hardhat'.
function devFile(instanceId: string) {
  return path.join(os.tmpdir(), 'openzeppelin-upgrades', `hardhat-${CHAIN_ID}-${instanceId}.json`);
}

describe('TRE manifest isolation', function () {
  it('keys the manifest by chain + instance when the provider reports metadata', async () => {
    const m = await manifestForHre(stubHre({ instanceId: '0xaaa1' }));
    expect(m.file).to.equal(devFile('0xaaa1'));
  });

  it('reuses the same manifest namespace for the same instanceId', async () => {
    const a = await manifestForHre(stubHre({ instanceId: '0xsame' }));
    const b = await manifestForHre(stubHre({ instanceId: '0xsame' }));
    expect(a.file).to.equal(b.file);
  });

  it('gets a fresh manifest namespace when the instanceId changes', async () => {
    const a = await manifestForHre(stubHre({ instanceId: '0xinst-a' }));
    const b = await manifestForHre(stubHre({ instanceId: '0xinst-b' }));
    expect(a.file).to.not.equal(b.file);
  });

  it('keeps default naming when the provider reports no dev-instance metadata', async () => {
    const m = await manifestForHre(stubHre());
    expect(m.file).to.equal(publicFile);
  });
});
