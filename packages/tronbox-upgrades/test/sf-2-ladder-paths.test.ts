import { hashBytecodeWithoutMetadata } from '@openzeppelin/upgrades-core';
import { describe, expect, it } from 'vitest';

import type { BuildInfoReadResult } from '../src/environment';
import { deriveValidationInput } from '../src/validation-input';
import { ValidationInputInvariantError } from '../src/validation-input/errors';
import { verifyBuildRecordFreshness } from '../src/validation-input/identity';

import {
  BUILD_INFO_DIR,
  EMPTY_LAYOUT,
  EXECUTABLE_MUTATION_INDEX,
  artifactBytecodeFor,
  artifactDeployedBytecodeFor,
  buildInfoReader,
  buildRecord,
  absentBuildInfoReader,
  consumerLayout,
  corpusCompile,
  degradedCodes,
  deployedBytecodeOf,
  engineVerdict,
  expectInput,
  ladderDeps,
  ladderProject,
  metadataTailStart,
  mutateExecutablePrefix,
  mutateMetadataTail,
  pairSource,
  splitMetadataTail,
  standalone,
  standaloneProject,
  standaloneSource,
  standaloneSourceOf,
  throwingBuildInfoReader,
  unreadableBuildInfoReader,
  upgradePair,
  upgradePairsFixture,
  countingLoader,
  type CorpusCompile,
  type LadderProject,
} from './helpers/sf-2-ladder';

/**
 * SF-2's **lazy ladder** — the four paths, their compile counts, and a
 * discriminator for each.
 *
 * ── WHY EVERY FIXTURE HERE CARRIES A SECOND ASSERTION ────────────────────────
 *
 * A compile count is the ladder's primary observable and on its own it measures
 * almost nothing, because every count in the table is also produced by a pipeline
 * that is broken in a specific way:
 *
 * | claim | also true of |
 * |---|---|
 * | fresh compiles 0 and reports compatible | a pipeline that validated nothing — an **empty reference layout classifies every variable in the new contract as a safe append**, measured |
 * | stale compiles 1 | always-compile |
 * | absent compiles 1 | a pipeline that treats every record as absent |
 * | escalation compiles 1 on a non-empty report | "escalate on any failure", trivially — a `__gap` pair *is* a non-empty report |
 *
 * So each fixture below pairs its count with something the broken version cannot
 * produce: the fresh path must **refuse a reordering at the same zero compiles**;
 * the stale path must count **0 before and 1 after** a one-byte change to the same
 * project; the absent path must count **0 for a contract the record holds and 1 for
 * one it does not, in one build-info state**; and the escalation must **flip the
 * verdict**, not merely fire.
 *
 * The pairs are real upgrade shapes compiled by the real TVM compiler
 * (`test/fixtures/upgrade-pairs.json`, `evidence/probe-ast-only-vs-slot-level.js`
 * and `evidence/probe-p4-gate-observability.js`), and every layout below is the one
 * `upgrades-core` actually builds from the input this pipeline produced. No AST is
 * hand-written, because a hand-written AST proves the pipeline copies fields rather
 * than that the reconstruction works.
 */

const fixture = upgradePairsFixture();
const SOURCE_KEY = fixture.sourceKey;
const CONTRACT = fixture.contract;
const FQ = `${SOURCE_KEY}:${CONTRACT}`;

/** A project whose artifact is the one the host would have written for `side`. */
function pairProject(pairId: string, side: 'before' | 'after'): LadderProject {
  const pair = upgradePair(pairId);
  const hostCompile = corpusCompile(pairId, 'astOnly', side);
  return ladderProject({
    sourceText: pairSource(pair, side),
    record: {
      source: pairSource(pair, side),
      // The artifact's two bytecodes come from the **host-only** compile, because
      // that is the selection TronBox uses — so a compile-arm identity match here
      // is F-6 working end to end rather than a fixture agreeing with itself.
      bytecode: artifactBytecodeFor(hostCompile, SOURCE_KEY, CONTRACT),
      deployedBytecode: artifactDeployedBytecodeFor(
        hostCompile,
        SOURCE_KEY,
        CONTRACT,
      ),
    },
  });
}

function recordFor(pairId: string, side: 'before' | 'after', file?: string) {
  return buildRecord({
    ...(file === undefined ? {} : { file }),
    from: corpusCompile(pairId, 'astOnly', side),
    sourceKey: SOURCE_KEY,
    contractName: CONTRACT,
  });
}

/** The layout a consumer holds for the target, off a produced input. */
function layoutOfInput(input: {
  readonly solcInput: CorpusCompile['input'];
  readonly solcOutput: CorpusCompile['output'];
  readonly solcVersion: string;
}) {
  // `input.solcVersion` is the LONG form and it is passed through unchanged, which
  // is a property worth exercising rather than sidestepping: `validate` feeds it to
  // the namespace-annotation version gate, so a consumer handed the long form would
  // throw on every namespaced contract if the gate could not read it.
  return consumerLayout(input.solcInput, input.solcOutput, input.solcVersion, FQ);
}

/** One derivation on the fresh path, asserted to have loaded no compiler. */
async function deriveFresh(pairId: string, side: 'before' | 'after') {
  const project = pairProject(pairId, side);
  const loader = countingLoader();
  const outcome = await deriveValidationInput({
    contract: CONTRACT,
    env: project.env,
    deps: ladderDeps(project, {
      loader,
      readBuildInfo: buildInfoReader([recordFor(pairId, side)]),
    }),
  });
  const input = expectInput(outcome);
  return { project, loader, input };
}

/** ─── FX-1 · the fresh path, zero compiles, and the vacuity trap closed ──── */

describe('FX-1 fresh: zero compiles, and the same fixture still refuses', () => {
  it('produces an input with no compiler located, loaded or compiled', async () => {
    const { loader, input } = await deriveFresh('append', 'before');

    expect(loader.loads()).toBe(0);
    expect(loader.compiles()).toBe(0);
    expect(input.provenance.basis.kind).toBe('build-record-ast');
    expect(input.fidelity.kind).toBe('declaration-order-only');
  });

  it('records which file verified and how many candidates it read', async () => {
    const { input } = await deriveFresh('append', 'before');
    const basis = input.provenance.basis;
    if (basis.kind !== 'build-record-ast') {
      throw new Error(`expected a build-record basis, got ${basis.kind}`);
    }

    expect(basis.gate.kind).toBe('fresh');
    expect(basis.gate.file).toBe(`${BUILD_INFO_DIR}/aaaa.output.json`);
    expect(basis.gate.candidates).toBe(1);
    // The long version is the artifact's own, verified by the bytecode match
    // rather than by two version strings agreeing.
    expect(basis.compilerLongVersion).toBe(fixture.compiler.longVersion);
    expect(input.solcVersion).toBe(fixture.compiler.longVersion);
  });

  it('states the reduced fidelity rather than degrading silently', async () => {
    const { project, input } = await deriveFresh('append', 'before');

    expect(degradedCodes(project.channel)).toContain(
      'storage-layout-unavailable',
    );
    const note = project.channel.degradedNotes.find(
      entry => entry.code === 'storage-layout-unavailable',
    );
    expect(note?.summary).toContain(CONTRACT);
    expect(note?.remedy).not.toBe('');
    // `missingFor` is what makes the claim checkable: reduced fidelity for no
    // contract at all means the output carried none, which is the vacuous pass.
    if (input.fidelity.kind !== 'declaration-order-only') {
      throw new Error('the fresh path did not report reduced fidelity');
    }
    expect(input.fidelity.missingFor).toEqual([FQ]);
  });

  it('carries the record\'s own contracts, sources and input keys', async () => {
    const { input } = await deriveFresh('append', 'before');

    expect(Object.keys(input.solcOutput.contracts)).toEqual([SOURCE_KEY]);
    expect(Object.keys(input.solcOutput.contracts[SOURCE_KEY] ?? {})).toEqual([
      CONTRACT,
    ]);
    expect(Object.keys(input.solcOutput.sources)).toEqual([SOURCE_KEY]);
    // The consumer reads `solcInput.sources[source].content` for every source the
    // output carries, so the two key spaces have to be the same one.
    expect(Object.keys(input.solcInput.sources)).toEqual([SOURCE_KEY]);
    expect(input.provenance.sourceKeys).toEqual([SOURCE_KEY]);
    expect(input.provenance.reconstructedFrom).toBe('contracts-directory');
  });

  it(
    'ACCEPTS an append and REFUSES a reordering at the same zero compiles — ' +
      'which a pipeline validating nothing cannot do',
    async () => {
      // THE DISCRIMINATOR. Both halves run the whole ladder on the fresh path,
      // both load no compiler, and the two answers differ — so the reference
      // layout demonstrably carries information. The third assertion is what
      // makes that a proof rather than a hope: the *empty* layout accepts the
      // reordering, so "accepts" is exactly what a vacuous pipeline would have
      // returned for both rows.
      const appendBefore = await deriveFresh('append', 'before');
      const appendAfter = await deriveFresh('append', 'after');
      const reorderBefore = await deriveFresh('reorder', 'before');
      const reorderAfter = await deriveFresh('reorder', 'after');

      for (const derived of [
        appendBefore,
        appendAfter,
        reorderBefore,
        reorderAfter,
      ]) {
        expect(derived.loader.loads()).toBe(0);
      }

      const appended = engineVerdict(
        layoutOfInput(appendBefore.input),
        layoutOfInput(appendAfter.input),
      );
      const reordered = engineVerdict(
        layoutOfInput(reorderBefore.input),
        layoutOfInput(reorderAfter.input),
      );

      expect(appended).toEqual({ accepts: true, kinds: [] });
      expect(reordered.accepts).toBe(false);
      expect(reordered.kinds).toEqual(
        [...(upgradePair('reorder').astOnly.kinds ?? [])].sort(),
      );

      // The trap, closed explicitly: with an empty reference the reordering
      // passes, so a fresh path that produced nothing would have reported the
      // same "compatible" the append row reports.
      expect(
        engineVerdict(EMPTY_LAYOUT, layoutOfInput(reorderAfter.input)).accepts,
      ).toBe(true);
    },
  );

  it('reports every one of the nine measured pairs the way AST-only measured it', async () => {
    // The nine-pair measurement — zero false negatives, two false positives — was
    // the only measurement of this question, and it lived in a probe log. Here it
    // is the suite's own assertion, driven through the produced inputs.
    for (const pair of fixture.pairs) {
      const before = await deriveFresh(pair.id, 'before');
      const after = await deriveFresh(pair.id, 'after');
      expect(before.loader.loads()).toBe(0);
      expect(after.loader.loads()).toBe(0);

      const verdict = engineVerdict(
        layoutOfInput(before.input),
        layoutOfInput(after.input),
      );
      expect({ id: pair.id, accepts: verdict.accepts }).toEqual({
        id: pair.id,
        accepts: pair.astOnly.accepts,
      });
      if (pair.astOnly.kinds !== undefined) {
        expect({ id: pair.id, kinds: verdict.kinds }).toEqual({
          id: pair.id,
          kinds: [...pair.astOnly.kinds].sort(),
        });
      }
    }

    // And the score, so a fixture edit that quietly turned an unsafe row into an
    // accepted one fails here as well as above.
    const falseNegatives = fixture.pairs.filter(
      pair => !pair.safe && pair.astOnly.accepts,
    );
    const falsePositives = fixture.pairs.filter(
      pair => pair.safe && !pair.astOnly.accepts,
    );
    expect(falseNegatives).toEqual([]);
    expect(falsePositives.map(pair => pair.id)).toEqual([
      'gap-consumption',
      'intra-slot-padding',
    ]);
  });

  it('takes the first verifying candidate and counts the ones it read', async () => {
    // Two candidates from two moments, which is the routine state of a directory
    // nothing prunes. The stale one sorts first, so the count is evidence the
    // fresh one was not simply the only file there.
    const project = pairProject('append', 'before');
    const staleRecord = buildRecord({
      file: `${BUILD_INFO_DIR}/aaaa.output.json`,
      from: corpusCompile('append', 'astOnly', 'before'),
      sourceKey: SOURCE_KEY,
      contractName: CONTRACT,
      deployedObject: mutateExecutablePrefix(
        deployedBytecodeOf(
          corpusCompile('append', 'astOnly', 'before').output,
          SOURCE_KEY,
          CONTRACT,
        ).object,
      ),
    });
    const freshRecord = recordFor(
      'append',
      'before',
      `${BUILD_INFO_DIR}/bbbb.output.json`,
    );
    const loader = countingLoader();

    const input = expectInput(
      await deriveValidationInput({
        contract: CONTRACT,
        env: project.env,
        deps: ladderDeps(project, {
          loader,
          readBuildInfo: buildInfoReader([freshRecord, staleRecord]),
        }),
      }),
    );

    expect(loader.loads()).toBe(0);
    const basis = input.provenance.basis;
    if (basis.kind !== 'build-record-ast') {
      throw new Error('a two-candidate directory did not reach the fresh path');
    }
    expect(basis.gate.file).toBe(`${BUILD_INFO_DIR}/bbbb.output.json`);
    expect(basis.gate.candidates).toBe(2);
  });
});

/** ─── FX-2 · stale, one compile, and the A/B on one byte ─────────────────── */

describe('FX-2 stale: one compile, and 0 before / 1 after one changed byte', () => {
  /** The compile arm's answer: this plugin's own compile, with layouts. */
  function pluginCompileOutput(pairId: string, side: 'before' | 'after') {
    return corpusCompile(pairId, 'slotLevel', side).output;
  }

  /**
   * The A/B runs on `constants-and-immutables`, whose deployed bytecode is 944 hex
   * digits with an 838-digit executable region — a contract with real state, a
   * constructor and a function body, rather than one of the bodiless declaration
   * pairs whose executable region is nine bytes.
   *
   * The reason is the mutation, not the aesthetics: the byte the staleness lever
   * flips has to be *provably* inside the executable region, because that is the
   * only region that survives `metadata.bytecodeHash: "none"`. On a nine-byte
   * region that claim is true but thin; on 419 bytes it is the ordinary case.
   */
  const STALE_FIXTURE = 'constants-and-immutables';

  it(
    'takes its staleness lever from a MEASURED executable region, not from a ' +
      'character count — and a tail mutation is not a staleness signal',
    () => {
      const compiled = standalone(STALE_FIXTURE);
      const genuine = deployedBytecodeOf(
        compiled.astOnly.output,
        compiled.sourceKey,
        compiled.contract,
      ).object;
      const split = splitMetadataTail(genuine);

      // The split is computed off the blob's own CBOR length field, so both halves
      // are non-empty by measurement rather than by a threshold somebody guessed.
      expect(split.executable.length).toBe(838);
      expect(split.metadata.length).toBe(106);
      expect(split.executable + split.metadata).toBe(genuine);
      expect(EXECUTABLE_MUTATION_INDEX).toBeLessThan(
        metadataTailStart(genuine),
      );

      const prefixMutated = mutateExecutablePrefix(genuine);
      const tailMutated = mutateMetadataTail(genuine);
      expect(prefixMutated).not.toBe(genuine);
      expect(tailMutated).not.toBe(genuine);
      expect(prefixMutated.length).toBe(genuine.length);
      expect(tailMutated.length).toBe(genuine.length);

      // THE MEASUREMENT that justifies the region choice, rather than a comment
      // asserting it: the trimmed identity is INVARIANT under the tail mutation and
      // CHANGES under the prefix one. So a fixture that had mutated the tail would
      // have produced a record this gate reads as *fresh* — a staleness A/B that
      // silently stopped being an A/B, which is exactly the failure mode the
      // executable-prefix rule exists to rule out.
      //
      // `hashBytecodeWithoutMetadata` is the oracle because it is the consumer of
      // the boundary: it calls upstream's own `trimBytecodeMetadata`, which computes
      // the same `length - (declared + 2) * 2` this kit computes. Asserting through
      // it makes the split agree with upstream by measurement instead of by a
      // comment claiming the two arithmetics match.
      const of = (object: string) =>
        hashBytecodeWithoutMetadata(`0x${object}`);
      expect(of(tailMutated)).toBe(of(genuine));
      expect(of(prefixMutated)).not.toBe(of(genuine));

      // THE BOUNDARY PROBE, which is what pins the split to the exact digit rather
      // than to the right neighbourhood. The two rows above are also satisfied by a
      // boundary a few bytes too early — the flipped digit would still be trimmed.
      // This one flips the LAST digit of the computed executable region: if the true
      // boundary were even one digit later, that digit would fall inside the tail and
      // the trimmed identity would not move. It moves.
      const lastExecutable = metadataTailStart(genuine) - 1;
      const edgeMutated =
        genuine.slice(0, lastExecutable) +
        (genuine[lastExecutable] === 'a' ? 'b' : 'a') +
        genuine.slice(lastExecutable + 1);
      expect(edgeMutated).not.toBe(genuine);
      expect(of(edgeMutated)).not.toBe(of(genuine));

      // And the guard fires: asking for an executable mutation on a blob whose
      // executable region does not reach the index raises rather than mutating
      // metadata under an executable-sounding name. One byte of prefix, so the tail
      // begins at index 2 — `'0000'` would leave a two-byte region that *contains*
      // index 2 and the guard would correctly stay silent.
      const tailOnly = `00${split.metadata}`;
      expect(metadataTailStart(tailOnly)).toBe(EXECUTABLE_MUTATION_INDEX);
      expect(() => mutateExecutablePrefix(tailOnly)).toThrow(
        /inside the CBOR metadata tail/,
      );
    },
  );

  it(
    'counts 0 compiles, then 1 for the same project after one byte of the ' +
      'executable prefix changes — and nothing else about the fixture moves',
    async () => {
      // THE DISCRIMINATOR. One project, one build record, one mutation. A
      // pipeline that always compiles reports 1 on both rows; one that never
      // consults the record reports 0 on both.
      const compiled = standalone(STALE_FIXTURE);
      const project = standaloneProject(STALE_FIXTURE);
      const genuine = deployedBytecodeOf(
        compiled.astOnly.output,
        compiled.sourceKey,
        compiled.contract,
      ).object;
      const mutated = mutateExecutablePrefix(genuine);

      expect(mutated).not.toBe(genuine);
      expect(mutated.length).toBe(genuine.length);
      // The changed digit is in the dispatcher preamble, before the CBOR metadata
      // tail — measured by the row above, not asserted here.
      expect(mutated.slice(0, 2)).toBe(genuine.slice(0, 2));

      const freshRecord = () =>
        buildRecord({
          from: compiled.astOnly,
          sourceKey: compiled.sourceKey,
          contractName: compiled.contract,
        });

      const fresh = countingLoader({ output: compiled.slotLevel.output });
      const freshOutcome = await deriveValidationInput({
        contract: compiled.contract,
        env: project.env,
        deps: ladderDeps(project, {
          loader: fresh,
          readBuildInfo: buildInfoReader([freshRecord()]),
        }),
      });
      expect(expectInput(freshOutcome).provenance.basis.kind).toBe(
        'build-record-ast',
      );
      expect(fresh.loads()).toBe(0);
      expect(fresh.compiles()).toBe(0);

      const staleProject = standaloneProject(STALE_FIXTURE);
      const stale = countingLoader({ output: compiled.slotLevel.output });
      const staleOutcome = await deriveValidationInput({
        contract: compiled.contract,
        env: staleProject.env,
        deps: ladderDeps(staleProject, {
          loader: stale,
          readBuildInfo: buildInfoReader([
            buildRecord({
              from: compiled.astOnly,
              sourceKey: compiled.sourceKey,
              contractName: compiled.contract,
              deployedObject: mutated,
            }),
          ]),
        }),
      });

      expect(stale.loads()).toBe(1);
      expect(stale.compiles()).toBe(1);
      const staleInput = expectInput(staleOutcome);
      const basis = staleInput.provenance.basis;
      if (basis.kind !== 'plugin-compile') {
        throw new Error('a stale record did not reach the compile arm');
      }
      expect(basis.reason).toBe('build-record-stale');
      // Narrowed rather than asserted, because `rejected` lives only on the stale
      // arm of `BuildRecordGate` — the same idiom the absent-path rows use, and it
      // keeps the wrong gate a failure instead of an `any`.
      if (basis.gate.kind !== 'stale') {
        throw new Error(
          `a mutated executable prefix produced a ${basis.gate.kind} gate`,
        );
      }
      expect(basis.gate.rejected).toEqual([
        {
          file: `${BUILD_INFO_DIR}/aaaa.output.json`,
          reason: 'deployed-bytecode-differs',
        },
      ]);
      expect(staleInput.fidelity.kind).toBe('slot-level');
    },
  );

  it('still counts 0 then 1 on a bodiless pair, where the region is nine bytes', async () => {
    // The same A/B on `append`, whose executable region is 18 hex digits — the
    // short end of the corpus. Both rows here and both rows above, because a
    // staleness lever that only worked on large contracts would be a lever that
    // worked on the fixture rather than on the property.
    const genuine = deployedBytecodeOf(
      corpusCompile('append', 'astOnly', 'before').output,
      SOURCE_KEY,
      CONTRACT,
    ).object;
    expect(metadataTailStart(genuine)).toBe(18);

    const freshProject = pairProject('append', 'before');
    const fresh = countingLoader({
      output: pluginCompileOutput('append', 'before'),
    });
    expect(
      expectInput(
        await deriveValidationInput({
          contract: CONTRACT,
          env: freshProject.env,
          deps: ladderDeps(freshProject, {
            loader: fresh,
            readBuildInfo: buildInfoReader([recordFor('append', 'before')]),
          }),
        }),
      ).provenance.basis.kind,
    ).toBe('build-record-ast');
    expect(fresh.compiles()).toBe(0);

    const staleProject = pairProject('append', 'before');
    const stale = countingLoader({
      output: pluginCompileOutput('append', 'before'),
    });
    const staleInput = expectInput(
      await deriveValidationInput({
        contract: CONTRACT,
        env: staleProject.env,
        deps: ladderDeps(staleProject, {
          loader: stale,
          readBuildInfo: buildInfoReader([
            buildRecord({
              from: corpusCompile('append', 'astOnly', 'before'),
              sourceKey: SOURCE_KEY,
              contractName: CONTRACT,
              deployedObject: mutateExecutablePrefix(genuine),
            }),
          ]),
        }),
      }),
    );
    expect(stale.compiles()).toBe(1);
    expect(staleInput.provenance.basis.kind).toBe('plugin-compile');
  });

  it('names every rejected candidate and why, rather than only that one failed', async () => {
    const project = pairProject('append', 'before');
    const before = corpusCompile('append', 'astOnly', 'before');
    const genuine = deployedBytecodeOf(before.output, SOURCE_KEY, CONTRACT).object;
    const loader = countingLoader({
      output: corpusCompile('append', 'slotLevel', 'before').output,
    });

    const outcome = await deriveValidationInput({
      contract: CONTRACT,
      env: project.env,
      deps: ladderDeps(project, {
        loader,
        readBuildInfo: buildInfoReader([
          buildRecord({
            file: `${BUILD_INFO_DIR}/a.output.json`,
            from: before,
            sourceKey: SOURCE_KEY,
            contractName: CONTRACT,
            deployedObject: mutateExecutablePrefix(genuine),
          }),
          buildRecord({
            file: `${BUILD_INFO_DIR}/b.output.json`,
            from: before,
            sourceKey: SOURCE_KEY,
            contractName: CONTRACT,
            omitDeployedBytecode: true,
          }),
          buildRecord({
            file: `${BUILD_INFO_DIR}/c.output.json`,
            from: before,
            sourceKey: SOURCE_KEY,
            contractName: CONTRACT,
            omitAst: true,
          }),
          buildRecord({
            file: `${BUILD_INFO_DIR}/d.output.json`,
            from: before,
            sourceKey: SOURCE_KEY,
            contractName: CONTRACT,
            hideContractDefinition: true,
          }),
        ]),
      }),
    });

    expect(loader.compiles()).toBe(1);
    const basis = expectInput(outcome).provenance.basis;
    if (basis.kind !== 'plugin-compile' || basis.gate.kind !== 'stale') {
      throw new Error('four unusable candidates did not read as stale');
    }
    expect(basis.gate.rejected).toEqual([
      {
        file: `${BUILD_INFO_DIR}/a.output.json`,
        reason: 'deployed-bytecode-differs',
      },
      { file: `${BUILD_INFO_DIR}/b.output.json`, reason: 'nothing-to-compare' },
      {
        file: `${BUILD_INFO_DIR}/c.output.json`,
        reason: 'ast-closure-incomplete',
      },
      {
        file: `${BUILD_INFO_DIR}/d.output.json`,
        reason: 'target-definition-absent',
      },
    ]);
  });

  it('reports the empty-versus-empty pair as nothing-to-compare, never as verified', () => {
    // THE ONE VACUITY TRAP THE FRESHNESS CHECK ITSELF HAS. An abstract contract
    // has an artifact `deployedBytecode` of `'0x'` against a record `.object` of
    // `''`. `'0x' + '' === '0x'`, so a comparison written as equality reports
    // "verified" having compared nothing — and the fresh path would then hand the
    // consumer an AST-only input on the strength of a match between two absences.
    //
    // The unit is the subject here rather than the pipeline, because this is the
    // predicate's own contract and the end-to-end row below cannot read a gate off
    // an outcome that raises. `verifyBuildRecordFreshness` answers
    // `nothing-to-compare` — DELIBERATELY, so an empty-versus-empty match is not a
    // vacuous pass — and that is what is asserted, not a shape this test wished for.
    const empty = { object: '', linkReferences: {} };
    expect(
      verifyBuildRecordFreshness({
        buildRecordDeployed: empty,
        artifactDeployedBytecode: '0x',
      }),
    ).toEqual({ ok: false, reason: 'nothing-to-compare' });

    // Both one-sided arms too, since either absence alone is the same situation.
    expect(
      verifyBuildRecordFreshness({
        buildRecordDeployed: empty,
        artifactDeployedBytecode: '0x6080',
      }),
    ).toEqual({ ok: false, reason: 'nothing-to-compare' });
    expect(
      verifyBuildRecordFreshness({
        buildRecordDeployed: { object: '6080', linkReferences: {} },
        artifactDeployedBytecode: '0x',
      }),
    ).toEqual({ ok: false, reason: 'nothing-to-compare' });

    // THE NON-VACUITY CONTROL. Without these two rows the assertions above are
    // satisfied by a predicate that answers `nothing-to-compare` unconditionally,
    // which would refuse every record in the world and compile every time.
    const real = deployedBytecodeOf(
      standalone('flat').astOnly.output,
      'Box.sol',
      'Box',
    );
    expect(
      verifyBuildRecordFreshness({
        buildRecordDeployed: real,
        artifactDeployedBytecode: `0x${real.object}`,
      }),
    ).toEqual({ ok: true });
    expect(
      verifyBuildRecordFreshness({
        buildRecordDeployed: real,
        artifactDeployedBytecode: `0x${mutateExecutablePrefix(real.object)}`,
      }),
    ).toEqual({ ok: false, reason: 'deployed-bytecode-differs' });
  });

  it('an abstract target compiles rather than passing on a match of two absences', async () => {
    // The end-to-end half. The compile count is the whole discriminator: a
    // pipeline that read `'0x' === '0x' + ''` as verified would have taken the
    // fresh path at ZERO compiles and returned a `build-record-ast` input — a
    // vacuous "verified". This one rejects the record, compiles, and then relays
    // upgrades-core's own abstract-contract message unwrapped, which is INV-42's
    // single exemption and a real user condition rather than a plugin bug.
    const abstracted = standalone('abstract-target');
    const project = ladderProject({
      contractName: abstracted.contract,
      sourceFile: abstracted.sourceKey,
      sourceText: standaloneSource('abstract-target'),
      record: {
        bytecode: '0x',
        deployedBytecode: '0x',
        source: standaloneSource('abstract-target'),
      },
    });
    const loader = countingLoader({ output: abstracted.slotLevel.output });

    let raised: unknown;
    try {
      await deriveValidationInput({
        contract: abstracted.contract,
        env: project.env,
        deps: ladderDeps(project, {
          loader,
          readBuildInfo: buildInfoReader([
            buildRecord({
              from: abstracted.astOnly,
              sourceKey: abstracted.sourceKey,
              contractName: abstracted.contract,
            }),
          ]),
        }),
      });
    } catch (error) {
      raised = error;
    }

    // It compiled, which is the safe direction: the pair carried no evidence.
    expect(loader.compiles()).toBe(1);
    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toBe('Abstract contract not allowed here');
    // Named explicitly, because the alternative reading is that this is the
    // plugin's own invariant error — which would mean the exemption did not hold
    // and a user validating an abstract contract would be told to file a bug.
    expect(raised).not.toBeInstanceOf(ValidationInputInvariantError);
  });
});

/** ─── FX-3 · absent, one compile, three arms and one discriminator ───────── */

describe('FX-3 absent: one compile, and the three reasons told apart', () => {
  async function deriveWithReader(reader: () => BuildInfoReadResult) {
    const project = pairProject('append', 'before');
    const loader = countingLoader({
      output: corpusCompile('append', 'slotLevel', 'before').output,
    });
    const outcome = await deriveValidationInput({
      contract: CONTRACT,
      env: project.env,
      deps: ladderDeps(project, { loader, readBuildInfo: reader }),
    });
    return { loader, input: expectInput(outcome) };
  }

  it('reads a missing directory as directory-absent and compiles once', async () => {
    const { loader, input } = await deriveWithReader(absentBuildInfoReader());
    expect(loader.compiles()).toBe(1);
    const basis = input.provenance.basis;
    if (basis.kind !== 'plugin-compile' || basis.gate.kind !== 'absent') {
      throw new Error('an absent directory did not reach the absent gate');
    }
    expect(basis.gate.because).toBe('directory-absent');
    expect(basis.reason).toBe('build-record-absent');
  });

  it('reads an unreadable directory as directory-unreadable and compiles once', async () => {
    const { loader, input } = await deriveWithReader(unreadableBuildInfoReader());
    expect(loader.compiles()).toBe(1);
    const basis = input.provenance.basis;
    if (basis.kind !== 'plugin-compile' || basis.gate.kind !== 'absent') {
      throw new Error('an unreadable directory did not reach the absent gate');
    }
    expect(basis.gate.because).toBe('directory-unreadable');
  });

  it('reads a THROWING reader as directory-unreadable rather than crashing', async () => {
    // The reader is the seam's and reports its own three statuses, but a reader
    // that raises is the same situation for this pipeline: no record can be
    // consulted. Distinguished from the status arm because they are different code
    // paths reaching the same conclusion.
    const { loader, input } = await deriveWithReader(throwingBuildInfoReader());
    expect(loader.compiles()).toBe(1);
    const basis = input.provenance.basis;
    if (basis.kind !== 'plugin-compile' || basis.gate.kind !== 'absent') {
      throw new Error('a raising reader did not reach the absent gate');
    }
    expect(basis.gate.because).toBe('directory-unreadable');
  });

  it(
    'in ONE build-info state, compiles 0 for a contract the record holds and ' +
      '1 for one it does not',
    async () => {
      // THE DISCRIMINATOR. A pipeline that treats every record as absent gives 1
      // on both rows; one that never checks the pair gives 0 on both. The reader
      // and the record are the same object for both derivations, so the only
      // variable is which contract was asked for.
      //
      // The not-held contract comes from a DIFFERENT compile at the same source
      // key, and it has to: `buildRecord` reproduces the whole `contracts` map solc
      // emitted for the key — base contracts included, deliberately, because a real
      // `*.output.json` does and projecting the target alone crashes the consumer on
      // an inherited layout. So a sibling in the same file is *held*, measured:
      // `Base` is in this record beside `Derived`. Only a name the record's map has
      // no entry for reaches `no-record-for-target`.
      const inherited = standalone('inherited-flat');
      const source = standaloneSourceOf('inherited-flat');
      const held = inherited.contract; // Derived — in the record's `contracts`
      const absentee = standalone('constants-and-immutables');
      const notHeld = absentee.contract; // Holder — same key, not in this record
      expect(absentee.sourceKey).toBe(inherited.sourceKey);

      const record = buildRecord({
        from: inherited.astOnly,
        sourceKey: inherited.sourceKey,
        contractName: held,
      });
      const reader = buildInfoReader([record]);

      const heldProject = ladderProject({
        contractName: held,
        sourceFile: inherited.sourceKey,
        sourceText: source,
        record: {
          source,
          bytecode: artifactBytecodeFor(
            inherited.astOnly,
            inherited.sourceKey,
            held,
          ),
          deployedBytecode: artifactDeployedBytecodeFor(
            inherited.astOnly,
            inherited.sourceKey,
            held,
          ),
        },
      });
      const heldLoader = countingLoader({ output: inherited.slotLevel.output });
      const heldInput = expectInput(
        await deriveValidationInput({
          contract: held,
          env: heldProject.env,
          deps: ladderDeps(heldProject, {
            loader: heldLoader,
            readBuildInfo: reader,
          }),
        }),
      );

      const otherSource = standaloneSourceOf('constants-and-immutables');
      const otherProject = ladderProject({
        contractName: notHeld,
        sourceFile: absentee.sourceKey,
        sourceText: otherSource,
        record: {
          source: otherSource,
          bytecode: artifactBytecodeFor(
            absentee.astOnly,
            absentee.sourceKey,
            notHeld,
          ),
          deployedBytecode: artifactDeployedBytecodeFor(
            absentee.astOnly,
            absentee.sourceKey,
            notHeld,
          ),
        },
      });
      const otherLoader = countingLoader({ output: absentee.slotLevel.output });
      const otherInput = expectInput(
        await deriveValidationInput({
          contract: notHeld,
          env: otherProject.env,
          deps: ladderDeps(otherProject, {
            loader: otherLoader,
            readBuildInfo: reader,
          }),
        }),
      );

      expect(heldLoader.compiles()).toBe(0);
      expect(heldInput.provenance.basis.kind).toBe('build-record-ast');

      expect(otherLoader.compiles()).toBe(1);
      const basis = otherInput.provenance.basis;
      if (basis.kind !== 'plugin-compile' || basis.gate.kind !== 'absent') {
        throw new Error('a pair the record lacks did not read as absent');
      }
      // Not `stale`: a record of some other compile is not a stale record of this
      // one, and the distinction is what stops "no record for you" from being
      // reported as "your artifact is out of date".
      expect(basis.gate.because).toBe('no-record-for-target');
    },
  );
});

/** ─── FX-4 / FX-4b · escalation: one compile, and the verdict flips ──────── */

describe('FX-4 escalation: one compile, one fire, and a changed answer', () => {
  /**
   * Both sides of a pair, derived AST-only and then escalated.
   *
   * Both sides, because the comparison is what the escalation is for: upstream's
   * gap arithmetic reads positions from the *original* layout as well as the
   * updated one, so escalating only the contract this plugin holds would leave the
   * reference position-less and the answer unchanged. In production the reference
   * layout comes from the stored manifest rather than from this sub-feature —
   * recorded in the artifact's Test Notes, because it is the condition under which
   * the flip below transfers.
   */
  async function escalateBothSides(pairId: string) {
    const sides = await Promise.all(
      (['before', 'after'] as const).map(async side => {
        const astOnly = await deriveFresh(pairId, side);
        const project = pairProject(pairId, side);
        const loader = countingLoader({
          output: corpusCompile(pairId, 'slotLevel', side).output,
        });
        const escalated = expectInput(
          await deriveValidationInput({
            contract: CONTRACT,
            env: project.env,
            deps: ladderDeps(project, { loader }),
            escalateFrom: astOnly.input,
          }),
        );
        return { side, astOnly, escalated, loader };
      }),
    );
    const [before, after] = sides;
    if (before === undefined || after === undefined) {
      throw new Error('both sides are required');
    }
    return { before, after };
  }

  it('FX-4 `__gap`: refuses AST-only, ACCEPTS escalated, one compile per side', async () => {
    const { before, after } = await escalateBothSides('gap-consumption');

    // Before: the AST-only answer, at zero compiles.
    expect(before.astOnly.loader.loads()).toBe(0);
    expect(after.astOnly.loader.loads()).toBe(0);
    const astVerdict = engineVerdict(
      layoutOfInput(before.astOnly.input),
      layoutOfInput(after.astOnly.input),
    );
    expect(astVerdict.accepts).toBe(false);
    expect(astVerdict.kinds).toEqual(
      [...(upgradePair('gap-consumption').astOnly.kinds ?? [])].sort(),
    );

    // After: exactly one compile per escalation, and the verdict FLIPS.
    expect(before.loader.compiles()).toBe(1);
    expect(after.loader.compiles()).toBe(1);
    expect(before.escalated.fidelity.kind).toBe('slot-level');
    expect(after.escalated.fidelity.kind).toBe('slot-level');

    const escalatedVerdict = engineVerdict(
      layoutOfInput(before.escalated),
      layoutOfInput(after.escalated),
    );
    expect(escalatedVerdict).toEqual({ accepts: true, kinds: [] });

    // THE DISCRIMINATOR, stated as one comparison: the two answers differ. An
    // "escalate on any failure" pipeline that produced an equally position-less
    // input would fire and still refuse.
    expect(escalatedVerdict.accepts).not.toBe(astVerdict.accepts);
  });

  it('FX-4b intra-slot padding: same path, different trigger, same flip', async () => {
    const { before, after } = await escalateBothSides('intra-slot-padding');

    const astVerdict = engineVerdict(
      layoutOfInput(before.astOnly.input),
      layoutOfInput(after.astOnly.input),
    );
    expect(astVerdict.accepts).toBe(false);
    expect(astVerdict.kinds).toEqual(['insert']);

    expect(before.loader.compiles()).toBe(1);
    expect(after.loader.compiles()).toBe(1);
    expect(
      engineVerdict(
        layoutOfInput(before.escalated),
        layoutOfInput(after.escalated),
      ),
    ).toEqual({ accepts: true, kinds: [] });
  });

  it('records the fresh gate it escalated from, so the path reads off the input', async () => {
    const { after } = await escalateBothSides('gap-consumption');
    const basis = after.escalated.provenance.basis;
    if (basis.kind !== 'plugin-compile') {
      throw new Error('an escalation did not produce a compiled input');
    }
    expect(basis.reason).toBe('ast-only-escalation');
    // The gate is the `fresh` one it came from — the record of *escalated from a
    // verified record*, which is why no separate flag is needed.
    expect(basis.gate.kind).toBe('fresh');
    expect(basis.identity.withoutMetadataMatches).toBe(true);
  });

  it('FIRES ONCE: escalating an already escalated input raises', async () => {
    const { after } = await escalateBothSides('gap-consumption');
    const project = pairProject('gap-consumption', 'after');
    const loader = countingLoader({
      output: corpusCompile('gap-consumption', 'slotLevel', 'after').output,
    });

    // Structural rather than a counter: what escalation returns is a
    // `plugin-compile` input, and the gate admits only a `build-record-ast` one.
    await expect(
      deriveValidationInput({
        contract: CONTRACT,
        env: project.env,
        deps: ladderDeps(project, { loader }),
        escalateFrom: after.escalated,
      }),
    ).rejects.toThrow(ValidationInputInvariantError);

    expect(loader.compiles()).toBe(0);
  });

  it('does not loop: the second escalation raises before any compile', async () => {
    const { after } = await escalateBothSides('gap-consumption');
    const project = pairProject('gap-consumption', 'after');
    const loader = countingLoader({
      output: corpusCompile('gap-consumption', 'slotLevel', 'after').output,
    });

    let raised: unknown;
    try {
      await deriveValidationInput({
        contract: CONTRACT,
        env: project.env,
        deps: ladderDeps(project, { loader }),
        escalateFrom: after.escalated,
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ValidationInputInvariantError);
    expect((raised as Error).message).toContain('ast-only-escalation');
    // The compile count is the anti-loop assertion: a pipeline that escalated
    // again would have compiled again first.
    expect(loader.compiles()).toBe(0);
    expect(loader.loads()).toBe(0);
  });

  it('refuses to answer a question about a different contract', async () => {
    const astOnly = await deriveFresh('append', 'before');
    const other = standalone('inherited-flat');
    const source = standaloneSourceOf('inherited-flat');
    const project = ladderProject({
      contractName: other.contract,
      sourceFile: other.sourceKey,
      sourceText: source,
      record: {
        source,
        bytecode: artifactBytecodeFor(other.astOnly, other.sourceKey, other.contract),
        deployedBytecode: artifactDeployedBytecodeFor(
          other.astOnly,
          other.sourceKey,
          other.contract,
        ),
      },
    });
    const loader = countingLoader({ output: other.slotLevel.output });

    await expect(
      deriveValidationInput({
        contract: other.contract,
        env: project.env,
        deps: ladderDeps(project, { loader }),
        escalateFrom: astOnly.input,
      }),
    ).rejects.toThrow(/derived for/);
    expect(loader.compiles()).toBe(0);
  });
});
