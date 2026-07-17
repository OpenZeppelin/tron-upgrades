// Extends the compile task to build the namespaced (ERC-7201) recompile cache
// right after a successful compile, so deploy/upgrade/validate calls never pay
// the extra tron-solc pass inline. The cache is keyed by build-info id, so this
// is a no-op once warm. Warming is best-effort: the lazy path recomputes on
// demand, and a failure here must never fail the user's compile.
import { task } from 'hardhat/config';
import { TASK_COMPILE } from 'hardhat/builtin-tasks/task-names';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { warmNamespacedCache } from './utils/namespaced';

task(TASK_COMPILE).setAction(async (args, hre: HardhatRuntimeEnvironment, runSuper) => {
  const result = await runSuper(args);
  try {
    await warmNamespacedCache(hre);
  } catch {
    // Best-effort; namespaced output is recomputed lazily if warming fails.
  }
  return result;
});
