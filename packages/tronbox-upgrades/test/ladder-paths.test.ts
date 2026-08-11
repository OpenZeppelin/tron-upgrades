import { hashBytecodeWithoutMetadata } from '@openzeppelin/upgrades-core';
import { describe, expect, it } from 'vitest';

import type { BuildInfoReadResult } from '../src/environment';
import { deriveValidationInput } from '../src/validation-input';
import type { ValidationInput } from '../src/validation-input';
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
  expectRefusal,
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
  type LadderProject,
} from './helpers/ladder-fixtures';

/**
 * The Foundry-model pipeline — two paths, zero compiles, and a discriminator
 * for each.
 *
 * ── WHY EVERY FIXTURE HERE CARRIES A SECOND ASSERTION ────────────────────────
 *
 * The primary observables are the outcome kind and the produced input's
 * content, and on their own they measure almost nothing, because each is also
 * produced by a pipeline that is broken in a specific way:
 *
 * | claim | also true of |
 * |---|---|
 * | fresh produces an input and reports compatible | a pipeline that validated nothing — an **empty reference layout classifies every variable in the new contract as a safe append**, measured |
 * | stale refuses | a pipeline that refuses every record in the world |
 * | absent refuses | a pipeline that never consults the record at all |
 *
 * So each fixture below pairs its claim with something the broken version
 * cannot produce: the fresh path must **refuse a reordering from the same
 * record shape that accepted an append**; the stale refusal must come with a
 * fresh acceptance of **the same project before one byte of the executable
 * prefix changed**; and the absent refusal must sit beside a fresh acceptance
 * **for a contract the same build-info state does hold**.
 *
 * The pairs are real upgrade shapes compiled by the real TVM compiler
 * (`test/fixtures/upgrade-pairs.json`, verified against a persisted
 * AST-only-vs-slot-level compile probe), and every layout below is the one
 * `upgrades-core` actually builds from the input this pipeline produced. No AST
 * is hand-written, because a hand-written AST proves the pipeline copies fields
 * rather than that the reconstruction works. The paired `<hash>.json` inputs
 * are the corpus compiles' own real solc inputs, because the fresh path's whole
 * claim is that the recorded input is handed on verbatim.
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
      // The artifact's two bytecodes come from the host-shaped compile, because
      // that is the selection TronBox uses — so a freshness match here is the
      // record-vs-artifact comparison working end to end rather than a fixture
      // agreeing with itself.
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
function layoutOfInput(input: ValidationInput) {
  // `input.solcVersion` is the LONG form and it is passed through unchanged, which
  // is a property worth exercising rather than sidestepping: `validate` feeds it to
  // the namespace-annotation version gate, so a consumer handed the long form would
  // throw on every namespaced contract if the gate could not read it.
  return consumerLayout(input.solcInput, input.solcOutput, input.solcVersion, FQ);
}

/** One derivation on the fresh path. */
async function deriveFresh(pairId: string, side: 'before' | 'after') {
  const project = pairProject(pairId, side);
  const outcome = await deriveValidationInput({
    contract: CONTRACT,
    env: project.env,
    deps: ladderDeps(project, {
      readBuildInfo: buildInfoReader([recordFor(pairId, side)]),
    }),
  });
  const input = expectInput(outcome);
  return { project, input };
}

/** ─── the fresh path, and the vacuity trap closed ─────────────────── */

describe('fresh: the record pair is consumed, and the same fixture still refuses', () => {
  it('produces an input from the build record, AST-only by construction', async () => {
    const { input } = await deriveFresh('append', 'before');

    expect(input.provenance.basis.kind).toBe('build-record-ast');
    expect(input.fidelity.kind).toBe('declaration-order-only');
  });

  it('records which file verified, how many candidates, and which pair fed the input', async () => {
    const { input } = await deriveFresh('append', 'before');
    const basis = input.provenance.basis;

    expect(basis.gate.kind).toBe('fresh');
    expect(basis.gate.file).toBe(`${BUILD_INFO_DIR}/aaaa.output.json`);
    expect(basis.gate.candidates).toBe(1);
    // The pair is the `.output`-stripped sibling of the record that verified —
    // the reader's own derivation, recorded so the audit trail names the file
    // the consumer's spans will be decoded against.
    expect(basis.inputFile).toBe(`${BUILD_INFO_DIR}/aaaa.json`);
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

  it("carries the record's own contracts and sources, and the pair's own input keys", async () => {
    const { input } = await deriveFresh('append', 'before');

    expect(Object.keys(input.solcOutput.contracts)).toEqual([SOURCE_KEY]);
    expect(Object.keys(input.solcOutput.contracts[SOURCE_KEY] ?? {})).toEqual([
      CONTRACT,
    ]);
    expect(Object.keys(input.solcOutput.sources)).toEqual([SOURCE_KEY]);
    // The input is the pair's, verbatim, so its key set is the pair's whole
    // key set — which must cover every key the projected output carries, or
    // the gate would have rejected the pair as unusable.
    expect(Object.keys(input.solcInput.sources)).toEqual([SOURCE_KEY]);
    expect(input.provenance.sourceKeys).toEqual([SOURCE_KEY]);
    expect(input.provenance.partition.closure).toEqual([SOURCE_KEY]);
  });

  it(
    'ACCEPTS an append and REFUSES a reordering from the same record shape — ' +
      'which a pipeline validating nothing cannot do',
    async () => {
      // THE DISCRIMINATOR. Both halves run the whole pipeline on the fresh
      // path and the two answers differ — so the reference layout demonstrably
      // carries information. The third assertion is what makes that a proof
      // rather than a hope: the *empty* layout accepts the reordering, so
      // "accepts" is exactly what a vacuous pipeline would have returned for
      // both rows.
      const appendBefore = await deriveFresh('append', 'before');
      const appendAfter = await deriveFresh('append', 'after');
      const reorderBefore = await deriveFresh('reorder', 'before');
      const reorderAfter = await deriveFresh('reorder', 'after');

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

  it('reports every one of the ten measured pairs the way AST-only measured it', async () => {
    // The ten-pair measurement — zero false negatives, two false positives — was
    // the only measurement of this question, and it lived in a probe log. Here it
    // is the suite's own assertion, driven through the produced inputs.
    for (const pair of fixture.pairs) {
      const before = await deriveFresh(pair.id, 'before');
      const after = await deriveFresh(pair.id, 'after');

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
    // accepted one fails here as well as above. The two false positives are the
    // two shapes declaration order cannot decide — a `__gap` consumption and an
    // intra-slot repacking — and under the Foundry model they stay REFUSED:
    // there is no escalation compile to decide them with positions any more,
    // and a conservative refusal is the direction this plugin is allowed to err.
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

    const input = expectInput(
      await deriveValidationInput({
        contract: CONTRACT,
        env: project.env,
        deps: ladderDeps(project, {
          readBuildInfo: buildInfoReader([freshRecord, staleRecord]),
        }),
      }),
    );

    const basis = input.provenance.basis;
    expect(basis.gate.file).toBe(`${BUILD_INFO_DIR}/bbbb.output.json`);
    expect(basis.gate.candidates).toBe(2);
    expect(basis.inputFile).toBe(`${BUILD_INFO_DIR}/bbbb.json`);
  });
});

/** ─── the recorded input is what consumers receive, verbatim ──────── */

describe("fresh: the pair's content is the produced solcInput (the ex-M2 kill)", () => {
  it("hands on the paired file's content verbatim — both sentinels survive", async () => {
    // The ex-M2 wrong-span kill: two sentinels planted in the PAIR — one
    // settings key, one source-content marker absent from the disk tree —
    // both must survive into the produced input untouched, because the input
    // handed to consumers is the recorded compile's own input rather than a
    // reconstruction from the current contracts directory. Source text on
    // disk can drift from what was compiled while the bytecode still
    // verifies, and spans decode against the recorded text, not the drifted
    // one.
    const project = pairProject('append', 'before');
    const before = corpusCompile('append', 'astOnly', 'before');
    const recordedContent = `${pairSource(upgradePair('append'), 'before')}\n// recorded-not-disk`;
    const outcome = await deriveValidationInput({
      contract: CONTRACT,
      env: project.env,
      deps: ladderDeps(project, {
        readBuildInfo: buildInfoReader([
          buildRecord({
            from: before,
            sourceKey: SOURCE_KEY,
            contractName: CONTRACT,
            pairSettings: { __task8Sentinel: 'survives-verbatim' },
            pairSources: { [SOURCE_KEY]: { content: recordedContent } },
          }),
        ]),
      }),
    });
    const input = expectInput(outcome);
    expect(
      (input.solcInput.settings as Record<string, unknown>)['__task8Sentinel'],
    ).toBe('survives-verbatim');
    expect(input.solcInput.sources[SOURCE_KEY]?.content).toBe(recordedContent);
    // And the disk text is NOT what the consumer received, which is the whole
    // point: the fixture's project source deliberately lacks the marker.
    expect(project.record.source).not.toContain('recorded-not-disk');
  });

  it('rejects a record whose pair is MISSING, naming the reason per file', async () => {
    const project = pairProject('append', 'before');
    const { cause } = expectRefusal(
      await deriveValidationInput({
        contract: CONTRACT,
        env: project.env,
        deps: ladderDeps(project, {
          readBuildInfo: buildInfoReader([
            buildRecord({
              from: corpusCompile('append', 'astOnly', 'before'),
              sourceKey: SOURCE_KEY,
              contractName: CONTRACT,
              pair: 'absent',
            }),
          ]),
        }),
      }),
    );
    expect(cause.kind).toBe('build-record-stale');
    if (cause.kind !== 'build-record-stale') {
      throw new Error('narrowing');
    }
    expect(cause.rejected).toEqual([
      { file: `${BUILD_INFO_DIR}/aaaa.output.json`, reason: 'input-pair-absent' },
    ]);
  });

  it('rejects a pair that exists and does not parse, distinctly from absence', async () => {
    // The `inputFile`-set / `input`-undefined split is the reader's own
    // contract (`BuildInfoFile`), and the two reasons stay apart so the
    // diagnosis can say "could not parse" only where there is a file to parse.
    const project = pairProject('append', 'before');
    const { cause } = expectRefusal(
      await deriveValidationInput({
        contract: CONTRACT,
        env: project.env,
        deps: ladderDeps(project, {
          readBuildInfo: buildInfoReader([
            buildRecord({
              from: corpusCompile('append', 'astOnly', 'before'),
              sourceKey: SOURCE_KEY,
              contractName: CONTRACT,
              pair: 'unparseable',
            }),
          ]),
        }),
      }),
    );
    if (cause.kind !== 'build-record-stale') {
      throw new Error(`expected build-record-stale, got ${cause.kind}`);
    }
    expect(cause.rejected).toEqual([
      {
        file: `${BUILD_INFO_DIR}/aaaa.output.json`,
        reason: 'input-pair-unparseable',
      },
    ]);
  });

  it('rejects a pair that parses but is not the input of this output', async () => {
    // Two shapes of the same dishonesty: a pair that is not solc standard-JSON
    // input at all, and a pair that lacks a source the record's own output
    // covers. Either would make the consumer decode this output's spans
    // against the wrong text, so both are `input-pair-unusable`.
    const project = pairProject('append', 'before');
    const genuine = buildRecord({
      from: corpusCompile('append', 'astOnly', 'before'),
      sourceKey: SOURCE_KEY,
      contractName: CONTRACT,
    });

    for (const unusableInput of [
      { language: 'Vyper', sources: {}, settings: { outputSelection: {} } },
      {
        language: 'Solidity',
        // Parses, has the right shape, and lacks the closure's one source.
        sources: { 'Other.sol': { content: 'contract Other {}' } },
        settings: { outputSelection: {} },
      },
    ]) {
      const { cause } = expectRefusal(
        await deriveValidationInput({
          contract: CONTRACT,
          env: project.env,
          deps: ladderDeps(project, {
            readBuildInfo: buildInfoReader([
              { ...genuine, input: unusableInput },
            ]),
          }),
        }),
      );
      if (cause.kind !== 'build-record-stale') {
        throw new Error(`expected build-record-stale, got ${cause.kind}`);
      }
      expect(cause.rejected).toEqual([
        {
          file: `${BUILD_INFO_DIR}/aaaa.output.json`,
          reason: 'input-pair-unusable',
        },
      ]);
    }
  });
});

/** ─── stale: refusal, and the A/B on one byte ─────────────────────── */

describe('stale: a refusal that names its evidence, and 0-vs-1 byte decides it', () => {
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
    'accepts, then REFUSES the same project after one byte of the executable ' +
      'prefix changes — and nothing else about the fixture moves',
    async () => {
      // THE DISCRIMINATOR. One project, one build record, one mutation. A
      // pipeline that refuses every record fails the first row; one that never
      // verifies content passes the second row with an input.
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

      const freshOutcome = await deriveValidationInput({
        contract: compiled.contract,
        env: project.env,
        deps: ladderDeps(project, {
          readBuildInfo: buildInfoReader([
            buildRecord({
              from: compiled.astOnly,
              sourceKey: compiled.sourceKey,
              contractName: compiled.contract,
            }),
          ]),
        }),
      });
      expect(expectInput(freshOutcome).provenance.basis.kind).toBe(
        'build-record-ast',
      );

      const staleProject = standaloneProject(STALE_FIXTURE);
      const { cause, diagnosis } = expectRefusal(
        await deriveValidationInput({
          contract: compiled.contract,
          env: staleProject.env,
          deps: ladderDeps(staleProject, {
            readBuildInfo: buildInfoReader([
              buildRecord({
                from: compiled.astOnly,
                sourceKey: compiled.sourceKey,
                contractName: compiled.contract,
                deployedObject: mutated,
              }),
            ]),
          }),
        }),
      );

      expect(cause.kind).toBe('build-record-stale');
      if (cause.kind !== 'build-record-stale') {
        throw new Error('narrowing');
      }
      expect(cause.rejected).toEqual([
        {
          file: `${BUILD_INFO_DIR}/aaaa.output.json`,
          reason: 'deployed-bytecode-differs',
        },
      ]);
      expect(diagnosis.remedy).toContain('tronbox compile --all');
    },
  );

  it('still flips on a bodiless pair, where the region is nine bytes', async () => {
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
    expect(
      expectInput(
        await deriveValidationInput({
          contract: CONTRACT,
          env: freshProject.env,
          deps: ladderDeps(freshProject, {
            readBuildInfo: buildInfoReader([recordFor('append', 'before')]),
          }),
        }),
      ).provenance.basis.kind,
    ).toBe('build-record-ast');

    const staleProject = pairProject('append', 'before');
    const { cause } = expectRefusal(
      await deriveValidationInput({
        contract: CONTRACT,
        env: staleProject.env,
        deps: ladderDeps(staleProject, {
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
    expect(cause.kind).toBe('build-record-stale');
  });

  it('names every rejected candidate and why, rather than only that one failed', async () => {
    const project = pairProject('append', 'before');
    const before = corpusCompile('append', 'astOnly', 'before');
    const genuine = deployedBytecodeOf(before.output, SOURCE_KEY, CONTRACT).object;

    const { cause, diagnosis } = expectRefusal(
      await deriveValidationInput({
        contract: CONTRACT,
        env: project.env,
        deps: ladderDeps(project, {
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
            buildRecord({
              file: `${BUILD_INFO_DIR}/e.output.json`,
              from: before,
              sourceKey: SOURCE_KEY,
              contractName: CONTRACT,
              pair: 'absent',
            }),
          ]),
        }),
      }),
    );

    if (cause.kind !== 'build-record-stale') {
      throw new Error(`five unusable candidates read as ${cause.kind}`);
    }
    expect(cause.rejected).toEqual([
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
      { file: `${BUILD_INFO_DIR}/e.output.json`, reason: 'input-pair-absent' },
    ]);
    // The diagnosis renders every file with its reason, self-contained: the
    // rejection list is the whole evidence this refusal carries.
    for (const entry of cause.rejected) {
      expect(diagnosis.headline).toContain(entry.file);
    }
  });

  it('reports the empty-versus-empty pair as nothing-to-compare, never as verified', () => {
    // THE ONE VACUITY TRAP THE FRESHNESS CHECK ITSELF HAS. An abstract contract
    // has an artifact `deployedBytecode` of `'0x'` against a record `.object` of
    // `''`. `'0x' + '' === '0x'`, so a comparison written as equality reports
    // "verified" having compared nothing — and the fresh path would then hand the
    // consumer an AST-only input on the strength of a match between two absences.
    //
    // The unit is the subject here rather than the pipeline, because this is the
    // predicate's own contract. `verifyBuildRecordFreshness` answers
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
    // which would refuse every record in the world.
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

  it('an abstract target REFUSES on a match of two absences, naming the reason', async () => {
    // Under the compile-arm design this fixture compiled and relayed
    // upstream's abstract-contract message; under the Foundry model there is
    // nothing to compile, so the honest outcome is the refusal whose rejected
    // list says exactly what the record pair could not evidence — and whose
    // rendered reason says an abstract contract cannot be validated, because
    // `tronbox compile --all` genuinely cannot fix this one.
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

    const { cause, diagnosis } = expectRefusal(
      await deriveValidationInput({
        contract: abstracted.contract,
        env: project.env,
        deps: ladderDeps(project, {
          readBuildInfo: buildInfoReader([
            buildRecord({
              from: abstracted.astOnly,
              sourceKey: abstracted.sourceKey,
              contractName: abstracted.contract,
            }),
          ]),
        }),
      }),
    );

    if (cause.kind !== 'build-record-stale') {
      throw new Error(`an abstract target read as ${cause.kind}`);
    }
    expect(cause.rejected).toEqual([
      {
        file: `${BUILD_INFO_DIR}/aaaa.output.json`,
        reason: 'nothing-to-compare',
      },
    ]);
    expect(diagnosis.headline).toContain('abstract contract');
  });
});

/** ─── absent: refusal, three reasons told apart ───────────────────── */

describe('absent: a refusal that names which absence, and one state decides both ways', () => {
  async function refuseWithReader(reader: () => BuildInfoReadResult) {
    const project = pairProject('append', 'before');
    const outcome = await deriveValidationInput({
      contract: CONTRACT,
      env: project.env,
      deps: ladderDeps(project, { readBuildInfo: reader }),
    });
    return expectRefusal(outcome);
  }

  it('reads a missing directory as directory-absent and refuses', async () => {
    const { cause, diagnosis } = await refuseWithReader(absentBuildInfoReader());
    expect(cause.kind).toBe('build-record-absent');
    if (cause.kind !== 'build-record-absent') {
      throw new Error('narrowing');
    }
    expect(cause.because).toBe('directory-absent');
    expect(diagnosis.remedy).toContain('tronbox compile --all');
  });

  it('reads an unreadable directory as directory-unreadable', async () => {
    const { cause } = await refuseWithReader(unreadableBuildInfoReader());
    if (cause.kind !== 'build-record-absent') {
      throw new Error(`expected build-record-absent, got ${cause.kind}`);
    }
    expect(cause.because).toBe('directory-unreadable');
  });

  it('reads a THROWING reader as directory-unreadable rather than crashing', async () => {
    // The reader is the seam's and reports its own three statuses, but a reader
    // that raises is the same situation for this pipeline: no record can be
    // consulted. Distinguished from the status arm because they are different code
    // paths reaching the same conclusion.
    const { cause } = await refuseWithReader(throwingBuildInfoReader());
    if (cause.kind !== 'build-record-absent') {
      throw new Error(`expected build-record-absent, got ${cause.kind}`);
    }
    expect(cause.because).toBe('directory-unreadable');
  });

  it(
    'in ONE build-info state, proceeds for a contract the record holds and ' +
      'refuses no-record-for-target for one it does not',
    async () => {
      // THE DISCRIMINATOR. A pipeline that treats every record as absent
      // refuses both rows; one that never checks the pair proceeds on both.
      // The reader and the record are the same object for both derivations, so
      // the only variable is which contract was asked for.
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
      const heldInput = expectInput(
        await deriveValidationInput({
          contract: held,
          env: heldProject.env,
          deps: ladderDeps(heldProject, { readBuildInfo: reader }),
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
      const { cause } = expectRefusal(
        await deriveValidationInput({
          contract: notHeld,
          env: otherProject.env,
          deps: ladderDeps(otherProject, { readBuildInfo: reader }),
        }),
      );

      expect(heldInput.provenance.basis.kind).toBe('build-record-ast');

      if (cause.kind !== 'build-record-absent') {
        throw new Error(`a pair the record lacks read as ${cause.kind}`);
      }
      // Not `stale`: a record of some other compile is not a stale record of this
      // one, and the distinction is what stops "no record for you" from being
      // reported as "your build record is out of date".
      expect(cause.because).toBe('no-record-for-target');
    },
  );
});

/** ─── the four binding Task-8 pins ────────────────────────────────── */

describe('the Foundry model: absent/stale refuse, fresh consumes the pair', () => {
  it('(a) an absent build record REFUSES, naming `tronbox compile --all`', async () => {
    const project = pairProject('append', 'before');
    const outcome = await deriveValidationInput({
      contract: CONTRACT,
      env: project.env,
      deps: ladderDeps(project, { readBuildInfo: absentBuildInfoReader() }),
    });
    const { cause, diagnosis } = expectRefusal(outcome);
    expect(cause.kind).toBe('build-record-absent');
    if (cause.kind !== 'build-record-absent') {
      throw new Error('narrowing');
    }
    expect(cause.because).toBe('directory-absent');
    expect(diagnosis.remedy).toContain('tronbox compile --all');
    // Eric's rationale rides the remedy, so the user learns why the command
    // works even on a project TronBox considers up to date.
    expect(diagnosis.remedy).toContain(
      'forces recompilation of unchanged sources',
    );
  });

  it('(b) a stale record REFUSES, carrying the per-file rejection reasons', async () => {
    const project = pairProject('append', 'before');
    const before = corpusCompile('append', 'astOnly', 'before');
    const genuine = deployedBytecodeOf(before.output, SOURCE_KEY, CONTRACT).object;
    const outcome = await deriveValidationInput({
      contract: CONTRACT,
      env: project.env,
      deps: ladderDeps(project, {
        readBuildInfo: buildInfoReader([
          buildRecord({
            from: before,
            sourceKey: SOURCE_KEY,
            contractName: CONTRACT,
            deployedObject: mutateExecutablePrefix(genuine),
          }),
        ]),
      }),
    });
    const { cause, diagnosis } = expectRefusal(outcome);
    expect(cause.kind).toBe('build-record-stale');
    if (cause.kind !== 'build-record-stale') {
      throw new Error('narrowing');
    }
    expect(cause.rejected).toEqual([
      {
        file: `${BUILD_INFO_DIR}/aaaa.output.json`,
        reason: 'deployed-bytecode-differs',
      },
    ]);
    expect(diagnosis.remedy).toContain('tronbox compile --all');
  });

  it("(c) the fresh path's solcInput IS the paired file's content, verbatim", async () => {
    const project = pairProject('append', 'before');
    const before = corpusCompile('append', 'astOnly', 'before');
    const recordedContent = `${pairSource(upgradePair('append'), 'before')}\n// recorded-not-disk`;
    const outcome = await deriveValidationInput({
      contract: CONTRACT,
      env: project.env,
      deps: ladderDeps(project, {
        readBuildInfo: buildInfoReader([
          buildRecord({
            from: before,
            sourceKey: SOURCE_KEY,
            contractName: CONTRACT,
            pairSettings: { __task8Sentinel: 'survives-verbatim' },
            pairSources: { [SOURCE_KEY]: { content: recordedContent } },
          }),
        ]),
      }),
    });
    const input = expectInput(outcome);
    expect(
      (input.solcInput.settings as Record<string, unknown>)['__task8Sentinel'],
    ).toBe('survives-verbatim');
    expect(input.solcInput.sources[SOURCE_KEY]?.content).toBe(recordedContent);
  });

  it('(d) the degraded note states only what ran — no re-check promise', async () => {
    const { project } = await deriveFresh('append', 'before');
    const note = project.channel.degradedNotes.find(
      entry => entry.code === 'storage-layout-unavailable',
    );
    expect(note?.remedy).not.toContain(
      'the plugin compiles this one contract itself',
    );
    expect(note?.remedy).toBe(
      'Storage-layout positions were not available from the TronBox build ' +
        'record, so the comparison used declaration order. See the README ' +
        'section "Validation without storage layouts" for what that mode can ' +
        'and cannot decide.',
    );
  });
});
