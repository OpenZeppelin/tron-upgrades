'use strict';

const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { readManifest, implEntry } = require('./_manifest-helper');

describe('validation and transaction options', function () {
  this.timeout(240_000);

  it('unsafeAllow is required for a non-annotated constructor', async () => {
    await expect(upgrades.validateImplementation('TestBoxUnsafeCtor')).to.be.rejectedWith(/constructor/i);
    await upgrades.validateImplementation('TestBoxUnsafeCtor', { unsafeAllow: ['constructor'] });
    const address = await upgrades.deployImplementation('TestBoxUnsafeCtor', {
      unsafeAllow: ['constructor'],
    });
    expect(await ethers.getContractAt('TestBoxUnsafeCtor', address).then((box) => box.version())).to.equal(
      'unsafe-ctor',
    );
  });

  it('unsafeSkipStorageCheck bypasses an incompatible layout only when explicit', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 41n]);
    await expect(upgrades.upgradeProxy(box, 'TestBoxV2StorageConflict')).to.be.rejectedWith(/incompatible/i);
    const broken = await upgrades.upgradeProxy(box, 'TestBoxV2StorageConflict', {
      unsafeSkipStorageCheck: true,
    });
    expect(await broken.version()).to.equal('v2-broken');
  });

  it('unsafeAllowRenames allows a deliberate same-type slot rename', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV2', [owner.address, 42n]);
    await expect(upgrades.upgradeProxy(box, 'TestBoxV2Incompat')).to.be.rejectedWith(/incompatible/i);
    const renamed = await upgrades.upgradeProxy(box, 'TestBoxV2Incompat', {
      unsafeAllowRenames: true,
    });
    expect(await renamed.version()).to.equal('v2-incompatible');
  });

  it('accepts upstream gasLimit in txOverrides', async () => {
    const address = await upgrades.deployImplementation('TestBoxWithCtor', {
      constructorArgs: [201n],
      txOverrides: { gasLimit: 5_000_000n },
    });
    expect(implEntry(await readManifest(), address)).to.not.equal(undefined);
  });

  it('rejects transaction overrides that the TRON bridge cannot translate', async () => {
    await expect(
      upgrades.deployImplementation('TestBoxWithCtor', {
        constructorArgs: [202n],
        txOverrides: { gasPrice: 1n, nonce: 7 },
      }),
    ).to.be.rejectedWith(/gasPrice.*nonce|nonce.*gasPrice/i);
  });

  it('encodes call: { fn, args } against the new implementation', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 43n]);
    const boxV2 = await upgrades.upgradeProxy(box, 'TestBoxV2', {
      call: { fn: 'increment', args: [] },
    });
    expect(await boxV2.value()).to.equal(44n);
    expect(await boxV2.incrementCount()).to.equal(1n);
  });

  it('getTxResponse returns deployment responses from both preparation APIs', async () => {
    const [owner] = await ethers.getSigners();
    const deploymentTx = await upgrades.deployImplementation('TestBoxWithCtor', {
      constructorArgs: [203n],
      getTxResponse: true,
    });
    expect(deploymentTx.hash).to.match(/^0x[0-9a-f]{64}$/i);
    expect(await deploymentTx.wait()).to.not.equal(null);

    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 44n]);
    const prepareTx = await upgrades.prepareUpgrade(box, 'TestBoxWithCtor', {
      constructorArgs: [204n],
      getTxResponse: true,
    });
    expect(prepareTx.hash).to.match(/^0x[0-9a-f]{64}$/i);
    expect(Object.values((await readManifest()).impls).some((entry) => entry.txHash === prepareTx.hash)).to.equal(
      true,
    );
  });

  it('rejects initialOwner for uups instead of silently ignoring it', async () => {
    const [owner] = await ethers.getSigners();
    await expect(
      upgrades.deployProxy('TestBoxUUPSV1', [owner.address, 45n], {
        initialOwner: owner.address,
      }),
    ).to.be.rejectedWith(/initialOwner.*uups/i);
  });

  it('rejects a ProxyAdmin contract as initialOwner unless explicitly skipped', async () => {
    const [owner] = await ethers.getSigners();
    const box = await upgrades.deployProxy('TestBoxV1', [owner.address, 46n]);
    const adminAddress = await upgrades.erc1967.getAdminAddress(box);

    await expect(
      upgrades.deployProxy('TestBoxV1', [owner.address, 47n], { initialOwner: adminAddress }),
    ).to.be.rejectedWith(/must not be a ProxyAdmin contract/);

    const skipped = await upgrades.deployProxy('TestBoxV1', [owner.address, 48n], {
      initialOwner: adminAddress,
      unsafeSkipProxyAdminCheck: true,
    });
    expect(await skipped.value()).to.equal(48n);
  });

  it('uninitialized deploys fail before the chain for TRC1967-based kinds, work for beacons', async () => {
    // The ported TRC1967Proxy (inherited by the transparent proxy) rejects
    // empty constructor data, so upstream's missing-default-initializer
    // tolerance cannot apply to transparent or uups — deterministic errors,
    // no transactions sent.
    await expect(upgrades.deployProxy('TestBoxV3')).to.be.rejectedWith(
      /initializer: false is not supported for kind "transparent"/,
    );
    await expect(upgrades.deployProxy('TestBoxUUPSV3', [], { kind: 'uups' })).to.be.rejectedWith(
      /initializer: false is not supported for kind "uups"/,
    );

    // An explicitly named missing initializer is always an error.
    await expect(upgrades.deployProxy('TestBoxV3', [], { initializer: 'setUp' })).to.be.rejectedWith(
      /no initializer function matching/,
    );

    // BeaconProxy accepts empty data: a contract without an initialize
    // function deploys uninitialized (upstream parity).
    const beacon = await upgrades.deployBeacon('TestBoxV3');
    const box = await upgrades.deployBeaconProxy(beacon, 'TestBoxV3');
    expect(await box.version()).to.equal('v3');
    expect(await box.value()).to.equal(0n);
  });

  it('exposes silenceWarnings from upgrades-core', async () => {
    expect(upgrades.silenceWarnings).to.be.a('function');
    upgrades.silenceWarnings();
  });
});
