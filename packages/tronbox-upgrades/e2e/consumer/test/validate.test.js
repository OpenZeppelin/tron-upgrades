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

  // The option resolver runs for real here — no deployer needed — so a key
  // the operation does not accept, or a value outside its accepted set, must
  // refuse by name instead of being silently dropped (the failure mode the
  // resolver exists to prevent).
  it('refuses a key this operation does not accept, naming the accepted set', async () => {
    await assert.rejects(
      () => validateImplementation(Box, { artifacts, initializer: false }),
      error =>
        error &&
        error.code === 'OPTION_UNKNOWN' &&
        /initializer/.test(String(error.message)) &&
        /accepts/.test(String(error.message)),
    );
  });

  it('refuses an unsafeAllow member outside the accepted set, never ignoring it', async () => {
    await assert.rejects(
      () => validateImplementation(Box, { artifacts, unsafeAllow: ['not-a-kind'] }),
      error =>
        error &&
        error.code === 'OPTION_VALUE_INVALID' &&
        /unsafeAllow/.test(String(error.message)),
    );
  });
});
