import hre from 'hardhat';
import { expect } from 'chai';

const { upgrades } = hre;

// tron-contracts annotates namespaced storage with the TIP-7201 convention
// (`@custom:storage-location trc7201:<id>`) rather than erc7201. The slot
// formula is identical to ERC-7201's, so the plugin normalizes the prefix at
// the upgrades-core boundary and these validate with the same slot precision as
// erc7201 namespaces. The padding-insert case is the discriminator: it is only
// safe (and only accepted) once slot/offset from the namespaced recompile are
// available, proving slot-aware validation engaged rather than AST fallback.
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
  // trc7201-annotated contract (tron-contracts convention) compiled together
  // both validate correctly — the prefix normalization touches only trc7201
  // structs and leaves erc7201 ones untouched.
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
});
