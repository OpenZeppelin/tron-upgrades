import hre from 'hardhat';
import { expect } from 'chai';
import { solcInputOutputDecoder, validate } from '@openzeppelin/upgrades-core';
import { assertNoNamespaceSlotCollisions } from '../src/utils/namespace-prefix';

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

  // The plugin deliberately does not rewrite annotations, so a rejection for a
  // trc7201 namespace must quote the annotation the developer actually wrote and
  // must never show an erc7201-rewritten form of it.
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

    // A malformed annotation must reach upgrades-core untouched: the scan
    // declines to parse it, so core's own error surfaces instead of a
    // collision error quoting an id core never accepted. The separator after
    // the tag name must be a literal space — upstream reads a tab as zero
    // arguments, and parsing it leniently here would mask that.
    //
    // Injected into a build-info clone rather than added as a .sol fixture:
    // upgrades-core validates a whole compilation unit at once, so one
    // malformed annotation in `contracts/` fails EVERY contract sharing its
    // build-info (verified — a clean `hardhat compile` puts all of them in one).
    const MALFORMED = {
      'no argument': '@custom:storage-location',
      'a tab separator': '@custom:storage-location\terc7201:example.collide',
      'two arguments': '@custom:storage-location erc7201:example.collide extra',
    };
    const FQ_NAME = 'contracts/NamespacePrefixCollision.sol:NsCollideSelf';

    for (const [label, text] of Object.entries(MALFORMED)) {
      it(`leaves ${label} to upgrades-core`, async () => {
        // getBuildInfo re-reads from disk, so this mutation is test-local.
        const buildInfo: any = await hre.artifacts.getBuildInfo(FQ_NAME);
        const contract = buildInfo.output.sources[
          'contracts/NamespacePrefixCollision.sol'
        ].ast.nodes.find(
          (n: any) => n.nodeType === 'ContractDefinition' && n.name === 'NsCollideSelf',
        );
        contract.nodes.find(
          (n: any) => n.nodeType === 'StructDefinition' && n.name === 'AStorage',
        ).documentation.text = text;

        expect(() => assertNoNamespaceSlotCollisions(buildInfo, FQ_NAME)).to.not.throw();
        const decodeSrc = solcInputOutputDecoder(buildInfo.input, buildInfo.output);
        expect(() =>
          validate(buildInfo.output, decodeSrc, buildInfo.solcVersion, buildInfo.input),
        ).to.throw(/must have exactly one argument/);
      });
    }
  });
});
