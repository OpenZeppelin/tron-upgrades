const assert = require('assert');
const {
  validateImplementation,
  validateUpgrade,
  deployProxy,
} = require('@openzeppelin/tronbox-upgrades');

const Box = artifacts.require('Box');
const BoxV2 = artifacts.require('BoxV2');
const BoxBad = artifacts.require('BoxBad');

// Mocha files have no deployer. Validation must work here regardless, and a
// state-changing operation must refuse by name — never half-run.
contract('validation without a deployer', () => {
  it('validates a safe implementation with artifacts alone', async () => {
    const outcome = await validateImplementation(Box, { artifacts });
    assert.ok(Array.isArray(outcome.notes));
  });

  it('validates a safe upgrade pair with artifacts alone', async () => {
    const outcome = await validateUpgrade(Box, BoxV2, { artifacts });
    assert.ok(Array.isArray(outcome.notes));
  });

  it('refuses an unsafe implementation naming the violation', async () => {
    await assert.rejects(
      () => validateImplementation(BoxBad, { artifacts }),
      error => /delegatecall/i.test(String(error && error.message)),
    );
  });

  it('refuses a state-changing operation in this context', async () => {
    await assert.rejects(
      () => deployProxy(Box, [1], { artifacts }),
      error => {
        const message = String(error && error.message);
        return /deployer|tronWrap|context|missing|unsatisfied/i.test(message);
      },
    );
  });
});
