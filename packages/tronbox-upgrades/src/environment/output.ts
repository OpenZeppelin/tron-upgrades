import {
  resolutionSharingGuard,
  type ConfigLineage,
  type ConfigLineages,
  type ConfigReadFailure,
} from './config-lineage';
import {
  isObjectLike,
  readOwnProperty,
  readProperty,
  sealSlot,
  type InternalPathRecorder,
} from './handles';
import type {
  OutputChannelSlot,
  RawMigrationHandles,
  TronBoxLogger,
} from './types';

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ConfigReadFailure };

/**
 * Defect D-1: an unreachable lineage and an unsupplied handle are different
 * facts, and only the first has a property path to name. `noBearingHandle`
 * therefore carries none — the caller owns the slot table and mints
 * `handle-missing` from it, exactly as it already does for every other slot.
 * Folding the unsupplied case into a malformed path, which is what this member
 * replaces, sent the user hunting for a broken object they were never asked to
 * supply.
 */
export type OutputSlotAttempt =
  | Read<OutputChannelSlot>
  | { readonly ok: false; readonly noBearingHandle: true };

function malformed<T>(
  handle: 'deployer' | 'artifacts',
  expectedPath: string,
  because: 'missing' | 'threw',
): Read<T> {
  return {
    ok: false,
    failure: Object.freeze({
      kind: 'handle-malformed',
      handle,
      expectedPath,
      because,
    }),
  };
}

/**
 * INV-35: the guaranteed surface is exactly `log`, so that is the only member
 * probed and the only member typed.
 *
 * `log` is the *intersection* of the shapes TronBox injects, which is why the
 * narrow type is the correct one rather than a cautious one. Verified at `v4.8.0`
 * and `v4.9.0`:
 *
 * - Single-method: `src/components/Deployer/index.js:Deployer` defaults to
 *   `options.logger || { log(){} }`;
 *   `src/components/Migrate/index.js:Migration.prototype.run` passes
 *   `{ log: msg => logger.log('  ' + msg) }`, so even the happy path's
 *   `deployer.logger` has only `log`;
 *   `src/lib/commands/migrate.js:command.run` substitutes `{ log(){} }` under
 *   `--quiet`/`--silent`; and `src/lib/test.js:Test.performInitialDeploy` passes
 *   `{ log(){} }`.
 * - Full `console`: the un-quieted CLI path. `src/index.js` sets
 *   `logger: console`, and a Config the CLI merged that onto therefore carries
 *   `warn`/`error` too — which is the ordinary shape of **both** lineages under a
 *   CLI invocation, mocha files included. `Config`'s own `{ log(){} }` default
 *   (`src/components/Config.js`, `_values.logger`) is reached only by a Config
 *   nobody merged a logger onto. See `outputFromHandles` below: an earlier
 *   revision of these comments had the lineage logger as that default.
 *
 * Typing the union's extra members would promise a surface four of the five
 * shapes do not have. `log` is probed with `in` rather than as an own property
 * because `console`'s methods and a closure-built wrapper's differ in ownership.
 */
function loggerFrom(
  owner: unknown,
  loggerPath: string,
  handle: 'deployer' | 'artifacts',
  recorder: InternalPathRecorder,
): Read<TronBoxLogger> {
  const logger = readOwnProperty(owner, 'logger', loggerPath, recorder);
  if (!logger.ok) {
    return malformed(handle, loggerPath, logger.reason);
  }
  if (!isObjectLike(logger.value)) {
    return malformed(handle, loggerPath, 'missing');
  }

  const logPath = `${loggerPath}.log`;
  const log = readProperty(logger.value, 'log', logPath, recorder);
  if (!log.ok) {
    return malformed(handle, logPath, log.reason);
  }
  if (typeof log.value !== 'function') {
    return malformed(handle, logPath, 'missing');
  }

  return { ok: true, value: logger.value as unknown as TronBoxLogger };
}

/**
 * `hostQuietRequested`, read exactly rather than heuristically.
 *
 * `build/lib/commands/migrate.js:command.run` replaces `options.logger` with a
 * noop when `options.quiet || options.silent`, then hands the same `options` to
 * `Config.detect`, and `Config.prototype.merge` assigns every key of that object
 * onto the Config — `quiet` is not a declared prop, so it lands as a plain own
 * property. It is absent from a Config nobody merged it onto (verified: `quiet`
 * appears in no `props` entry), and absence means `false`. The degradation
 * direction is safe: SF-10's primary mechanism is routing through the injected
 * logger, which `--quiet` has already replaced with a noop.
 */
function quietFrom(
  lineage: ConfigLineage,
  recorder: InternalPathRecorder,
): Read<boolean> {
  const quietPath = `${lineage.prefix}.quiet`;
  const quiet = readOwnProperty(lineage.config, 'quiet', quietPath, recorder);
  if (!quiet.ok) {
    return quiet.reason === 'missing'
      ? { ok: true, value: false }
      : malformed(lineage.handle, quietPath, 'threw');
  }
  if (quiet.value === undefined) {
    return { ok: true, value: false };
  }
  if (typeof quiet.value !== 'boolean') {
    return {
      ok: false,
      failure: Object.freeze({
        kind: 'invariant-violated',
        detail:
          'Config field "quiet" must be a boolean when present, and is of ' +
          `type ${typeof quiet.value}.`,
      }),
    };
  }
  return { ok: true, value: quiet.value };
}

/**
 * The design's rule: `deployer.logger`, else the Config lineage's `logger`.
 * `origin` reports which applied, so provenance is a statement rather than a
 * silent preference.
 *
 * **`origin` carries no liveness, in either direction.** It is provenance only,
 * and no consumer may read it as a visibility signal. Both directions are stated
 * because a one-directional version invites the inverse reading. Verified against
 * the host source at `v4.8.0` and `v4.9.0`:
 *
 * - `origin: 'deployer'` can be a **discarding** channel with no user flag at
 *   all. `src/lib/test.js:Test.performInitialDeploy` runs the migration phase on
 *   `config.with({ quiet: true, logger: { log(){} } })` — the host hard-codes it —
 *   and `src/lib/commands/migrate.js:command.run` replaces `options.logger` with a
 *   noop under `--quiet`/`--silent` before `Config.detect`.
 *   `src/components/Migrate/index.js:Migration.prototype.run` then wraps whichever
 *   applied in `{ log(msg) { logger.log('  ' + msg); } }`, so `deployer.logger` is
 *   always a live-*looking* one-method object regardless of what it forwards to.
 * - `origin: 'config-lineage'` is ordinarily **`console`**, and *not* TronBox's
 *   `{ log(){} }` default — this direction corrects what an earlier revision of
 *   this comment claimed. `src/index.js` builds the CLI options as
 *   `{ logger: console }`; `src/lib/commands/test.js:command.run` calls
 *   `Config.detect(options)` with **no quiet branch and no logger substitution
 *   anywhere in its body**, unlike the migrate command; `logger` is a declared
 *   prop (`src/components/Config.js`, `props.logger`) so `Config.prototype.merge`
 *   installs it; and `src/lib/test.js` sets
 *   `config.resolver = new Resolver(config)`, whose constructor stores
 *   `this.options = options` (`src/components/Resolver/index.js:Resolver`), so
 *   `artifacts.resolver.options` **is** that same live Config. The
 *   `{ log(){} }` default (`src/components/Config.js`, `_values.logger`) applies
 *   only to a Config nobody merged a logger onto, which is neither lineage under a
 *   CLI invocation.
 *
 * **The correction does not change the decision.** A channel that *may* discard
 * has to be treated as if it does, and liveness is not computable from anything
 * the seam can see: it would require knowing what the innermost forwarded function
 * does. So the seam reports provenance and stops; SF-10 owns the consequence.
 *
 * `hostQuietRequested` is read from the lineage matching `origin`, never mixed
 * across lineages.
 */
export function outputFromHandles(
  handles: RawMigrationHandles,
  lineages: ConfigLineages,
  recorder: InternalPathRecorder,
): OutputSlotAttempt {
  const useDeployer = handles.deployer !== undefined;

  if (useDeployer && !isObjectLike(handles.deployer)) {
    return malformed('deployer', 'deployer', 'missing');
  }

  const handle = useDeployer ? 'deployer' : 'artifacts';
  const lineageAttempt = useDeployer
    ? lineages.viaDeployer
    : lineages.viaArtifacts;
  if (lineageAttempt.status === 'absent') {
    // Reachable only when *neither* bearing handle was supplied: `useDeployer` is
    // true whenever `deployer` is, and `inspectLineage` reports `absent` only for
    // a handle that is `undefined`. So there is no broken path to name (D-1).
    return { ok: false, noBearingHandle: true };
  }
  if (lineageAttempt.status === 'malformed') {
    return malformed(
      handle,
      lineageAttempt.failure.expectedPath,
      lineageAttempt.failure.because,
    );
  }
  const lineage = lineageAttempt.lineage;

  const logger = useDeployer
    ? loggerFrom(handles.deployer, 'deployer.logger', 'deployer', recorder)
    : loggerFrom(
        lineage.config,
        `${lineage.prefix}.logger`,
        'artifacts',
        recorder,
      );
  if (!logger.ok) {
    return logger;
  }

  const quiet = quietFrom(lineage, recorder);
  if (!quiet.ok) {
    return quiet;
  }

  return {
    ok: true,
    value: sealSlot<OutputChannelSlot>(
      {
        logger: logger.value,
        origin: useDeployer ? 'deployer' : 'config-lineage',
        hostQuietRequested: quiet.value,
      },
      ['logger'],
      resolutionSharingGuard(handles, lineages),
    ),
  };
}
