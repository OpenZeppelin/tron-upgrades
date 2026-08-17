import { describe, expect, it } from 'vitest';

import type { ArtifactRecordReport } from '../src/environment';
import { deriveValidationInput } from '../src/validation-input';
import { causeKinds, type Cause } from '../src/validation-input/causes';
import type { ValidationInputOutcome } from '../src/validation-input/pipeline';

import {
  absentBuildInfoReader,
  artifactBytecodeFor,
  artifactDeployedBytecodeFor,
  buildInfoReader,
  buildRecord,
  corpusCompile,
  deployedBytecodeOf,
  expectRefusal,
  ladderDeps,
  ladderProject,
  mutateExecutablePrefix,
  pairSource,
  upgradePair,
  upgradePairsFixture,
} from './helpers/ladder-fixtures';

/**
 * One driver per member of {@link causeKinds}, driven through
 * `deriveValidationInput` itself rather than through the lower-level function
 * that decides each cause — a driver that called `rangeGate`, `resolveSourceGraph`
 * or `libraryNameBand` directly would prove that function works and nothing
 * about whether the pipeline still reaches it, still hands it to `diagnose` and
 * `policy`, and still returns a refusal a caller can act on.
 *
 * ── Completeness is structural, not a checklist ──────────────────────────────
 *
 * `drivers` is typed `Record<Cause['kind'], …>`, so an eighth cause added to the
 * union without a row here is a compile error, and the completeness test below
 * re-checks the same fact at the value level against `causeKinds` — the package's
 * own exhaustiveness list — rather than against a count copied into this file.
 * Both together are what keep this suite from silently going stale the way the
 * eleven-cause era's own coverage did.
 *
 * Every driver asserts three things: the refusal names the cause it was built to
 * reach (not some other member the fixture accidentally also satisfies), the
 * headline is non-empty, and the remedy contains the one phrase that is
 * *specific to this cause* — `diagnose.ts` states that no remedy is shared
 * between causes. The ordinary `build-record-stale` driver and
 * `build-record-absent` share the `tronbox compile --all` action but retain
 * cause-specific trailing clauses; the abstract/interface stale arm is pinned
 * separately because recompilation cannot create deployed bytecode for it.
 */

const fixture = upgradePairsFixture();
const SOURCE_KEY = fixture.sourceKey;
const CONTRACT = fixture.contract;
const PAIR_ID = 'append';
const SIDE = 'before' as const;

/**
 * A project whose artifact bytecode is a real corpus compile's own — the one
 * candidate the build-record drivers need in order to be **located** (as
 * opposed to `no-record-for-target`, which is `build-record-absent` under a
 * different name) and, for the library-name driver, to **verify** as fresh.
 */
function freshCandidateProject() {
  const pair = upgradePair(PAIR_ID);
  const compiled = corpusCompile(PAIR_ID, 'astOnly', SIDE);
  return ladderProject({
    sourceText: pairSource(pair, SIDE),
    record: {
      source: pairSource(pair, SIDE),
      bytecode: artifactBytecodeFor(compiled, SOURCE_KEY, CONTRACT),
      deployedBytecode: artifactDeployedBytecodeFor(compiled, SOURCE_KEY, CONTRACT),
    },
  });
}

/**
 * 1 — outside `SUPPORTED_SOLC`. Decided right after the artifact record is
 * inspected, but before `resolveSourceGraph` reads anything off disk — so
 * this driver needs no filesystem lever.
 */
async function driveCompilerUnsupported(): Promise<ValidationInputOutcome> {
  const project = ladderProject({ resolvedVersion: '0.7.6' });
  return deriveValidationInput({
    contract: project.contractName,
    env: project.env,
    deps: ladderDeps(project),
  });
}

/**
 * 2 — the target itself is missing on disk. `exists` is overridden wholesale
 * rather than through the project's own tree, because the tree always seeds an
 * entry for the target's own path — there is no lever on `LadderProjectSpec`
 * for "the target is absent", and there does not need to be one just for this.
 */
async function driveSourceUnreadable(): Promise<ValidationInputOutcome> {
  const project = ladderProject();
  return deriveValidationInput({
    contract: project.contractName,
    env: project.env,
    deps: { exists: () => false },
  });
}

/** 3 — the target imports a specifier nothing on disk answers to. */
async function driveImportUnresolvable(): Promise<ValidationInputOutcome> {
  const project = ladderProject({
    sourceText:
      'pragma solidity ^0.8.0;\nimport "./Missing.sol";\ncontract T {}',
  });
  return deriveValidationInput({
    contract: project.contractName,
    env: project.env,
    deps: ladderDeps(project),
  });
}

/** 4 — the artifact record is missing a field the seam itself reports absent. */
async function driveArtifactShapeUnsupported(): Promise<ValidationInputOutcome> {
  const incompleteReport: ArtifactRecordReport = {
    status: 'incomplete',
    missing: ['bytecode'],
    observedKeys: ['contract_name', 'sourcePath', 'source', 'compiler'],
    internalPathsRead: ['_json'],
  };
  const project = ladderProject({ recordReport: incompleteReport });
  return deriveValidationInput({
    contract: project.contractName,
    env: project.env,
    deps: ladderDeps(project),
  });
}

/** 5 — no build record exists for this pair at all. */
async function driveBuildRecordAbsent(): Promise<ValidationInputOutcome> {
  const project = ladderProject();
  return deriveValidationInput({
    contract: project.contractName,
    env: project.env,
    deps: ladderDeps(project, { readBuildInfo: absentBuildInfoReader() }),
  });
}

/**
 * 6 — one candidate located for this pair, and it fails content verification.
 * The mutated byte lands in the executable prefix (never the CBOR tail), the
 * same measured lever `ladder-paths.test.ts` uses for the same reason: a project
 * with `metadata.bytecodeHash: "none"` strips the tail, and a fixture that
 * mutated it would silently stop being an A/B under that setting.
 */
async function driveBuildRecordStale(): Promise<ValidationInputOutcome> {
  const project = freshCandidateProject();
  const compiled = corpusCompile(PAIR_ID, 'astOnly', SIDE);
  const staleRecord = buildRecord({
    from: compiled,
    sourceKey: SOURCE_KEY,
    contractName: CONTRACT,
    deployedObject: mutateExecutablePrefix(
      deployedBytecodeOf(compiled.output, SOURCE_KEY, CONTRACT).object,
    ),
  });
  return deriveValidationInput({
    contract: CONTRACT,
    env: project.env,
    deps: ladderDeps(project, { readBuildInfo: buildInfoReader([staleRecord]) }),
  });
}

/** The one library name in this suite past the 36-character band (`>=39`). */
const OVERLONG_LIBRARY_NAME = 'L'.repeat(40);

interface MutableCreationBytecode {
  readonly object: string;
  readonly linkReferences: Record<string, Record<string, unknown>>;
}
interface MutableRecordEntry {
  readonly evm: { bytecode: MutableCreationBytecode };
}
interface MutableRecordOutput {
  readonly contracts: Record<string, Record<string, MutableRecordEntry>>;
}

/**
 * 7 — a linked library's name is past the band, read off the verified record's
 * own creation bytecode.
 *
 * No corpus pair links a library, so there is no real compile to reach for —
 * unlike causes 5 and 6, which are properties of which *record* verifies. This
 * one is a property of what the verified record's `linkReferences` names, so a
 * record that verifies exactly as `freshCandidateProject`'s own artifact expects
 * is built first, and only its creation bytecode's `linkReferences` — never its
 * `deployedBytecode`, which is what freshness verifies against — is changed
 * afterward. `libraryNameBand` reads nothing else off the entry.
 *
 * **The rewrite REPLACES `entry.evm.bytecode` rather than mutating its
 * `linkReferences` field in place, and that is load-bearing, not stylistic.**
 * `buildRecord` (`ladder-fixtures.ts`) builds `evm.bytecode` as
 * `{ bytecode: entry.evm.bytecode }` — the corpus compile's own bytecode object,
 * copied by *reference*, not cloned — and that object lives inside
 * `ladderCorpus()`'s module-level cache, shared by every driver and every test
 * in this file that reads pair `append`/`astOnly`/`before` again. An in-place
 * `entry.evm.bytecode.linkReferences = {...}` would therefore reach through
 * this one record into the cached corpus itself and poison it for every
 * subsequent reader — masked only by this driver running last and by vitest's
 * per-file isolation, i.e. invisible until either changes. Spreading into a new
 * object leaves the cached original untouched; only this record's own (fresh,
 * `buildRecord`-constructed) entry object points at the replacement.
 */
async function driveLibraryNameUnsupported(): Promise<ValidationInputOutcome> {
  const project = freshCandidateProject();
  const record = buildRecord({
    from: corpusCompile(PAIR_ID, 'astOnly', SIDE),
    sourceKey: SOURCE_KEY,
    contractName: CONTRACT,
  });
  const output = record.output as MutableRecordOutput;
  const entry = output.contracts[SOURCE_KEY]?.[CONTRACT];
  if (entry === undefined) {
    throw new Error(`the fixture record carries no ${SOURCE_KEY}:${CONTRACT}`);
  }
  entry.evm.bytecode = {
    ...entry.evm.bytecode,
    linkReferences: {
      [SOURCE_KEY]: { [OVERLONG_LIBRARY_NAME]: [{ start: 0, length: 20 }] },
    },
  };
  return deriveValidationInput({
    contract: CONTRACT,
    env: project.env,
    deps: ladderDeps(project, { readBuildInfo: buildInfoReader([record]) }),
  });
}

/**
 * The pristine pair's `linkReferences`, read straight off `ladderCorpus()`'s
 * own cached object rather than off anything `buildRecord` produced — the
 * regression guard for the hazard `driveLibraryNameUnsupported`'s own comment
 * documents. Cast the same way that driver does, for the same reason: the
 * corpus's `output` is typed as upstream's `SolcOutput`, not as the narrowed
 * shape this file's fixtures actually build.
 */
function creationLinkReferences(): Record<string, Record<string, unknown>> {
  const output = corpusCompile(PAIR_ID, 'astOnly', SIDE)
    .output as unknown as MutableRecordOutput;
  const entry = output.contracts[SOURCE_KEY]?.[CONTRACT];
  if (entry === undefined) {
    throw new Error(`the corpus carries no ${SOURCE_KEY}:${CONTRACT}`);
  }
  return entry.evm.bytecode.linkReferences;
}

const drivers: Record<Cause['kind'], () => Promise<ValidationInputOutcome>> = {
  'compiler-unsupported': driveCompilerUnsupported,
  'source-unreadable': driveSourceUnreadable,
  'import-unresolvable': driveImportUnresolvable,
  'artifact-shape-unsupported': driveArtifactShapeUnsupported,
  'build-record-absent': driveBuildRecordAbsent,
  'build-record-stale': driveBuildRecordStale,
  'library-name-unsupported': driveLibraryNameUnsupported,
};

/**
 * The one phrase, per cause, that only *that* cause's remedy carries — proof
 * that "non-empty" was not the whole check. `build-record-absent` and
 * `build-record-stale` both remedy with `tronbox compile --all`; the phrases
 * chosen for them are the trailing clause that tells the two situations apart.
 */
const REMEDY_NAMES: Record<Cause['kind'], string> = {
  'compiler-unsupported': 'compilers.solc.version',
  'source-unreadable': 'Restore ',
  'import-unresolvable': 'Fix the reference',
  'artifact-shape-unsupported': 'Upgrade TronBox',
  'build-record-absent': 'even when TronBox considers the project up to date',
  'build-record-stale': 'same compile as the artifact',
  'library-name-unsupported': 'Rename ',
};

describe('every refusal cause, driven through deriveValidationInput itself', () => {
  it('every cause kind has a driver in this suite', () => {
    expect(Object.keys(drivers).sort()).toEqual([...causeKinds].sort());
  });

  it.each(causeKinds)(
    '%s refuses with itself named and a remedy specific to it',
    async kind => {
      const outcome = await drivers[kind]();
      const { cause, diagnosis } = expectRefusal(outcome);

      expect(cause.kind).toBe(kind);
      expect(diagnosis.headline.trim()).not.toBe('');
      expect(diagnosis.remedy).toContain(REMEDY_NAMES[kind]);
    },
  );

  it('does not poison the shared corpus cache when it rewrites link references', async () => {
    // Independent of whatever order the `it.each` rows above ran in: drive the
    // one cause that rewrites a bytecode field, itself, and require the
    // module-level corpus singleton every driver in this file reads to come
    // back byte-for-byte unchanged — not merely "still parses" or "still has
    // no library named `OVERLONG_LIBRARY_NAME`", which a shallow-cloned
    // sibling field could satisfy while the shared object was still replaced
    // underneath it.
    const before = creationLinkReferences();
    expect(before).toEqual({});

    await driveLibraryNameUnsupported();

    expect(creationLinkReferences()).toEqual({});
    expect(creationLinkReferences()).toBe(before);
  });
});
