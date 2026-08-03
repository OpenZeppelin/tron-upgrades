/**
 * Diagnostics that cannot leak a credential, and a logger call that cannot throw.
 *
 * Two independent hazards, both documented in `../safety.md`:
 *
 *  1. Host handles are redacted on **serialization only**. `JSON.stringify` is
 *     safe; `util.inspect`, `console.log` and template interpolation are not,
 *     because the non-enumerable `toJSON` is invisible to all three.
 *  2. `TronBoxLogger` declares `log` and nothing else. Four of TronBox's five
 *     logger-injection paths supply a single-method object, so `logger.warn` is a
 *     `TypeError` under `--quiet` and under `tronbox test`.
 */
import {
  resolveEnvironment,
  type RawMigrationHandles,
  type TronBoxEnvironment,
  type TronBoxLogger,
} from '../../../src/environment';

// ---------------------------------------------------------------------------
// 1. Safe diagnostics
// ---------------------------------------------------------------------------

/**
 * Built from named projected fields only. This is the preferred form: three slots
 * carry no host handle at all (`paths`, `network`, `provenance`), so a diagnostic
 * assembled from them is safe in every channel with no projection step.
 */
export function describeEnvironment(
  env: TronBoxEnvironment<'paths' | 'network'>,
): string {
  return [
    `network:  ${env.network.name} (id ${env.network.artifactNetworkId})`,
    `wildcard: ${env.network.configuredId.syntax === 'wildcard'}`,
    // A boolean by construction — never the key itself.
    `signing:  ${env.network.signingKeyConfigured ? 'configured' : 'absent'}`,
    `root:     ${env.paths.root}`,
    `external: ${env.paths.contractsBuildDirectoryIsExternal}`,
    `lineages: ${env.provenance.configLineages.viaDeployer} / ` +
      `${env.provenance.configLineages.viaArtifacts}` +
      ` (crossChecked=${env.provenance.configLineages.crossChecked})`,
  ].join('\n');
}

/**
 * The whole composite, through serialization. Safe: every host handle is replaced
 * with `REDACTED_HOST_HANDLE` by the `toJSON` backstop, and the backstop is also
 * what makes this possible at all — a real `Deployer` reaches a `Config` whose
 * `resolver.options` closes a cycle, so plain `JSON.stringify` would otherwise
 * throw `TypeError: Converting circular structure to JSON`.
 */
export function serializeEnvironment(env: object): string {
  return JSON.stringify(env, undefined, 2);
}

/*
 * Deliberately NOT provided, because each of these leaks:
 *
 *   console.log(env.scheduling);                   // toJSON not consulted
 *   console.log(env.scheduling.deployer);          // ditto
 *   util.inspect(env.artifacts, { depth: null });  // ditto
 *   `deployer: ${env.scheduling.deployer}`         // template interpolation
 *
 * A configured `privateKey` is reachable from `scheduling.deployer` and from
 * `artifacts.intercept` by own-enumerable traversal at depth 4, verified on
 * TronBox 4.9.0 and 4.8.0. The rule: log the composite, never the raw handle.
 */

// ---------------------------------------------------------------------------
// 2. A logger call that cannot throw
// ---------------------------------------------------------------------------

type MaybeRicher = TronBoxLogger & {
  readonly warn?: unknown;
};

/**
 * Emits at `warn` where the host logger has it, else falls back to `log`.
 *
 * Note the explicit receiver. `console.warn` tolerates a detached call but a
 * closure-built wrapper may not, and getting that wrong reintroduces the exact
 * `TypeError` the probe exists to prevent.
 */
export function warn(logger: TronBoxLogger, message: string): void {
  const candidate = (logger as MaybeRicher).warn;
  if (typeof candidate === 'function') {
    (candidate as (this: TronBoxLogger, ...args: unknown[]) => void).call(
      logger,
      message,
    );
    return;
  }
  logger.log(message);
}

/**
 * End to end: resolve, describe, and emit — with `output` optional so the code
 * also works in `tronbox console`, where the slot is absent.
 *
 * Note that reaching this line proves nothing about visibility. `output.logger`
 * may be TronBox's own `{ log(){} }` noop, which is the normal case in two of the
 * five invocation contexts with no flag involved. Anything that must reach the
 * user belongs in a return value or a thrown error, not here.
 */
export function reportEnvironment(handles: RawMigrationHandles): string {
  const env = resolveEnvironment(handles, {
    require: ['paths', 'network'],
    optional: ['output'],
  });

  const summary = describeEnvironment(env);
  if (env.output !== undefined) {
    warn(env.output.logger, summary);
  }
  return summary;
}
