import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Primes `MANIFEST_DEFAULT_DIR` before anything in the importing test file's
 * own closure can load the real engine.
 *
 * The engine reads that variable from `process.env` **once**, at module load
 * of its own manifest module — so setting it from a test's own top-level
 * code is only in time if NOTHING evaluated ahead of that top-level code
 * already reached the engine first. `src/options/resolve.ts` holds the
 * package's one static engine value-import, and any test file that imports
 * `../src/options` (even just for an error class) pulls it in transitively —
 * ahead of that file's OWN top-level statements, because ES module
 * evaluation runs each import's whole dependency tree to completion, in
 * declaration order, before the importing module's own body runs.
 *
 * So this module carries NO project import of its own (only Node
 * built-ins), and a test file that needs a real `RecordSession` imports it
 * FIRST — textually ahead of every other import — so its assignment below
 * is the first thing to run in that file's whole module graph.
 */
export const RECORD_DIR: string = fs.mkdtempSync(
  path.join(os.tmpdir(), 'tron-record-dir-'),
);

const PREVIOUS_MANIFEST_DIR = process.env['MANIFEST_DEFAULT_DIR'];
process.env['MANIFEST_DEFAULT_DIR'] = RECORD_DIR;

/** Restores the prior environment value and removes the temp directory. */
export function restoreRecordDir(): void {
  if (PREVIOUS_MANIFEST_DIR === undefined) {
    delete process.env['MANIFEST_DEFAULT_DIR'];
  } else {
    process.env['MANIFEST_DEFAULT_DIR'] = PREVIOUS_MANIFEST_DIR;
  }
  fs.rmSync(RECORD_DIR, { recursive: true, force: true });
}
