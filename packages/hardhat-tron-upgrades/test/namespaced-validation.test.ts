import hre from 'hardhat';
import { expect } from 'chai';

const { upgrades } = hre;

// ERC-7201 namespace members are not ordinary storage variables: the primary
// build-info gives their names and types but no slot/offset. Deciding these
// upgrades correctly needs the namespaced recompile threaded into validation.
// The padding-insert case is the discriminator — it is only safe (and only
// accepted) once slot/offset from the recompile are available.
describe('Namespaced (ERC-7201) storage validation', function () {
  this.timeout(240_000);

  it('rejects a packing change that shifts namespace members', async () => {
    await expect(upgrades.validateUpgrade('NsPackV1', 'NsPackV2')).to.be.rejectedWith(/incompatible/i);
  });

  it('accepts appending a trailing namespace member', async () => {
    await upgrades.validateUpgrade('NsAppendV1', 'NsAppendV2'); // must not throw
  });

  it('accepts inserting a member into intra-slot namespace padding', async () => {
    await upgrades.validateUpgrade('NsPadV1', 'NsPadV2'); // must not throw
  });

  it('rejects deleting a namespace', async () => {
    await expect(upgrades.validateUpgrade('NsDeleteV1', 'NsDeleteV2')).to.be.rejectedWith(
      /Deleted namespace/i,
    );
  });

  it('rejects changing a namespace id', async () => {
    await expect(upgrades.validateUpgrade('NsIdV1', 'NsIdV2')).to.be.rejectedWith(/Deleted namespace/i);
  });

  it('rejects a nested-struct change inside a namespace', async () => {
    await expect(upgrades.validateUpgrade('NsNestedV1', 'NsNestedV2')).to.be.rejectedWith(/incompatible/i);
  });

  // Non-namespaced error UX must be untouched by the namespaced rework: the
  // classic variable-reorder diagnosis is byte-for-byte the same.
  it('preserves the classic variable-reorder error message', async () => {
    let error: any = null;
    try {
      await upgrades.validateUpgrade('TestBoxV1', 'TestBoxV2StorageConflict');
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
    expect(error.message).to.contain(
      'Storage layout of TestBoxV2StorageConflict is incompatible with TestBoxV1:',
    );
    expect(error.message).to.contain('Deleted `value`');
    expect(error.message).to.contain('Keep the variable even if unused');
    expect(error.message).to.contain('Inserted `value`');
  });
});
