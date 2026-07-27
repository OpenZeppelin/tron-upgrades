// Extends the compile task to build the namespaced (ERC-7201) recompile cache
// right after a successful compile, so deploy/upgrade/validate calls never pay
// the extra tron-solc pass inline. The cache is keyed by build-info id, so this
// is a no-op once warm. Warming is best-effort EXCEPT a NamespacedCompileError
// raised under namespacedCompileErrors: 'error' — that fails the compile by
// design (upstream parity: earliest signal, even though primary artifacts may
// already be written when the task exits non-zero, same as upstream).
import { task } from 'hardhat/config';
import { TASK_COMPILE } from 'hardhat/builtin-tasks/task-names';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { NamespacedCompileError, warmNamespacedCache } from './utils/namespaced';

task(TASK_COMPILE).setAction(async (args, hre: HardhatRuntimeEnvironment, runSuper) => {
  const result = await runSuper(args);
  try {
    await warmNamespacedCache(hre);
  } catch (e) {
    if (e instanceof NamespacedCompileError) throw e;
    // Best-effort; namespaced output is recomputed lazily if warming fails.
  }
  return result;
});
