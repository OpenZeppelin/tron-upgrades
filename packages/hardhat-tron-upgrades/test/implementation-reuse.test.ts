import hre from 'hardhat';
import { expect } from 'chai';
import { implEntry, readManifest, writeManifest } from './_manifest-helper';

const { ethers, upgrades } = hre;

describe('implementation reuse', function () {
  this.timeout(240_000);

  it('onchange reuses one implementation across two proxies', async () => {
    const [owner] = await ethers.getSigners();
    const opts = { constructorArgs: [101n] };
    const a = await upgrades.deployProxy('TestBoxWithCtor', [owner.address, 1n], opts);
    const b = await upgrades.deployProxy('TestBoxWithCtor', [owner.address, 2n], opts);
    const aImpl = await upgrades.erc1967.getImplementationAddress(a);
    const bImpl = await upgrades.erc1967.getImplementationAddress(b);

    expect(bImpl).to.equal(aImpl);
    expect(await a.value()).to.equal(1n);
    expect(await b.value()).to.equal(2n);
  });

  it('always deploys a fresh address and merges it into allAddresses', async () => {
    const first = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [102n] });
    const second = await upgrades.deployImplementation('TestBoxWithCtor', {
      constructorArgs: [102n],
      redeployImplementation: 'always',
    });
    expect(second.toLowerCase()).to.not.equal(first.toLowerCase());
    const manifest = await readManifest();
    expect(implEntry(manifest, first)).to.equal(implEntry(manifest, second));
  });

  it('never rejects when the requested version has not been deployed', async () => {
    await expect(
      upgrades.deployImplementation('TestBoxWithCtor', {
        constructorArgs: [103n],
        redeployImplementation: 'never',
      }),
    ).to.be.rejectedWith(/not previously deployed|not deployed/i);
  });

  it('onchange replaces a stale no-code manifest entry', async () => {
    const original = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [104n] });
    const manifest = await readManifest();
    const entry = implEntry(manifest, original);
    entry.address = ethers.Wallet.createRandom().address;
    delete entry.allAddresses;
    delete entry.txHash;
    await writeManifest(manifest);

    const replacement = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [104n] });
    expect(replacement.toLowerCase()).to.not.equal(entry.address.toLowerCase());
    expect(implEntry(await readManifest(), replacement)).to.not.equal(undefined);
  });

  it('useDeployedImplementation reuses an existing implementation and rejects an unknown one', async () => {
    const first = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [108n] });
    const reused = await upgrades.deployImplementation('TestBoxWithCtor', {
      constructorArgs: [108n],
      useDeployedImplementation: true,
    });
    expect(reused).to.equal(first);

    await expect(
      upgrades.deployImplementation('TestBoxWithCtor', {
        constructorArgs: [109n],
        useDeployedImplementation: true,
      }),
    ).to.be.rejectedWith(/useDeployedImplementation option was set to true/);
  });

  it('useDeployedImplementation conflicts with redeployImplementation', async () => {
    await expect(
      upgrades.deployImplementation('TestBoxWithCtor', {
        constructorArgs: [110n],
        useDeployedImplementation: true,
        redeployImplementation: 'always',
      }),
    ).to.be.rejectedWith(/cannot both be set/);
  });

  it('useDeployedImplementation flows through deployProxy and prepareUpgrade', async () => {
    const [owner] = await ethers.getSigners();
    await expect(
      upgrades.deployProxy('TestBoxWithCtor', [owner.address, 3n], {
        constructorArgs: [111n],
        useDeployedImplementation: true,
      }),
    ).to.be.rejectedWith(/useDeployedImplementation option was set to true/);

    const implAddress = await upgrades.deployImplementation('TestBoxWithCtor', {
      constructorArgs: [111n],
    });
    const proxy = await upgrades.deployProxy('TestBoxWithCtor', [owner.address, 3n], {
      constructorArgs: [111n],
      useDeployedImplementation: true,
    });
    expect((await upgrades.erc1967.getImplementationAddress(proxy)).toLowerCase()).to.equal(
      implAddress.toLowerCase(),
    );

    const preparedTarget = await upgrades.deployImplementation('TestBoxV2');
    const prepared = await upgrades.prepareUpgrade(
      await upgrades.deployProxy('TestBoxV1', [owner.address, 4n]),
      'TestBoxV2',
      { useDeployedImplementation: true },
    );
    expect(prepared.toLowerCase()).to.equal(preparedTarget.toLowerCase());
  });

  it('same constructor arguments produce the same reusable version key', async () => {
    const first = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [105n] });
    const second = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [105n] });
    expect(second).to.equal(first);
  });

  it('different constructor arguments produce different version keys and deployments', async () => {
    const first = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [106n] });
    const second = await upgrades.deployImplementation('TestBoxWithCtor', { constructorArgs: [107n] });
    expect(second.toLowerCase()).to.not.equal(first.toLowerCase());
    expect(implEntry(await readManifest(), first)).to.not.equal(implEntry(await readManifest(), second));
  });
});
