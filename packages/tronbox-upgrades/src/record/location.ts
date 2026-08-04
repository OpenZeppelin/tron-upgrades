/**
 * Where the deployment record lands, and the assertion that it actually landed
 * there.
 *
 * The engine decides the record's directory from `MANIFEST_DEFAULT_DIR`, read
 * **once**, at module load of its manifest module, into a module-scope constant. Two
 * measured consequences follow, and between them they are the whole of this module's
 * design:
 *
 * 1. **Setting the variable after anything has loaded that module is a silent
 *    no-op.** Measured in a fresh child process: set before the require, the
 *    manifest path is absolute; set after, it is `.openzeppelin/unknown-<id>.json`
 *    and the assignment changed nothing.
 * 2. **A relative value is re-resolved at every filesystem call, not at
 *    construction.** Measured: a manifest constructed under one working directory
 *    and written under another lands under the second. The engine's own
 *    documentation calls the relative form "relative to the root of your project";
 *    it is relative to `process.cwd()`, and TronBox's working directory is not the
 *    project root — the host restores its own `chdir` in a `finally`, so the cwd
 *    differs between plugin-require time and operation-call time.
 *
 * So the assignment is made as early as the entry module can make it, and then **the
 * outcome is asserted** — the path the engine produced, not the value that was
 * written. Three reachable states make the assignment succeed while the location is
 * still wrong, and only an outcome check catches all three: a hoisted static import,
 * a consumer that required the engine before the plugin, and a user's own
 * pre-existing value. The third is *correct* and must be accepted, which is why the
 * assertion is absoluteness **plus agreement** rather than "the value we wrote is
 * the value in force".
 *
 * There is no `process.chdir` here and there must not be: it is a global mutation of
 * the host's process affecting every consumer of a relative path, including the
 * host's own, and it cannot be scoped to one operation.
 */

import path from 'node:path';
import type { AbsolutePath } from '../environment';
import { RecordLocationUnusableError } from './errors';
import type { RecordLocation } from './types';

/** The engine's own variable name, and its own default. */
const MANIFEST_DIR_VAR = 'MANIFEST_DEFAULT_DIR';
const MANIFEST_DEFAULT_DIR = '.openzeppelin';

/**
 * Sets the record's directory to an absolute path derived from the project root, or
 * honours an absolute one the user has already set.
 *
 * **Idempotent.** The second call sees the absolute value the first one wrote, takes
 * the honour-a-pre-existing-value branch, and returns the same location. That is not
 * a hypothetical: the entry module calls this before its first engine-touching
 * import, and the preflight calls it again.
 *
 * A pre-existing **absolute** value is honoured rather than overwritten — it is the
 * engine's own documented per-environment use case, and silently replacing it would
 * break it. A pre-existing **relative** value is refused rather than resolved,
 * because resolving it would require choosing a base, and every available base is
 * wrong for this host.
 *
 * Written through the caller's own environment view rather than through the process
 * global. That is the property that makes the file the engine writes and the file the
 * refusal message names provably the same file: they are derived from one view. If a
 * caller passes a detached object the engine will not see the value, and the outcome
 * assertion is what catches that — loudly, as `'set-too-late'`.
 *
 * @throws {RecordLocationUnusableError} a pre-existing value is relative, or the
 *   derived anchor is not absolute.
 */
export function configureRecordLocation(
  root: AbsolutePath,
  env: Readonly<Record<string, string | undefined>>,
): RecordLocation {
  const configured = env[MANIFEST_DIR_VAR];

  // The engine's own truthiness rule, reproduced rather than improved on: it reads the
  // variable from the environment with a `|| '.openzeppelin'` fallback, so an empty value
  // behaves exactly as an unset one does. Treating empty as configured here would make
  // this plugin and the engine disagree about which directory is in force. (Named as a
  // fallback rather than quoted verbatim, so a census over this directory for the
  // process-global read finds nothing at all — not even a comment to triage.)
  if (configured !== undefined && configured.length > 0) {
    if (!path.isAbsolute(configured)) {
      throw new RecordLocationUnusableError('configured-value-relative', {
        intendedDir: path.join(root, MANIFEST_DEFAULT_DIR),
        resolvedFile: path.join(configured, MANIFEST_DEFAULT_DIR),
        configuredValue: configured,
      });
    }
    return Object.freeze({ dir: configured });
  }

  const dir = path.join(root, MANIFEST_DEFAULT_DIR);
  if (!path.isAbsolute(dir)) {
    // Unreachable while `root` carries the seam's brand, which is minted only by a
    // constructor that refuses a relative path. Reachable from JavaScript, and a
    // guard whose only caller is a mistake still has to fail closed.
    throw new RecordLocationUnusableError('anchor-not-absolute', {
      intendedDir: dir,
      resolvedFile: dir,
    });
  }

  // One cast, in one place, and it is the whole of this module's write access. The
  // parameter is declared readonly so that no other module can be tempted to reach
  // for the same trick; the record layer references the process environment nowhere.
  (env as Record<string, string | undefined>)[MANIFEST_DIR_VAR] = dir;
  return Object.freeze({ dir });
}

/**
 * Asserts the **outcome**: the manifest path the engine produced is absolute, and its
 * directory is the one this plugin resolved.
 *
 * Pure, and takes the path as a string, so it is testable without constructing an
 * engine object — which matters because the failure it exists to catch is one where
 * constructing that object in-process gives the wrong answer for a reason no test
 * fixture can undo.
 *
 * Absoluteness alone is not sufficient. A stale absolute value from another project —
 * a shell export, a CI variable — passes an `isAbsolute` check and writes this
 * project's records into another project's manifest, where the two projects' chain
 * fingerprints are then compared against each other.
 *
 * @throws {RecordLocationUnusableError} `'set-too-late'` when the path is relative,
 *   which is exactly the signature of the silent no-op; `'resolved-outside-anchor'`
 *   when it is absolute and elsewhere.
 */
export function assertRecordLocation(
  location: RecordLocation,
  manifestFile: string,
): string {
  if (!path.isAbsolute(manifestFile)) {
    throw new RecordLocationUnusableError('set-too-late', {
      intendedDir: location.dir,
      resolvedFile: manifestFile,
    });
  }
  const resolvedDir = path.dirname(manifestFile);
  if (path.relative(resolvedDir, location.dir) !== '') {
    throw new RecordLocationUnusableError('resolved-outside-anchor', {
      intendedDir: location.dir,
      resolvedFile: manifestFile,
    });
  }
  return manifestFile;
}
