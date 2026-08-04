import { describe, expect, it } from 'vitest';

import { deriveValidationInput } from '../src/validation-input';
import {
  declaresNamespacedStorage,
  hasPositionShortfall,
  positionShortfall,
} from '../src/validation-input/layout-fidelity';

import {
  buildRecord,
  buildInfoReader,
  ladderCorpus,
  consumerLayout,
  countingLoader,
  degradedCodes,
  expectInput,
  ladderDeps,
  standalone,
  standaloneProject,
} from './helpers/sf-2-ladder';

/*
 * SF-2b — namespaced storage in v1: recognised without a second compile,
 * compared member-wise without positions, and STATED on every path.
 *
 * The scope here is the reduced one, and the reduction is measured rather than
 * argued: a purely namespaced contract's members live in `layout.namespaces`
 * with `slot` and `offset` undefined in both validation modes, because
 * positions for them require a second compilation with a storage variable
 * injected per namespaced struct — which this version performs in neither
 * mode. The degradation is therefore the same kind and the same direction as
 * ordinary reduced-information validation: member-wise comparison still
 * refuses renames, retypes, reorders and deletions; what is lost is position
 * precision, and the divergence direction is over-rejection, never silent
 * acceptance.
 *
 * These tests make the three shipped instruments measurable: the recogniser
 * (`declaresNamespacedStorage`), the shortfall detector (`positionShortfall`),
 * and the pipeline statement (`namespaced-ast-only` on the operation's
 * channel). None of the three had a test that could go red before this file.
 *
 * Bound stated honestly, matching the scope ruling: the corpus carries no
 * namespaced UPGRADE PAIR, so refusal-in-both-modes for a namespaced reorder
 * is pinned by the persisted probe in the development evidence, not
 * re-executed here — what this file pins is recognition, position absence,
 * and the statement.
 */

const NAMESPACED = 'namespaced';
const INHERITED = 'inherited-namespace';
const FLAT = 'flat';

async function deriveStandalone(id: string) {
  const project = standaloneProject(id);
  const compiled = standalone(id);
  const loader = countingLoader();
  const outcome = await deriveValidationInput({
    contract: compiled.contract,
    env: project.env,
    deps: ladderDeps(project, {
      loader,
      // A fresh build record for the standalone, so the derivation takes the
      // zero-compile path — which is the mode the shortfall statement is about.
      readBuildInfo: buildInfoReader([
        buildRecord({
          from: compiled.astOnly,
          sourceKey: compiled.sourceKey,
          contractName: compiled.contract,
        }),
      ]),
    }),
  });
  return { project, loader, input: expectInput(outcome) };
}

describe('SF-2b: the namespace is recognised without any compile', () => {
  it('finds the annotated namespace in the fresh-path output', async () => {
    const { loader, input } = await deriveStandalone(NAMESPACED);
    expect(loader.compiles()).toBe(0);

    const compiled = standalone(NAMESPACED);
    const namespaces = declaresNamespacedStorage(
      input.solcOutput,
      compiled.sourceKey,
      compiled.contract,
    );
    expect(namespaces).toEqual(['erc7201:box.main']);
  });

  it('finds a namespace declared on a BASE contract, through linearization', async () => {
    // The inheritance walk is the half a naive own-nodes scan silently lacks:
    // the derived contract declares no struct of its own, so a recogniser that
    // did not follow `linearizedBaseContracts` would return [] here and the
    // statement would never fire for the commonest OZ layout.
    const { input } = await deriveStandalone(INHERITED);
    const compiled = standalone(INHERITED);
    const namespaces = declaresNamespacedStorage(
      input.solcOutput,
      compiled.sourceKey,
      compiled.contract,
    );
    expect(namespaces).toEqual(['erc7201:base.main']);
  });

  it('non-vacuity: a flat contract yields the empty census', async () => {
    const { input } = await deriveStandalone(FLAT);
    const compiled = standalone(FLAT);
    expect(
      declaresNamespacedStorage(
        input.solcOutput,
        compiled.sourceKey,
        compiled.contract,
      ),
    ).toEqual([]);
  });
});

describe('SF-2b: the position shortfall is real in the reduced mode and absent with a layout', () => {
  it('every namespace member is position-less on the reduced-information side', () => {
    const compiled = standalone(NAMESPACED);
    const layout = consumerLayout(
      compiled.astOnly.input,
      compiled.astOnly.output,
      ladderCorpus().solcLongVersion,
      compiled.fullyQualifiedName,
    );
    const shortfall = positionShortfall(layout);
    expect(hasPositionShortfall(shortfall)).toBe(true);
    // The flat list is empty — which is exactly why the engine's own
    // slot-absence notice, keyed on that list, never fires for this contract.
    expect(shortfall.storage).toEqual([]);
    expect(shortfall.namespaces.length).toBeGreaterThan(0);
    for (const entry of shortfall.namespaces) {
      expect(entry.startsWith('erc7201:box.main.')).toBe(true);
    }
  });

  it('the shortfall persists even when a storage layout WAS requested — measured, and the reason the note rides every path', () => {
    /*
     * Found by this test's own first run, which asserted the opposite. A
     * `storageLayout` request fills positions for FLAT storage only: a
     * namespaced struct is not a state variable, so its members stay
     * position-less unless the engine's injected-variable compilation runs —
     * which this plugin performs in no mode, escalation included. That is why
     * `stateNamespaceShortfall` is called on every arm rather than only the
     * fresh one, and why escalating a namespaced refusal cannot add the
     * missing precision.
     */
    const compiled = standalone(NAMESPACED);
    const layout = consumerLayout(
      compiled.slotLevel.input,
      compiled.slotLevel.output,
      ladderCorpus().solcLongVersion,
      compiled.fullyQualifiedName,
    );
    expect(hasPositionShortfall(positionShortfall(layout))).toBe(true);
  });

  it('non-vacuity of the mode distinction: FLAT storage does gain positions from the same request', () => {
    // The discriminating control, so the assertion above cannot pass because
    // the two corpus modes were secretly identical: the flat contract's
    // members are position-less in the reduced mode and positioned with the
    // layout requested.
    const compiled = standalone(FLAT);
    const reduced = consumerLayout(
      compiled.astOnly.input,
      compiled.astOnly.output,
      ladderCorpus().solcLongVersion,
      compiled.fullyQualifiedName,
    );
    expect(hasPositionShortfall(positionShortfall(reduced))).toBe(true);
    const positioned = consumerLayout(
      compiled.slotLevel.input,
      compiled.slotLevel.output,
      ladderCorpus().solcLongVersion,
      compiled.fullyQualifiedName,
    );
    expect(hasPositionShortfall(positionShortfall(positioned))).toBe(false);
  });
});

describe('SF-2b: the statement rides the channel on every path that finds a namespace', () => {
  it('records namespaced-ast-only for the namespaced contract, naming the namespace', async () => {
    const { project } = await deriveStandalone(NAMESPACED);
    expect(degradedCodes(project.channel)).toContain('namespaced-ast-only');

    const note = project.channel.degradedNotes.find(
      recorded => recorded.code === 'namespaced-ast-only',
    );
    expect(note?.summary).toContain('erc7201:box.main');
    expect(note?.summary).toContain('name and declaration order');
    // The remedy must not overclaim danger: member-wise comparison still
    // refuses structural changes, so "check it by hand" would send users to
    // re-verify what the engine already refuses. The direction it states is
    // refused-rather-than-silently-accepted.
    expect(note?.remedy).toContain('still refused');
    expect(note?.remedy).not.toContain('by hand');
  });

  it('records it for the inherited namespace too', async () => {
    const { project } = await deriveStandalone(INHERITED);
    expect(degradedCodes(project.channel)).toContain('namespaced-ast-only');
  });

  it('non-vacuity: the flat contract records no namespaced note', async () => {
    const { project } = await deriveStandalone(FLAT);
    expect(degradedCodes(project.channel)).not.toContain('namespaced-ast-only');
    // And the fresh-path note it DOES record proves the channel was live, so
    // the absence above is a measured negative rather than a dead channel.
    expect(degradedCodes(project.channel)).toContain(
      'storage-layout-unavailable',
    );
  });
});
