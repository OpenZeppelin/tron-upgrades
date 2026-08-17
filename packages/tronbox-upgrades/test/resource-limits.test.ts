import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildArtifactAmbiguityIndex,
  fileSystemBuildInfoReader,
  resolveEnvironment,
  slotNames,
  type BuildInfoReadResult,
  type BuildInfoReader,
} from '../src/environment';
import type { AbsolutePath } from '../src/environment/types';
import {
  handles,
  hostileTronWrapHandle,
  migrateShapedHandles,
  tronWrapHandle,
} from './helpers/handles';
import { makeTempDir } from './helpers/locate';
import { projectPathsFixture } from './helpers/paths-fixtures';
import {
  absentReader,
  absolute,
  collidingReader,
  countingReader,
  filesReader,
  singleContractReader,
  throwingReader,
  DEFAULT_BUILD_INFO_DIR,
} from './helpers/readers';
import {
  emittedIdentifierNames,
  environmentSources,
  interfaceMembers,
  valueIdentifierNames,
} from './helpers/source-scan';

/**
 * Resource Limits & Rate — bounded index I/O, fully synchronous resolution,
 * and no unbounded growth, retry, or timer.
 *
 * The quota/boundary technique, in the shape a synchronous projection admits.
 * The environment seam has no rate limit to probe because it serves no callers
 * over a network; its resource bounds are I/O count, scheduling primitives,
 * and retained memory. So the tests count calls with an instrumented reader,
 * drive the *default* reader
 * against a deliberately awkward real directory, and scan the source for the
 * scheduling primitives that would make an unbounded cost representable.
 *
 * The realistic workload these bound is a long `tronbox migrate` run over dozens
 * of migrations, each resolving once, on a developer's machine and in CI — with
 * megabyte-scale build-info files most runs never consult.
 */

function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, and it returned normally');
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
      ? typeof (value as { then?: unknown }).then === 'function'
      : false
  );
}

// ---------------------------------------------------------------------------
// Bounded, non-recursive index I/O
// ---------------------------------------------------------------------------

describe('index I/O is bounded and non-recursive', () => {
  it('costs exactly one directory listing, whatever the file count', () => {
    for (const count of [0, 1, 3, 25]) {
      const specs = Array.from({ length: count }, (_unused, index) => ({
        name: `f${String(index).padStart(3, '0')}.output.json`,
        contracts: [
          {
            sourcePath: `contracts/C${index}.sol`,
            contractNames: [`C${index}`],
          },
        ],
      }));
      const reader = countingReader(filesReader(specs));
      buildArtifactAmbiguityIndex(projectPathsFixture(), reader);
      expect(reader.callCount, `${count} files`).toBe(1);
    }
  });

  it('reads the directory once per composite, however many surfaces are consulted', () => {
    // The memo is what bounds this. Ten `ambiguities()` calls and ten
    // `resolve()` calls over one composite must not become twenty listings.
    const reader = countingReader(collidingReader());
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: reader },
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(env.artifacts.ambiguities().status).toBe('indexed');
      expect(env.artifacts.resolve('Box').status).toBe('ambiguous');
    }
    expect(reader.callCount).toBe(1);
  });

  it('a corrupt paired compiler-input file does not abort the index', () => {
    // `<hash>.json` is the compiler *input* — typically the larger of the pair.
    // The reader now reads it (see the three `BuildInfoFile.inputFile`/`input`
    // states pinned below), but a failure there is not an index-level error:
    // only `<hash>.output.json` failures produce `indeterminate`. The input file
    // here holds invalid JSON, so a reader that treated its failure like an
    // output failure would abort the index into `indeterminate` naming it.
    const dir = makeTempDir('input-pair');
    fs.writeFileSync(path.join(dir, 'abc123.json'), 'not json at all');
    fs.writeFileSync(
      path.join(dir, 'abc123.output.json'),
      JSON.stringify({ contracts: { 'contracts/Box.sol': { Box: {} } } }),
    );

    const index = buildArtifactAmbiguityIndex(
      projectPathsFixture({ root: dir, buildInfoDirectory: dir }),
      fileSystemBuildInfoReader,
    );
    expect(index.report.status).toBe('indexed');
    if (index.report.status !== 'indexed') {
      throw new Error('unreachable');
    }
    expect(index.report.indexedFrom).toEqual([
      path.join(dir, 'abc123.output.json'),
    ]);
  });

  describe('the paired <hash>.json compiler input, on BuildInfoFile', () => {
    // Three states, pinned directly on the reader's own result rather than
    // through the ambiguity index — the index never surfaces `inputFile`/
    // `input` at all (`ArtifactCandidate` carries only `buildInfoFile`), so
    // these have to read `fileSystemBuildInfoReader.read(...)` themselves.

    it('parses the pair and sets inputFile when it is present alongside the output', () => {
      const dir = makeTempDir('input-pair-present');
      const inputPath = path.join(dir, 'abc.json');
      const outputPath = path.join(dir, 'abc.output.json');
      const inputPayload = { language: 'Solidity', sources: {} };
      fs.writeFileSync(inputPath, JSON.stringify(inputPayload));
      fs.writeFileSync(
        outputPath,
        JSON.stringify({ contracts: { 'contracts/Box.sol': { Box: {} } } }),
      );

      const result = fileSystemBuildInfoReader.read(absolute(dir));
      expect(result.status).toBe('files');
      if (result.status !== 'files') {
        throw new Error('unreachable');
      }
      expect(result.files).toHaveLength(1);
      expect(result.files[0].inputFile).toBe(inputPath);
      expect(result.files[0].input).toEqual(inputPayload);
    });

    it('leaves inputFile and input undefined when the pair is absent', () => {
      const dir = makeTempDir('input-pair-absent');
      fs.writeFileSync(
        path.join(dir, 'abc.output.json'),
        JSON.stringify({ contracts: { 'contracts/Box.sol': { Box: {} } } }),
      );

      const result = fileSystemBuildInfoReader.read(absolute(dir));
      expect(result.status).toBe('files');
      if (result.status !== 'files') {
        throw new Error('unreachable');
      }
      expect(result.files).toHaveLength(1);
      expect(result.files[0].inputFile).toBeUndefined();
      expect(result.files[0].input).toBeUndefined();
    });

    it('sets inputFile but leaves input undefined when the pair exists and does not parse', () => {
      const dir = makeTempDir('input-pair-corrupt');
      const inputPath = path.join(dir, 'abc.json');
      fs.writeFileSync(inputPath, 'not json at all');
      fs.writeFileSync(
        path.join(dir, 'abc.output.json'),
        JSON.stringify({ contracts: { 'contracts/Box.sol': { Box: {} } } }),
      );

      const result = fileSystemBuildInfoReader.read(absolute(dir));
      expect(result.status).toBe('files');
      if (result.status !== 'files') {
        throw new Error('unreachable');
      }
      expect(result.files).toHaveLength(1);
      // Present-but-corrupt is distinguished from absent by `inputFile` alone:
      // both leave `input` undefined, but only this state names the file.
      expect(result.files[0].inputFile).toBe(inputPath);
      expect(result.files[0].input).toBeUndefined();
    });
  });

  it('does not descend into a subdirectory of buildInfoDirectory', () => {
    // Nothing bounds what a user has under `build/`, and the seam would be reading
    // it on a check most migrations never consult. The nested file defines a
    // colliding `Box`, so a recursive reader would report a collision.
    const dir = makeTempDir('no-recursion');
    fs.writeFileSync(
      path.join(dir, 'aaa.output.json'),
      JSON.stringify({ contracts: { 'contracts/Box.sol': { Box: {} } } }),
    );
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(
      path.join(nested, 'bbb.output.json'),
      JSON.stringify({
        contracts: { 'contracts/vendor/Box.sol': { Box: {} } },
      }),
    );

    const index = buildArtifactAmbiguityIndex(
      projectPathsFixture({ root: dir, buildInfoDirectory: dir }),
      fileSystemBuildInfoReader,
    );
    expect(index.report.status).toBe('indexed');
    if (index.report.status !== 'indexed') {
      throw new Error('unreachable');
    }
    expect(index.report.collisions).toEqual([]);
    expect(index.report.indexedFrom).toEqual([path.join(dir, 'aaa.output.json')]);
    expect(index.candidates('Box')).toHaveLength(1);
  });

  it('treats a directory named like an output file as not a file', () => {
    const dir = makeTempDir('dir-named-output');
    fs.mkdirSync(path.join(dir, 'trap.output.json'));
    const report = buildArtifactAmbiguityIndex(
      projectPathsFixture({ root: dir, buildInfoDirectory: dir }),
      fileSystemBuildInfoReader,
    ).report;
    expect(report.status).toBe('indeterminate');
    if (report.status !== 'indeterminate') {
      throw new Error('unreachable');
    }
    expect(report.reason.kind).toBe('build-info-absent');
  });

  it('does not traverse a symlink out of buildInfoDirectory', () => {
    // `isFile()` on a `Dirent` from `readdirSync(…, { withFileTypes: true })` is
    // false for a symlink, so there is no traversal out of the directory. The
    // target defines a colliding `Box`, so a following reader would collide.
    const dir = makeTempDir('symlink');
    const outside = makeTempDir('symlink-target');
    const target = path.join(outside, 'vendor.output.json');
    fs.writeFileSync(
      target,
      JSON.stringify({ contracts: { 'contracts/vendor/Box.sol': { Box: {} } } }),
    );
    fs.writeFileSync(
      path.join(dir, 'aaa.output.json'),
      JSON.stringify({ contracts: { 'contracts/Box.sol': { Box: {} } } }),
    );
    fs.symlinkSync(target, path.join(dir, 'zzz.output.json'));

    const index = buildArtifactAmbiguityIndex(
      projectPathsFixture({ root: dir, buildInfoDirectory: dir }),
      fileSystemBuildInfoReader,
    );
    expect(index.report.status).toBe('indexed');
    if (index.report.status !== 'indexed') {
      throw new Error('unreachable');
    }
    expect(index.report.indexedFrom).toEqual([path.join(dir, 'aaa.output.json')]);
    expect(index.report.collisions).toEqual([]);
  });

  it('ignores files that are not .output.json', () => {
    const dir = makeTempDir('mixed-tree');
    fs.writeFileSync(path.join(dir, 'README.md'), '# not build info');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'nor this');
    fs.writeFileSync(path.join(dir, 'x.output.JSON'), 'wrong case, so skipped');
    fs.writeFileSync(
      path.join(dir, 'aaa.output.json'),
      JSON.stringify({ contracts: { 'contracts/Box.sol': { Box: {} } } }),
    );
    const index = buildArtifactAmbiguityIndex(
      projectPathsFixture({ root: dir, buildInfoDirectory: dir }),
      fileSystemBuildInfoReader,
    );
    expect(index.report.status).toBe('indexed');
    if (index.report.status !== 'indexed') {
      throw new Error('unreachable');
    }
    expect(index.report.indexedFrom).toEqual([path.join(dir, 'aaa.output.json')]);
  });

  it('exposes only a directory-scoped content read, so per-file cost stays bounded', () => {
    // The bound is in the interface's shape: a reader that could be asked for the
    // *content* of an arbitrary file would make per-file cost unbounded by
    // construction. Two members, and the second does not weaken this
    // — `exists` returns a `boolean`, so it costs one stat and can return no bytes
    // however it is called. What is bounded here is content, not questions.
    const ambiguitySource = environmentSources().find(
      source => source.relative === 'ambiguity.ts',
    );
    expect(ambiguitySource).toBeDefined();
    const declaration = /export interface BuildInfoReader \{([^}]*)\}/.exec(
      ambiguitySource?.text ?? '',
    );
    expect(declaration).not.toBeNull();
    const members = interfaceMembers(declaration?.[1] ?? '');
    expect(members).toEqual([
      'read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult;',
      'exists(file: AbsolutePath): boolean;',
    ]);
    const contentReturning = members.filter(member =>
      /BuildInfoReadResult|string|Buffer/.test(member),
    );
    expect(contentReturning).toEqual([
      'read(buildInfoDirectory: AbsolutePath): BuildInfoReadResult;',
    ]);
  });

  it('calls readdirSync, readFileSync and existsSync, and nothing else', () => {
    // The fs surface the default reader uses, enumerated. `readdir`/`readFile` for
    // the index and `existsSync` for the probe — no `stat`, no `realpath`, no
    // `opendir`, no recursive option.
    //
    // `existsSync` is the point rather than an addition tolerated: the disk-read
    // discipline requires the probe to be *stat-class*, and the obvious shortcut
    // (`readFileSync`-and-discard) is a declared violation. A default that
    // satisfied the signature by reading the file would show up here as no new
    // chain at all, so the assertion is that the stat-class call is present.
    const ambiguitySource = environmentSources().find(
      source => source.relative === 'ambiguity.ts',
    );
    const fsChains = (ambiguitySource?.accessChains ?? []).filter(chain =>
      chain.startsWith('fs.'),
    );
    expect([...new Set(fsChains)].sort()).toEqual([
      'fs.existsSync',
      'fs.readFileSync',
      'fs.readdirSync',
    ]);
    expect(ambiguitySource?.text).not.toContain('recursive: true');
  });

  it('answers the probe without reading the file, on a real oversized artifact', () => {
    // The behavioural half of "stat-class", which the scan alone cannot prove: a
    // `readFileSync`-and-discard probe satisfies the signature and the interface
    // count, and only shows up as cost. A 4 MiB file is answered by the real
    // reader, and the answer is a boolean — so the bytes are provably not the
    // mechanism, because a content read would have had to allocate them.
    const dir = makeTempDir('exists-probe');
    const big = path.join(dir, 'Huge.json');
    fs.writeFileSync(big, `{"padding":"${'x'.repeat(4 * 1024 * 1024)}"}`);
    const present = fileSystemBuildInfoReader.exists(absolute(big));
    expect(present).toBe(true);
    expect(typeof present).toBe('boolean');
    expect(
      fileSystemBuildInfoReader.exists(absolute(path.join(dir, 'Absent.json'))),
    ).toBe(false);
    // A directory named like an artifact answers `true`, not `false`. Recorded
    // rather than asserted-away: `statSync(...).isFile()` would report *missing*
    // for a path that plainly exists, which is a worse claim than the one this
    // makes. The malformed-artifact diagnosis, not the missing-artifact one, is
    // where such a path lands.
    fs.mkdirSync(path.join(dir, 'Directory.json'));
    expect(
      fileSystemBuildInfoReader.exists(
        absolute(path.join(dir, 'Directory.json')),
      ),
    ).toBe(true);
  });

  it('answers "not there" rather than throwing for an unreadable parent', () => {
    // The recorded cost of choosing `existsSync`: it cannot throw, so an `EACCES`
    // parent is diagnosed missing rather than escaping the seam untranslated.
    // Pinned as a deliberate trade, not discovered later as a bug.
    const nonsense = absolute(path.join(makeTempDir('exists-deep'), 'a', 'b', 'c.json'));
    expect(() => fileSystemBuildInfoReader.exists(nonsense)).not.toThrow();
    expect(fileSystemBuildInfoReader.exists(nonsense)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fully synchronous resolution
// ---------------------------------------------------------------------------

describe('resolution is fully synchronous — the environment seam introduces no promise', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses no async keyword and no await anywhere in the seam', () => {
    // Host-specific, and the reason the rule is absolute rather than stylistic.
    // TronBox's `DeferredChain.prototype.then(fn)` takes exactly one argument and
    // returns `this`, so the `onRejected` an `await` passes is **dropped** — a
    // failing queued step rejects `deployer.start()` while the awaiting caller in
    // the migration never settles, leaving a dangling unhandled rejection that is
    // process-fatal under TronBox's own declared `engines.node: ">=20"`. A seam
    // that introduced its own promise inside that queue adds a second way to
    // strand a rejection, in the one module every other module calls.
    for (const source of environmentSources()) {
      expect(source.hasAsyncModifier, `${source.relative} declares async`).toBe(
        false,
      );
      expect(source.hasAwaitExpression, `${source.relative} awaits`).toBe(false);
    }
  });

  it('names no promise or scheduling primitive anywhere in the seam', () => {
    const forbidden =
      /^(Promise|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|queueMicrotask|AbortController)$/;
    for (const source of environmentSources()) {
      expect(
        valueIdentifierNames(source).filter(name => forbidden.test(name)),
        `${source.relative}`,
      ).toEqual([]);
      expect(
        source.accessChains.filter(chain =>
          /^(process\.nextTick|Promise\.)/.test(chain),
        ),
        `${source.relative}`,
      ).toEqual([]);
    }
  });

  it('returns a composite that is not thenable, and whose seam-built slots are not either', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    expect(isThenable(env)).toBe(false);
    for (const slot of ['paths', 'network', 'artifacts', 'chain', 'output'] as const) {
      expect(isThenable(env[slot]), slot).toBe(false);
    }
    expect(isThenable(env.provenance)).toBe(false);
    expect(isThenable(env.artifacts.ambiguities())).toBe(false);
    expect(isThenable(env.artifacts.resolve('Box'))).toBe(false);
  });

  it('leaves the deployer thenable, since that is the host queue and the point of the slot', () => {
    // The one deliberate exception, stated rather than left to be noticed. The
    // whole deployer is exposed as such because the deploy seam needs the queue,
    // and the queue's interface *is* `then`. The composite around it must not be
    // thenable, or an `await resolveEnvironment(...)` upstream would silently
    // adopt it.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['scheduling'] });
    expect(isThenable(env.scheduling.deployer)).toBe(true);
    expect(isThenable(env.scheduling)).toBe(false);
    expect(isThenable(env)).toBe(false);
  });

  it('schedules no timer and no microtask during a full resolution', () => {
    const timers = (
      ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] as const
    ).map(name => ({
      name,
      spy: vi.spyOn(globalThis, name),
    }));
    const nextTick = vi.spyOn(process, 'nextTick');

    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: collidingReader() },
    );
    env.artifacts.resolve('Box');
    env.artifacts.ambiguities();
    caught(() => env.artifacts.resolvePackaged('nope'));

    for (const { name, spy } of timers) {
      expect(spy, `${name} was called`).not.toHaveBeenCalled();
    }
    expect(nextTick).not.toHaveBeenCalled();
  });

  it('types the reader synchronously, so an async reader does not compile', () => {
    // The type-level half. A `BuildInfoReader` whose `read` returns a promise
    // would let I/O latency back in through the one injection seam.
    const asyncReader = {
      read: async (
        buildInfoDirectory: AbsolutePath,
      ): Promise<BuildInfoReadResult> => {
        await Promise.resolve();
        return { status: 'absent', ...{ buildInfoDirectory: undefined } };
      },
      // Present and correctly typed on purpose. Omitting it would also fail the
      // assignment — for a missing member rather than for the async return — and
      // the `@ts-expect-error` cannot tell the two apart, so the test would keep
      // passing after the async rule was deleted.
      exists: (_file: AbsolutePath): boolean => false,
    };
    // @ts-expect-error BuildInfoReader.read must return synchronously.
    const rejected: BuildInfoReader = asyncReader;
    expect(typeof rejected.read).toBe('function');
    expect(typeof rejected.exists).toBe('function');
  });

  it('completes before any pending microtask runs', () => {
    // The behavioural corroboration of the scan: a microtask queued immediately
    // before the call must still be pending when the call returns. A seam that
    // awaited anything internally would have yielded, letting the flag flip.
    let flushed = false;
    void Promise.resolve().then(() => {
      flushed = true;
    });
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    expect(env.artifacts.resolve('Box').status).toBe('unique');
    expect(flushed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No unbounded growth, no retry, no timer
// ---------------------------------------------------------------------------

describe('no unbounded growth, no retry, no timer', () => {
  it('declares no module-scope collection and no module-scope mutable binding', () => {
    // A module-scope memo keyed per migration grows monotonically and holds every
    // migration's intercept and Config alive for the whole run — a leak that also
    // defeats migration-scoped freshness by keeping stale handles reachable.
    for (const source of environmentSources()) {
      expect(
        source.topLevelMutableBindings,
        `${source.relative} declares a top-level let/var`,
      ).toEqual([]);
      const collections = source.topLevelConsts.filter(entry =>
        /new (Map|Set|WeakMap|WeakSet|Array)\b/.test(entry.text),
      );
      expect(
        collections.map(entry => entry.name),
        `${source.relative} declares a module-scope collection`,
      ).toEqual([]);
    }
  });

  it('keeps every module-scope const a frozen value rather than a mutable store', () => {
    const mutableInitializers = new Set([
      'NewExpression',
      'ArrayLiteralExpression',
      'ObjectLiteralExpression',
    ]);
    for (const source of environmentSources()) {
      for (const entry of source.topLevelConsts) {
        if (entry.isDeclare || entry.initializerKind === undefined) {
          continue;
        }
        expect(
          mutableInitializers.has(entry.initializerKind),
          `${source.relative}: ${entry.name} is initialized with a bare ${entry.initializerKind}`,
        ).toBe(false);
      }
    }
  });

  it('allocates one composite per resolution and shares no slot between them', () => {
    // Fifty resolutions is the realistic order of magnitude for a long
    // `tronbox migrate` run. Nothing may be shared across them, because sharing is
    // how a stale Config survives into the next migration.
    const composites = Array.from({ length: 50 }, () =>
      resolveEnvironment(
        migrateShapedHandles().handles,
        { require: ['paths', 'network'] },
        { buildInfoReader: absentReader() },
      ),
    );
    const identities = new Set<unknown>(composites);
    expect(identities.size).toBe(50);
    const pathSlots = new Set(composites.map(env => env.paths));
    expect(pathSlots.size).toBe(50);
    for (const env of composites) {
      expect(Object.isFrozen(env)).toBe(true);
      expect(env.paths.root).toBe('/proj');
    }
  });

  it('builds one index per composite, never one shared across composites', () => {
    // The observable form of "no module-scope memo": N composites that each
    // consult the index cost exactly N listings. A shared memo would cost one, and
    // would hand migration 40 migration 1's build tree.
    const reader = countingReader(singleContractReader());
    for (let migration = 0; migration < 12; migration += 1) {
      const env = resolveEnvironment(
        migrateShapedHandles().handles,
        { require: ['artifacts'] },
        { buildInfoReader: reader },
      );
      expect(env.artifacts.ambiguities().status).toBe('indexed');
    }
    expect(reader.callCount).toBe(12);
  });

  it('retries nothing when the reader fails', () => {
    // There is nothing transient to retry: every failure is a determinate property
    // of the handles or of the build tree. A retry would multiply a megabyte-scale
    // read by the retry count for no possible gain.
    const reader = countingReader(
      throwingReader(new TypeError('reader exploded')),
    );
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: reader },
    );
    expect(env.artifacts.ambiguities().status).toBe('indeterminate');
    expect(reader.callCount).toBe(1);
    // And the failed index is memoized like any other, so a second consultation
    // does not re-attempt it either.
    expect(env.artifacts.ambiguities().status).toBe('indeterminate');
    expect(reader.callCount).toBe(1);
  });

  it('retries nothing when the intercept fails', () => {
    const shape = migrateShapedHandles({}, { mode: 'throw' });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    expect(caught(() => env.artifacts.resolve('Box'))).toBeInstanceOf(Error);
    expect(shape.intercept.calls).toEqual(['Box']);
    expect(caught(() => env.artifacts.resolve('Box'))).toBeInstanceOf(Error);
    expect(shape.intercept.calls).toEqual(['Box', 'Box']);
  });

  it('reports a path-free failure once under migrate, not once per lineage', () => {
    // A malformed handle produces one diagnosis per *distinct* problem, not one
    // per attempt. Under `tronbox migrate` both lineages are the identical object,
    // so an `invariant-violated` failure — which carries a detail and no property
    // path — is byte-identical from both, and `resolveGroup`'s deduplication is
    // what keeps two copies of one line out of the message. Two copies is noise
    // that makes a real second problem harder to spot.
    const shape = migrateShapedHandles({ networks: {} });
    const error = caught(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.split('has no entry in "networks"').length - 1).toBe(1);
  });

  it('keeps both lineages distinct path failures, so dedup loses no information', () => {
    // The other side of that deduplication. A failure carrying a property path is
    // *not* byte-identical across lineages — the prefixes differ — so both survive,
    // and the message names each lineage's own path. Collapsing them would hide
    // which lineage the seam could not read.
    const shape = migrateShapedHandles({ throwOn: ['contracts_directory'] });
    const error = caught(() =>
      resolveEnvironment(shape.handles, { require: ['paths'] }),
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      'property path "deployer.options.options.contracts_directory" threw when read',
    );
    expect(message).toContain(
      'property path "artifacts.resolver.options.contracts_directory" threw when read',
    );
    expect(message.split('contracts_directory').length - 1).toBe(2);

    // One lineage, one report — so the count above tracks reachable lineages
    // rather than being a fixed two.
    const singleShape = migrateShapedHandles({ throwOn: ['contracts_directory'] });
    const single = caught(() =>
      resolveEnvironment(handles({ deployer: singleShape.deployer }), {
        require: ['paths'],
      }),
    );
    expect((single as Error).message.split('contracts_directory').length - 1).toBe(
      1,
    );
  });

  it('holds exactly one report in the per-composite memo', () => {
    // The only cache, and its size is one report whose lifetime is the
    // composite's. Two calls return the identical object rather than two reports.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: collidingReader() },
    );
    const first = env.artifacts.ambiguities();
    const second = env.artifacts.ambiguities();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('grows nothing across repeated resolution of a failing shape', () => {
    // The failure path too: a resolution that throws must not accumulate anything
    // either, and there is no module-scope structure for it to accumulate into.
    const before = environmentSources().flatMap(
      source => source.topLevelMutableBindings,
    );
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(
        caught(() =>
          resolveEnvironment(handles({ tronWrap: tronWrapHandle() }), {
            require: ['paths'],
          }),
        ),
      ).toBeInstanceOf(Error);
    }
    expect(before).toEqual([]);
  });

  it('adds no cost for a slot list that needs no index', () => {
    // Cross-check with the no-I/O-on-the-common-path rule: the bound only
    // matters if the common path pays nothing. A resolution that never
    // consults `ambiguities()` performs zero listings even with every other
    // slot required.
    const reader = countingReader(collidingReader());
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      handles({
        deployer: shape.deployer,
        artifacts: shape.intercept,
        tronWrap: hostileTronWrapHandle(),
        waitForTransactionReceipt: (): void => {},
      }),
      { require: ['paths', 'network', 'chain', 'receipts', 'output'] },
      { buildInfoReader: reader },
    );
    expect(env.provenance.slots.artifacts).toBe('absent');
    expect(reader.callCount).toBe(0);
  });

  it('names the build-info directory in the absent reason without retaining it', () => {
    // The report is a value, not a handle onto the tree. Nothing in it can keep a
    // Config, an intercept or a directory descriptor alive.
    const report = buildArtifactAmbiguityIndex(
      projectPathsFixture(),
      absentReader(),
    ).report;
    expect(report.status).toBe('indeterminate');
    if (report.status !== 'indeterminate') {
      throw new Error('unreachable');
    }
    expect(report.reason).toEqual({
      kind: 'build-info-absent',
      buildInfoDirectory: DEFAULT_BUILD_INFO_DIR,
      artifactTreeIsExternal: false,
    });
    for (const value of Object.values(report.reason)) {
      expect(['string', 'boolean']).toContain(typeof value);
    }
  });

  it('names no unbounded-growth primitive anywhere in the seam', () => {
    const forbidden = /^(FinalizationRegistry|WeakRef)$/;
    for (const source of environmentSources()) {
      expect(
        emittedIdentifierNames(source).filter(name => forbidden.test(name)),
        `${source.relative}`,
      ).toEqual([]);
    }
  });
});
