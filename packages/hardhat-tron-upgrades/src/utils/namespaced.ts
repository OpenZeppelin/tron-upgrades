import fs from 'node:fs';
import path from 'node:path';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from 'hardhat/builtin-tasks/task-names';
import { core } from './core';

// Namespaced (ERC-7201) storage validation needs a SECOND compilation of the
// contracts, rewritten so namespace struct members become ordinary storage
// variables with real slot/offset. Without it, namespace members are known by
// name and type only (from the AST), so slot-sensitive changes — a member
// inserted into intra-slot padding, or a repack — are decided wrong.
//
// The recompile is expensive, so its output is cached per build-info, keyed by
// the build-info id (a content hash of the compiler input): in-memory for the
// life of the process, and on disk beside the build-info so a later process
// reuses it. `null` records that a build-info has no usable namespaced output
// (compiler too old, or the recompile failed) so we never retry it.

type SolcOutput = any;

const memoryCache = new Map<string, SolcOutput | null>();

function diskCachePath(hre: HardhatRuntimeEnvironment, buildInfoId: string): string {
  return path.join(hre.config.paths.artifacts, 'build-info', `${buildInfoId}.namespaced.json`);
}

async function compileNamespaced(
  hre: HardhatRuntimeEnvironment,
  input: unknown,
  solcVersion: string,
): Promise<SolcOutput> {
  // Reuse the exact compiler the primary build used. On TRON the solc build is
  // the tron-solc wasm (isSolcJs), supplied by @openzeppelin/hardhat-tron's
  // GET_SOLC_BUILD hook; the same settings ride along in `input`.
  const solcBuild = await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, {
    quiet: true,
    solcVersion,
  });
  if (solcBuild.isSolcJs) {
    return hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, {
      input,
      solcJsPath: solcBuild.compilerPath,
    });
  }
  return hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, {
    input,
    solcPath: solcBuild.compilerPath,
    solcVersion,
  });
}

async function computeNamespacedOutput(
  hre: HardhatRuntimeEnvironment,
  buildInfo: any,
): Promise<SolcOutput | null> {
  const { isNamespaceSupported, makeNamespacedInput, trySanitizeNatSpec, logWarning } = core();
  const solcVersion: string = buildInfo.solcVersion;
  if (!isNamespaceSupported(solcVersion)) return null;

  let namespacedInput = makeNamespacedInput(buildInfo.input, buildInfo.output, solcVersion);
  namespacedInput = await trySanitizeNatSpec(namespacedInput, solcVersion);

  const output = await compileNamespaced(hre, namespacedInput, solcVersion);
  const errors: any[] = (output?.errors ?? []).filter((e: any) => e.severity === 'error');
  if (errors.length > 0) {
    // Fall back to AST-only namespace validation rather than aborting: the
    // primary compilation already succeeded, so this only forfeits the extra
    // slot-level precision for advanced namespace edits.
    logWarning(
      'Failed to compile the modified contracts for namespaced storage-layout validation; ' +
        'falling back to AST-only checks for namespaced storage.',
      errors.map((e: any) => e.formattedMessage ?? e.message),
    );
    return null;
  }
  return output;
}

// Namespaced solc output for a build-info, or `undefined` when none applies.
// Result is cached (memory + on disk) keyed by build-info id.
export async function getNamespacedOutput(
  hre: HardhatRuntimeEnvironment,
  buildInfo: any,
): Promise<SolcOutput | undefined> {
  const id: string = buildInfo.id;
  if (memoryCache.has(id)) {
    return memoryCache.get(id) ?? undefined;
  }

  const cachePath = diskCachePath(hre, id);
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    memoryCache.set(id, cached);
    return cached ?? undefined;
  } catch {
    // Cache miss (or unreadable) — recompute below.
  }

  const output = await computeNamespacedOutput(hre, buildInfo);
  memoryCache.set(id, output);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(output));
  } catch {
    // A missing on-disk cache only costs a recompile next process; ignore.
  }
  return output ?? undefined;
}

// Pre-warm the namespaced cache for every build-info produced by a compile, so
// later deploy/upgrade/validate calls never pay the recompile cost inline.
export async function warmNamespacedCache(hre: HardhatRuntimeEnvironment): Promise<void> {
  const paths: string[] = await hre.artifacts.getBuildInfoPaths();
  for (const p of paths) {
    try {
      const buildInfo = JSON.parse(fs.readFileSync(p, 'utf8'));
      await getNamespacedOutput(hre, buildInfo);
    } catch {
      // Best-effort warm-up; the lazy path recomputes on demand if needed.
    }
  }
}
