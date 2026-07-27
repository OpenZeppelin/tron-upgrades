import hre from 'hardhat';
import { expect } from 'chai';

const { upgrades } = hre;

// tron-contracts annotates namespaced storage with the TIP-7201 convention
// (`@custom:storage-location trc7201:<id>`) rather than erc7201. Annotations
// are passed to upgrades-core verbatim; identity for cross-prefix collision
// detection is prefix-insensitive (see src/utils/namespace-prefix.ts). The
// slot formula is identical to ERC-7201's, so these validate with the same slot
// precision as erc7201 namespaces. The padding-insert case is the
// discriminator: it is only safe (and only accepted) once slot/offset from the
// namespaced recompile are available, proving slot-aware validation engaged
// rather than AST fallback.
describe('Namespaced (TRC-7201) storage validation', function () {
  this.timeout(240_000);

  it('rejects a packing change that shifts namespace members', async () => {
    await expect(upgrades.validateUpgrade('TrcNsPackV1', 'TrcNsPackV2')).to.be.rejectedWith(
      /incompatible/i,
    );
  });

  it('accepts appending a trailing namespace member', async () => {
    await upgrades.validateUpgrade('TrcNsAppendV1', 'TrcNsAppendV2'); // must not throw
  });

  it('accepts inserting a member into intra-slot namespace padding', async () => {
    await upgrades.validateUpgrade('TrcNsPadV1', 'TrcNsPadV2'); // must not throw
  });

  it('rejects changing a namespace id', async () => {
    await expect(upgrades.validateUpgrade('TrcNsIdV1', 'TrcNsIdV2')).to.be.rejectedWith(
      /Deleted namespace/i,
    );
  });

  // A rejection for a trc7201 namespace must show the annotation the developer
  // actually wrote, not the normalized erc7201 prefix.
  it('reports the original trc7201 prefix in rejection messages', async () => {
    let error: any = null;
    try {
      await upgrades.validateUpgrade('TrcNsIdV1', 'TrcNsIdV2');
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
    expect(error.message).to.contain('trc7201:example.trc.renamed.before');
    expect(error.message).to.not.contain('erc7201:example.trc.renamed.before');
  });

  // Mixed codebase: an erc7201-annotated contract (OZ upstream convention) and a
  // trc7201-annotated contract (tron-contracts convention) both validate
  // correctly — annotations reach upgrades-core verbatim, so neither convention
  // is altered by the presence of the other.
  describe('mixed erc7201 + trc7201 codebase', function () {
    it('accepts safe appends for both conventions', async () => {
      await upgrades.validateUpgrade('NsAppendV1', 'NsAppendV2'); // erc7201, must not throw
      await upgrades.validateUpgrade('TrcNsAppendV1', 'TrcNsAppendV2'); // trc7201, must not throw
    });

    it('rejects unsafe reorders for both conventions', async () => {
      await expect(upgrades.validateUpgrade('NsPackV1', 'NsPackV2')).to.be.rejectedWith(
        /incompatible/i,
      );
      await expect(upgrades.validateUpgrade('TrcNsPackV1', 'TrcNsPackV2')).to.be.rejectedWith(
        /incompatible/i,
      );
    });
  });

  // The two prefixes hash the same id to the same slot, so a contract carrying
  // both is silently overlapping storage. upgrades-core keys namespaces by the
  // full annotation string and cannot see it.
  describe('cross-prefix slot collision', function () {
    it('rejects erc7201 and trc7201 namespaces with the same id in one contract', async () => {
      await expect(upgrades.validateImplementation('NsCollideSelf')).to.be.rejectedWith(
        /same storage slot/i,
      );
    });

    it('rejects a cross-prefix collision inherited from a base contract', async () => {
      await expect(upgrades.validateImplementation('NsCollideDerived')).to.be.rejectedWith(
        /same storage slot/i,
      );
    });

    it('names both original annotations in the collision message', async () => {
      const err = await upgrades.validateImplementation('NsCollideSelf').then(
        () => null,
        (e: Error) => e,
      );
      expect(err, 'expected rejection').to.not.equal(null);
      expect(err!.message).to.contain('erc7201:example.collide');
      expect(err!.message).to.contain('trc7201:example.collide');
    });

    it('accepts different ids under different prefixes', async () => {
      await upgrades.validateImplementation('NsPrefixDisjoint'); // must not throw
    });
  });
});
