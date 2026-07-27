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
// The recompile is expensive, so its result is cached per build-info, keyed by
// the build-info id (a content hash of the compiler input): in-memory for the
// life of the process, and on disk beside the build-info so a later process
// reuses it. The cache stores a discriminated `NamespacedCacheEntry` — the
// recompile's outcome only ('output', 'unsupported', or 'compile-failed') —
// with no policy baked in. Severity (throw / warn / silent) is decided at
// CONSUMPTION time from the calling process's `namespacedCompileErrors`
// setting, not at compute time, so a cache written under one setting is
// interpreted correctly by a later process running under another. A raw
// legacy (pre-schema) disk value is ambiguous between 'unsupported' and
// 'compile-failed', so it is discarded and recomputed rather than guessed.

type SolcOutput = any;

const CACHE_SCHEMA = 2 as const;

type NamespacedCacheEntry =
  | { schema: typeof CACHE_SCHEMA; kind: 'output'; output: SolcOutput }
  | { schema: typeof CACHE_SCHEMA; kind: 'unsupported' }
  | { schema: typeof CACHE_SCHEMA; kind: 'compile-failed'; errorLines: string[] };

function isCacheEntry(v: unknown): v is NamespacedCacheEntry {
  return typeof v === 'object' && v !== null && (v as any).schema === CACHE_SCHEMA;
}

const memoryCache = new Map<string, NamespacedCacheEntry>();

// Build-info ids already announced as degraded this process, so the fallback
// warning is emitted once per id rather than on every validation call.
const warnedFallbackIds = new Set<string>();

// Warning sink, injectable so tests can observe emission independently of the
// process-global silence flag in upgrades-core. Defaults to the standard
// upgrades-core warning channel (which honors `silenceWarnings`).
function defaultSink(title: string, lines: string[]): void {
  core().logWarning(title, lines);
}
let warningSink: (title: string, lines: string[]) => void = defaultSink;

export function setNamespacedWarningSink(
  sink: ((title: string, lines: string[]) => void) | null,
): void {
  warningSink = sink ?? defaultSink;
}

function warnNamespacedFallback(buildInfoId: string, detailLines: string[] = []): void {
  if (warnedFallbackIds.has(buildInfoId)) return;
  warnedFallbackIds.add(buildInfoId);
  warningSink(
    'Namespaced (ERC-7201) storage validation is using AST-only fallback for build-info ' +
      `${buildInfoId}; slot-level precision for namespace edits is reduced. Recompile to ` +
      "restore full checks, or set tronUpgrades.namespacedCompileErrors: 'error' to fail instead.",
    detailLines,
  );
}

// True when any source AST in the build-info carries a `@custom:storage-location`
// annotation, i.e. the build-info actually declares namespaced storage and so
// loses precision without the namespaced recompile.
export function buildInfoHasNamespaces(buildInfo: any): boolean {
  const sources = buildInfo?.output?.sources ?? {};
  for (const source of Object.values<any>(sources)) {
    if (astHasStorageLocation(source?.ast)) return true;
  }
  return false;
}

function astHasStorageLocation(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  const doc = node.documentation;
  const text = typeof doc === 'string' ? doc : doc?.text;
  if (typeof text === 'string' && text.includes('@custom:storage-location')) return true;
  if (Array.isArray(node.nodes)) {
    for (const child of node.nodes) {
      if (astHasStorageLocation(child)) return true;
    }
  }
  return false;
}

// Decides what happens when the namespaced recompile cannot produce usable
// output: throw when the opt-in hard-error flag is set, otherwise warn once and
// fall back to AST-only checks. Shared by the compute path and tests.
export function reportNamespacedCompileFailure(
  hre: HardhatRuntimeEnvironment,
  buildInfoId: string,
  errorLines: string[],
): null {
  const rule = ((hre.config as any)?.tronUpgrades?.namespacedCompileErrors ?? 'error') as
    | 'error'
    | 'warn'
    | 'ignore';
  switch (rule) {
    case 'error':
      throw new Error(
        'Failed to compile the modified contracts for namespaced storage-layout validation ' +
          `(build-info ${buildInfoId}).` +
          (errorLines.length ? `\n${errorLines.join('\n')}` : '') +
          "\n\nIf you do not anticipate advanced namespace modifications during upgrades, set " +
          "tronUpgrades.namespacedCompileErrors: 'warn' or 'ignore' in your Hardhat config.",
      );
    case 'warn':
      warnNamespacedFallback(buildInfoId, [
        'Failed to compile the modified contracts for namespaced storage-layout validation; ' +
          'falling back to AST-only checks for namespaced storage.',
        ...errorLines,
      ]);
      return null;
    case 'ignore':
      return null;
  }
}

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

// Computes the recompile's outcome as a cache entry. Total: never throws on a
// failed compile and applies no severity policy — that decision is made by the
// caller of `getNamespacedOutput`, using whatever config it holds at that time.
async function computeNamespacedEntry(
  hre: HardhatRuntimeEnvironment,
  buildInfo: any,
): Promise<NamespacedCacheEntry> {
  const { isNamespaceSupported, makeNamespacedInput, trySanitizeNatSpec } = core();
  const solcVersion: string = buildInfo.solcVersion;
  if (!isNamespaceSupported(solcVersion)) return { schema: CACHE_SCHEMA, kind: 'unsupported' };

  let namespacedInput = makeNamespacedInput(buildInfo.input, buildInfo.output, solcVersion);
  namespacedInput = await trySanitizeNatSpec(namespacedInput, solcVersion);

  const output = await compileNamespaced(hre, namespacedInput, solcVersion);
  const errors: any[] = (output?.errors ?? []).filter((e: any) => e.severity === 'error');
  if (errors.length > 0) {
    return {
      schema: CACHE_SCHEMA,
      kind: 'compile-failed',
      errorLines: errors.map((e: any) => e.formattedMessage ?? e.message),
    };
  }
  return { schema: CACHE_SCHEMA, kind: 'output', output };
}

// Resolves the cache entry for a build-info, reading the memory/disk cache
// before recomputing. A disk value that isn't a schema-2 entry (legacy, or
// corrupt) is treated as a miss and recomputed — self-healing the cache file
// in place.
async function resolveNamespacedEntry(
  hre: HardhatRuntimeEnvironment,
  buildInfo: any,
): Promise<NamespacedCacheEntry> {
  const id: string = buildInfo.id;
  const cached = memoryCache.get(id);
  if (cached) return cached;

  const cachePath = diskCachePath(hre, id);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (isCacheEntry(parsed)) {
      memoryCache.set(id, parsed);
      return parsed;
    }
  } catch {
    // Cache miss (or unreadable) — recompute below.
  }

  const entry = await computeNamespacedEntry(hre, buildInfo);
  memoryCache.set(id, entry);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(entry));
  } catch {
    // A missing on-disk cache only costs a recompile next process; ignore.
  }
  return entry;
}

// Namespaced solc output for a build-info, or `undefined` when none applies.
// The cache entry itself carries no policy: severity for a 'compile-failed'
// entry is decided here, from `hre`'s CURRENT `namespacedCompileErrors`
// setting, every time it's consumed — so a cache entry written under one
// setting is still handled correctly by a later run under another.
export async function getNamespacedOutput(
  hre: HardhatRuntimeEnvironment,
  buildInfo: any,
): Promise<SolcOutput | undefined> {
  const entry = await resolveNamespacedEntry(hre, buildInfo);
  switch (entry.kind) {
    case 'output':
      return entry.output;
    case 'unsupported':
      if (buildInfoHasNamespaces(buildInfo)) warnNamespacedFallback(buildInfo.id);
      return undefined;
    case 'compile-failed':
      reportNamespacedCompileFailure(hre, buildInfo.id, entry.errorLines);
      return undefined;
  }
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
