import type { BuildInfoReader } from './ambiguity';
import { createArtifactAccess, interceptFromHandle } from './artifacts';
import {
  buildCompilerConfiguration,
  compareCompilerSettings,
  projectCompilerValues,
} from './compiler';
import {
  checkResolverPairing,
  compareConfigValues,
  compilerConfigLineageFields,
  configLineageProvenance,
  inspectConfigLineages,
  networkConfigLineageFields,
  pathConfigLineageFields,
  resolutionSharingGuard,
  type ConfigLineage,
  type ConfigLineages,
  type ConfigReadFailure,
} from './config-lineage';
import {
  EnvironmentAbsentError,
  EnvironmentIncompleteError,
  EnvironmentInconsistentError,
  unsatisfiedSlot,
} from './errors';
import {
  hostSharingGuard,
  InternalPathRecorder,
  isObjectLike,
  readProperty,
  sealSlot,
  supplied,
} from './handles';
import { buildNetworkEnvironment, projectNetworkValues } from './network';
import { outputFromHandles } from './output';
import { buildProjectPaths, projectPathValues } from './paths';
import { slotNames, slotRequirements } from './slots';
import type {
  ConfigScalarField,
  EnvironmentProvenance,
  HandleName,
  Inconsistency,
  RawMigrationHandles,
  SlotName,
  SlotShapes,
  TronBoxEnvironment,
  UnsatisfiedSlot,
} from './types';

/** The one injected dependency, reachable from the public entry point. */
export interface EnvironmentDependencies {
  readonly buildInfoReader?: BuildInfoReader;
}

type MutableSlots = {
  -readonly [K in keyof SlotShapes]?: SlotShapes[K];
};

/**
 * A lineage-derived field group's outcome.
 *
 * `values` is present only when the group was constructible from every
 * reachable lineage *and* those lineages agreed on every field in the group.
 * There is no member that carries both a disagreement and a usable value, which
 * is how the no-preference-path rule survives refactoring.
 */
interface GroupOutcome<V> {
  readonly values?: V;
  readonly failures: readonly ConfigReadFailure[];
  readonly inconsistencies: readonly Inconsistency[];
}

function dedupe(slots: readonly SlotName[]): readonly SlotName[] {
  return Object.freeze([...new Set(slots)]);
}

/**
 * `absent` means no handle bearing on *any* requested slot was
 * supplied. Read from the slot table, so a table edit cannot leave this rule
 * describing a different matrix than the error messages do.
 */
function hasBearingHandle(
  handles: RawMigrationHandles,
  requested: readonly SlotName[],
): boolean {
  return requested.some(slot =>
    slotRequirements[slot].handles.some(handle => supplied(handles[handle])),
  );
}

/** One `handle-missing` per bearing handle the caller did not supply. */
function missingHandles(
  slot: SlotName,
  handles: RawMigrationHandles,
): readonly UnsatisfiedSlot[] {
  return slotRequirements[slot].handles
    .filter(handle => !supplied(handles[handle]))
    .map(handle => unsatisfiedSlot(slot, { kind: 'handle-missing', handle }));
}

function toUnsatisfied(
  slot: SlotName,
  failure: ConfigReadFailure,
): UnsatisfiedSlot {
  return failure.kind === 'handle-malformed'
    ? unsatisfiedSlot(slot, {
        kind: 'handle-malformed',
        handle: failure.handle,
        expectedPath: failure.expectedPath,
        because: failure.because,
      })
    : unsatisfiedSlot(slot, {
        kind: 'invariant-violated',
        detail: failure.detail,
      });
}

/**
 * Projects one field group from every reachable lineage, then cross-checks.
 *
 * The ordering follows a strict partition, enforced structurally rather than
 * by a rule at each throw site: every reachable lineage must *construct*
 * before any comparison runs, so `inconsistent` is unreachable while anything
 * is still unconstructible.
 *
 * When both lineages are reachable, both must construct. Using the one that
 * worked would be a silent preference of exactly the kind this seam forbids,
 * and it would also be a third reduced-verification mode, when only two are
 * allowed.
 */
function resolveGroup<
  F extends ConfigScalarField,
  V extends Readonly<Record<F, unknown>>,
>(
  lineages: ConfigLineages,
  fields: readonly F[],
  project: (lineage: ConfigLineage) => V | ConfigReadFailure,
): GroupOutcome<V> {
  const failures: ConfigReadFailure[] = [];
  const projections: Partial<Record<'deployer' | 'artifacts', V>> = {};

  for (const key of ['deployer', 'artifacts'] as const) {
    const attempt =
      key === 'deployer' ? lineages.viaDeployer : lineages.viaArtifacts;
    if (attempt.status === 'absent') {
      continue;
    }
    if (attempt.status === 'malformed') {
      failures.push(
        Object.freeze({
          kind: 'handle-malformed',
          handle: attempt.failure.handle,
          expectedPath: attempt.failure.expectedPath,
          because: attempt.failure.because,
        }),
      );
      continue;
    }

    const projected = project(attempt.lineage);
    if ('kind' in projected) {
      failures.push(projected);
    } else {
      projections[key] = projected;
    }
  }

  if (failures.length > 0) {
    // Under `tronbox migrate` both lineages are the identical object, so a
    // lineage-level problem is reported twice with byte-identical wording. Two
    // copies of one line is noise that makes a real second problem harder to
    // spot; distinct failures (a different handle or property path) survive.
    const seen = new Set<string>();
    const distinct = failures.filter(failure => {
      const key = JSON.stringify(failure);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return Object.freeze({
      failures: Object.freeze(distinct),
      inconsistencies: Object.freeze([]),
    });
  }

  const viaDeployer = projections.deployer;
  const viaArtifacts = projections.artifacts;

  if (viaDeployer !== undefined && viaArtifacts !== undefined) {
    const inconsistencies = compareConfigValues(
      fields,
      viaDeployer,
      viaArtifacts,
    );
    if (inconsistencies.length > 0) {
      return Object.freeze({
        failures: Object.freeze([]),
        inconsistencies,
      });
    }
    // The two records carry exactly the keys in `fields` — asserted at their
    // declaration sites — and the comparison above just found every one of them
    // equal. So this is the agreed value set, not a preferred lineage.
    return Object.freeze({
      values: viaDeployer,
      failures: Object.freeze([]),
      inconsistencies: Object.freeze([]),
    });
  }

  const single = viaDeployer ?? viaArtifacts;
  return Object.freeze({
    ...(single === undefined ? {} : { values: single }),
    failures: Object.freeze([]),
    inconsistencies: Object.freeze([]),
  });
}

/**
 * Resolve the TronBox environment for the current migration.
 *
 * Requested slots are non-optional in the return type; unrequested slots are
 * absent from it. There is no module-scope state: the function is a
 * pure projection of the handles it is given plus the injected reader, so
 * cross-migration staleness is not a rule to remember but a state that cannot
 * be represented. Fully synchronous — it creates no promise, registers
 * no callback, and starts no timer.
 *
 * @throws EnvironmentAbsentError       no handle bearing on any requested slot was supplied
 * @throws EnvironmentIncompleteError   a required capability cannot be constructed
 * @throws EnvironmentInconsistentError every required capability was constructed and the sources disagree
 */
export function resolveEnvironment<
  const R extends readonly SlotName[],
  const O extends readonly SlotName[] = readonly [],
>(
  handles: RawMigrationHandles | undefined,
  spec: {
    readonly require: R;
    readonly optional?: O;
  },
  deps: EnvironmentDependencies = {},
): TronBoxEnvironment<R[number], O[number]> {
  const rawHandles: RawMigrationHandles = handles ?? {};
  const required = dedupe(spec.require);
  const optional = dedupe(spec.optional ?? []).filter(
    slot => !required.includes(slot),
  );
  const requested = Object.freeze([...required, ...optional]);

  // The only diagnosis that says "outside a TronBox migration context".
  if (requested.length > 0 && !hasBearingHandle(rawHandles, requested)) {
    throw new EnvironmentAbsentError(requested);
  }

  const recorder = new InternalPathRecorder();
  // Both lineages are inspected unconditionally — four property reads — so that
  // `provenance.configLineages` describes what was reachable rather than what
  // this particular slot list happened to look at. Reporting a reachable
  // lineage as `absent` would be the alternative, and it would be false.
  const lineages = inspectConfigLineages(rawHandles, recorder);

  // The augmentation policy's guard, built once per resolution and passed to
  // every `sealSlot` call below. Required rather than optional so a new sealing
  // site cannot be added without naming what it knows.
  const sealing = resolutionSharingGuard(rawHandles, lineages);

  const slots: MutableSlots = {};
  const unsatisfied: UnsatisfiedSlot[] = [];
  const inconsistencies: Inconsistency[] = [];

  /**
   * Records a slot's construction failure only when the caller *required* it.
   * An optional slot that cannot be built is simply absent, and
   * `provenance.slots` states that — an undeclared slot must be unable to
   * affect the caller, so a slot nobody asked for must never fail a resolution.
   */
  function fail(slot: SlotName, entries: readonly UnsatisfiedSlot[]): void {
    if (required.includes(slot)) {
      unsatisfied.push(...entries);
    }
  }

  function failWith(
    slot: SlotName,
    failures: readonly ConfigReadFailure[],
  ): void {
    fail(
      slot,
      failures.map(failure => toUnsatisfied(slot, failure)),
    );
  }

  // ---- Lineage-derived groups ------------------------------------------------
  // Scoped to the slots this resolution exposes, which is what makes the
  // claim "cost is linear in the number of declared slots and the fixed
  // cross-check field list" true, and what keeps `internalPathsRead` free of fields nothing
  // needed. `artifacts` needs the paths group because the ambiguity index is
  // anchored on `buildInfoDirectory`.
  const pathsBackedSlots = (['paths', 'artifacts'] as const).filter(slot =>
    requested.includes(slot),
  );
  const pathsGroup =
    pathsBackedSlots.length > 0
      ? resolveGroup(lineages, pathConfigLineageFields, lineage =>
          projectPathValues(lineage, recorder),
        )
      : undefined;
  if (pathsGroup !== undefined) {
    inconsistencies.push(...pathsGroup.inconsistencies);
    for (const slot of pathsBackedSlots) {
      if (pathsGroup.failures.length > 0) {
        failWith(slot, pathsGroup.failures);
      } else if (
        pathsGroup.values === undefined &&
        pathsGroup.inconsistencies.length === 0
      ) {
        fail(slot, missingHandles(slot, rawHandles));
      }
    }
  }

  const networkGroup = requested.includes('network')
    ? resolveGroup(lineages, networkConfigLineageFields, lineage =>
        projectNetworkValues(lineage, recorder),
      )
    : undefined;
  if (networkGroup !== undefined) {
    inconsistencies.push(...networkGroup.inconsistencies);
    if (networkGroup.failures.length > 0) {
      failWith('network', networkGroup.failures);
    } else if (
      networkGroup.values === undefined &&
      networkGroup.inconsistencies.length === 0
    ) {
      fail('network', missingHandles('network', rawHandles));
    }
  }

  const compilerGroup = requested.includes('compiler')
    ? resolveGroup(lineages, compilerConfigLineageFields, lineage =>
        projectCompilerValues(lineage, recorder),
      )
    : undefined;
  if (compilerGroup !== undefined) {
    inconsistencies.push(...compilerGroup.inconsistencies);
    if (compilerGroup.failures.length > 0) {
      failWith('compiler', compilerGroup.failures);
    } else if (
      compilerGroup.values === undefined &&
      compilerGroup.inconsistencies.length === 0
    ) {
      fail('compiler', missingHandles('compiler', rawHandles));
    }
  }

  if (requested.includes('paths') && pathsGroup?.values !== undefined) {
    slots.paths = buildProjectPaths(pathsGroup.values);
  }
  if (requested.includes('network') && networkGroup?.values !== undefined) {
    slots.network = buildNetworkEnvironment(networkGroup.values);
  }

  // The settings object is cross-checked outside the field group, because a
  // compared field is rendered verbatim on disagreement and only scalars are
  // allowed there. Sequenced after the group so the agreed `settingsSource`
  // decides which key to read — the two lineages are already known to agree on it.
  if (requested.includes('compiler') && compilerGroup?.values !== undefined) {
    const settings = compareCompilerSettings(
      lineages,
      compilerGroup.values['compiler.settingsSource'],
      recorder,
    );
    if (settings.status === 'resolved') {
      slots.compiler = buildCompilerConfiguration(
        compilerGroup.values,
        settings.settings,
      );
    } else if (settings.status === 'conflict') {
      inconsistencies.push(
        Object.freeze({ kind: 'compiler-settings-conflict' }),
      );
    } else {
      failWith('compiler', [settings.failure]);
    }
  }

  // ---- artifacts ------------------------------------------------------------
  if (requested.includes('artifacts')) {
    const attempt = interceptFromHandle(rawHandles.artifacts, recorder);
    if (!supplied(rawHandles.artifacts)) {
      fail('artifacts', missingHandles('artifacts', rawHandles));
    } else if (!attempt.ok) {
      failWith('artifacts', [attempt.failure]);
    } else if (pathsGroup?.values !== undefined) {
      slots.artifacts = createArtifactAccess(
        attempt.intercept,
        buildProjectPaths(pathsGroup.values),
        deps.buildInfoReader,
      );
    }
  }

  // ---- chain --------------------------------------------------------------
  // Both names accepted, normalized one-way to `tronWrap`, and a
  // genuine conflict is `inconsistent` rather than a preference. TronBox builds
  // the sandbox with `tronWeb: tronWrap`, so the misleading name is the host's.
  if (requested.includes('chain')) {
    const candidates = (['tronWrap', 'tronWeb'] as const).filter(name =>
      supplied(rawHandles[name]),
    );
    if (candidates.length === 0) {
      fail('chain', missingHandles('chain', rawHandles));
    } else {
      const chainFailures: UnsatisfiedSlot[] = [];
      const valid: unknown[] = [];
      for (const name of candidates) {
        const handle = rawHandles[name];
        if (!isObjectLike(handle)) {
          chainFailures.push(
            unsatisfiedSlot('chain', {
              kind: 'handle-malformed',
              handle: name,
              expectedPath: name,
              because: 'missing',
            }),
          );
          continue;
        }
        // `trx` is an own enumerable data property on the TronWebProxy TronBox
        // injects, verified on 4.9.0 and 4.8.0. Read through property access,
        // never a descriptor: the proxy's `get` trap returns a bound sub-module
        // proxy while the descriptor exposes the raw one.
        const trx = readProperty(handle, 'trx', `${name}.trx`, recorder);
        if (!trx.ok || !isObjectLike(trx.value)) {
          chainFailures.push(
            unsatisfiedSlot('chain', {
              kind: 'handle-malformed',
              handle: name,
              expectedPath: `${name}.trx`,
              because: trx.ok ? 'missing' : trx.reason,
            }),
          );
          continue;
        }
        valid.push(handle);
      }

      if (chainFailures.length > 0) {
        fail('chain', chainFailures);
      } else if (
        valid.length === 2 &&
        !Object.is(rawHandles.tronWrap, rawHandles.tronWeb)
      ) {
        inconsistencies.push(Object.freeze({ kind: 'chain-handle-conflict' }));
      } else {
        const handle = valid[0];
        if (handle !== undefined) {
          slots.chain = sealSlot<SlotShapes['chain']>(
            {
              tronWrap: handle as unknown as SlotShapes['chain']['tronWrap'],
            },
            ['tronWrap'],
            sealing,
          );
        }
      }
    }
  }

  // ---- receipts -----------------------------------------------------------
  if (requested.includes('receipts')) {
    const handle = rawHandles.waitForTransactionReceipt;
    if (typeof handle === 'function') {
      slots.receipts = sealSlot<SlotShapes['receipts']>(
        {
          waitForTransactionReceipt:
            handle as SlotShapes['receipts']['waitForTransactionReceipt'],
        },
        ['waitForTransactionReceipt'],
        sealing,
      );
    } else if (!supplied(handle)) {
      fail('receipts', missingHandles('receipts', rawHandles));
    } else {
      fail('receipts', [
        unsatisfiedSlot('receipts', {
          kind: 'handle-malformed',
          handle: 'waitForTransactionReceipt',
          expectedPath: 'waitForTransactionReceipt',
          because: 'missing',
        }),
      ]);
    }
  }

  // ---- scheduling ---------------------------------------------------------
  // The deliberate exception to the sealed-handle rule: the whole deployer,
  // because the deploy seam needs the queue. `then` lives on
  // `Deployer.prototype`, so it is probed with `in`.
  if (requested.includes('scheduling')) {
    const handle = rawHandles.deployer;
    if (!supplied(handle)) {
      fail('scheduling', missingHandles('scheduling', rawHandles));
    } else if (!isObjectLike(handle)) {
      fail('scheduling', [
        unsatisfiedSlot('scheduling', {
          kind: 'handle-malformed',
          handle: 'deployer',
          expectedPath: 'deployer',
          because: 'missing',
        }),
      ]);
    } else {
      const then = readProperty(handle, 'then', 'deployer.then', recorder);
      if (then.ok && typeof then.value === 'function') {
        slots.scheduling = sealSlot<SlotShapes['scheduling']>(
          {
            deployer:
              handle as unknown as SlotShapes['scheduling']['deployer'],
          },
          ['deployer'],
          sealing,
        );
      } else {
        fail('scheduling', [
          unsatisfiedSlot('scheduling', {
            kind: 'handle-malformed',
            handle: 'deployer',
            expectedPath: 'deployer.then',
            because: then.ok ? 'missing' : then.reason,
          }),
        ]);
      }
    }
  }

  // ---- output -------------------------------------------------------------
  if (requested.includes('output')) {
    const output = outputFromHandles(rawHandles, lineages, recorder);
    if (output.ok) {
      slots.output = output.value;
    } else if ('noBearingHandle' in output) {
      // An unsupplied handle gets the same `handle-missing` diagnosis every
      // other slot gives it, minted from the slot table here rather than guessed
      // as a malformed property path in `output.ts`.
      fail('output', missingHandles('output', rawHandles));
    } else {
      failWith('output', [output.failure]);
    }
  }

  // ---- cross-handle consistency -------------------------------------------
  // The resolver-pairing check, conditioned on both handles being present
  // rather than on a deployer existing — which is what keeps the deploy
  // seam's mocha-scope question open. When a
  // lineage cannot be reached the check cannot run; any required slot depending
  // on that lineage has already failed above, and if none does then nothing
  // lineage-derived is exposed for a mispairing to corrupt.
  if (supplied(rawHandles.deployer) && supplied(rawHandles.artifacts)) {
    const pairing = checkResolverPairing(lineages, recorder);
    if (pairing !== undefined) {
      if (pairing.kind === 'artifacts-not-wrapping-deployer-resolver') {
        inconsistencies.push(pairing);
      } else {
        for (const slot of [
          'artifacts',
          'paths',
          'network',
          'output',
          'compiler',
        ] as const) {
          if (requested.includes(slot)) {
            failWith(slot, [pairing]);
          }
        }
      }
    }
  }

  // `incomplete` strictly before `inconsistent`, so a disagreement can
  // never be reported while a required capability is still unconstructible.
  if (unsatisfied.length > 0) {
    throw new EnvironmentIncompleteError(unsatisfied);
  }
  if (inconsistencies.length > 0) {
    throw new EnvironmentInconsistentError(inconsistencies);
  }

  // Every required slot is an own property of the returned composite.
  // Nothing above should be able to reach here with a gap; this is the assertion
  // that makes "no required slot is `undefined` downstream" a checked fact
  // rather than a consequence of the branches being right.
  const missing = required.filter(
    slot => !Object.prototype.hasOwnProperty.call(slots, slot),
  );
  if (missing.length > 0) {
    throw new EnvironmentIncompleteError(
      missing.map(slot =>
        unsatisfiedSlot(slot, {
          kind: 'invariant-violated',
          detail:
            'the slot was neither constructed nor diagnosed, which is a bug ' +
            'in the environment seam rather than a problem with the handles.',
        }),
      ),
    );
  }

  const provenance: EnvironmentProvenance = Object.freeze({
    slots: Object.freeze(
      Object.fromEntries(
        slotNames.map(slot => [
          slot,
          Object.prototype.hasOwnProperty.call(slots, slot)
            ? 'present'
            : 'absent',
        ]),
      ) as Record<SlotName, 'present' | 'absent'>,
    ),
    configLineages: configLineageProvenance(lineages),
    internalPathsRead: recorder.snapshot(),
  });

  // Every slot holds copied-out scalars or a named host handle; nothing
  // aliases `network_config`, `config.networks`, or a `Config`. Freezing is the
  // cheap half — the substantive guarantee is that there is nothing shared to
  // mutate.
  return Object.freeze({
    ...slots,
    provenance,
  }) as TronBoxEnvironment<R[number], O[number]>;
}

/** Re-exported so callers can name the handle union without importing types.ts. */
export type { HandleName };
