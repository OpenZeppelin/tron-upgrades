import hre from 'hardhat';
import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { implEntry, proxyRecord } from './_manifest-helper';

const { ethers, upgrades, network } = hre;

// Proves the manifest isolation end-to-end: with a dev-instance id reported
// through hardhat_metadata, a real deployProxy + upgradeProxy flow routes BOTH
// the proxy record (written by this plugin) AND the implementation/layout
// records (written by upgrades-core's OWN internal calls —
// fetchOrDeployGetDeployment, processProxyKind) into a SINGLE instance-qualified
// manifest, instead of splitting across an instance manifest and a chain-id-only
// one.
//
// The installed hardhat-tron used by this suite does not yet report metadata, so
// the test injects the seam by wrapping network.provider.send to answer
// hardhat_metadata; every other RPC passes through to the real node, so the
// deploy and upgrade run against TRE unchanged. This is the same provider both
// the plugin and upgrades-core read, so wrapping it exercises the exact
// resolution path that runs in production once hardhat-tron reports the id.

const INSTANCE_ID = '0xintegration-instance';

describe('TRE manifest isolation (integration through upgrades-core internals)', function () {
  this.timeout(240_000);

  let originalSend: ((method: string, params?: unknown[]) => Promise<unknown>) | undefined;
  let chainId: number;
  let instanceFile: string;
  let publicFile: string;

  before(async function () {
    if (network.name !== 'tre') {
      this.skip();
    }
    chainId = parseInt(await network.provider.send('eth_chainId', []), 16);
    instanceFile = path.join(
      os.tmpdir(),
      'openzeppelin-upgrades',
      `hardhat-${chainId}-${INSTANCE_ID}.json`,
    );
    publicFile = path.join(hre.config.paths.root, '.openzeppelin', `unknown-${chainId}.json`);
    fs.rmSync(instanceFile, { force: true });

    originalSend = network.provider.send.bind(network.provider);
    (network.provider as any).send = async (method: string, params?: unknown[]) => {
      if (method === 'hardhat_metadata') {
        return { clientVersion: 'test-stub', chainId, instanceId: INSTANCE_ID, forkedNetwork: undefined };
      }
      return originalSend!(method, params);
    };
  });

  after(function () {
    if (originalSend) {
      (network.provider as any).send = originalSend;
    }
    if (instanceFile) {
      fs.rmSync(instanceFile, { force: true });
    }
  });

  it('routes proxy AND implementation/layout records to one instance manifest', async () => {
    const [owner] = await ethers.getSigners();

    // deployProxy runs validation + impl deploy (upgrades-core internals) + proxy
    // deploy + record.
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 42n]);
    const boxAddress = await box.getAddress();
    const implV1 = await upgrades.erc1967.getImplementationAddress(box);

    // The instance-qualified manifest exists and holds BOTH the proxy record and
    // the impl+layout record — one file, written by two code paths.
    expect(fs.existsSync(instanceFile), `expected instance manifest at ${instanceFile}`).to.equal(
      true,
    );
    const m1 = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    const proxy1 = proxyRecord(m1, boxAddress);
    expect(proxy1, 'proxy record in instance manifest').to.not.equal(undefined);
    expect(proxy1.kind).to.equal('transparent');
    const e1 = implEntry(m1, implV1);
    expect(e1, 'v1 implementation record in instance manifest').to.not.equal(undefined);
    expect(e1.layout).to.have.property('storage');

    // upgradeProxy re-enters upgrades-core internals: it reads the stored layout,
    // deploys v2, re-points the proxy. The new impl lands in the SAME file.
    const boxV2 = await upgrades.upgradeProxy(box, 'TestBoxV2');
    expect(await boxV2.getAddress()).to.equal(boxAddress);
    const implV2 = await upgrades.erc1967.getImplementationAddress(box);
    expect(implV2.toLowerCase()).to.not.equal(implV1.toLowerCase());

    const m2 = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    expect(implEntry(m2, implV2), 'v2 implementation record in instance manifest').to.not.equal(
      undefined,
    );
    expect(implEntry(m2, implV1), 'v1 implementation record kept').to.not.equal(undefined);
    expect(proxyRecord(m2, boxAddress), 'proxy still recorded in instance manifest').to.not.equal(
      undefined,
    );

    // Isolation: the chain-id-only public manifest did NOT collect this run's
    // records — they are qualified by instance, so a restart (new instance)
    // starts from a clean namespace instead of resolving stale layouts.
    if (fs.existsSync(publicFile)) {
      const pub = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
      expect(proxyRecord(pub, boxAddress), 'proxy must not be in the public manifest').to.equal(
        undefined,
      );
      expect(implEntry(pub, implV1), 'impl must not be in the public manifest').to.equal(undefined);
    }
  });
});
