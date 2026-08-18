/**
 * Turns the engine's two unnamed record-file failures into this plugin's own
 * refusals.
 *
 * **The classification is by call site, not by message.** Matching an upstream
 * error string would break silently the first time the engine reworded one. What
 * makes this precise instead is where the wrapper is applied: the engine's
 * `Manifest.read()` can fail in exactly four ways — the lock, reading the file,
 * `JSON.parse`, and the manifest-version validation (an absent file is not one
 * of them; `read` answers a default manifest for `ENOENT`). So at that call site
 * every failure that is not the lock *is* a statement that the record file
 * cannot be read, and the two arms below need no knowledge of the wording.
 *
 * Two entry points, because two kinds of call site need different widths:
 *
 * - {@link throughRecordRead} wraps a call whose whole throw surface belongs to
 *   the engine's record file.
 * - {@link throughRecordLock} wraps a call that also runs code of ours, where
 *   only the lock may be reinterpreted — an `ELOCKED` code is a precise signal
 *   and no error this plugin raises carries it.
 *
 * This module imports only `./errors`, whose own closure is empty, so neither
 * helper drags the engine into a caller that had not already reached it.
 */

import { RecordLockedError, RecordUnreadableError } from './errors';

/**
 * `proper-lockfile`'s contention signal. The engine locks with three retries
 * (~7s of backoff) before giving up, and it holds that lock across a whole
 * implementation deploy, so the loser of a genuine race is what this identifies
 * — not a momentary overlap.
 */
function isLockContention(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ELOCKED'
  );
}

/** The engine's message, or a description of an unusual throw. */
function detailOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return String(error);
}

/**
 * Lock contention only. For a call that also runs plugin code: an `ELOCKED`
 * becomes {@link RecordLockedError} and every other failure passes through
 * untouched, so a refusal of ours is never reinterpreted as a record-file one.
 */
export async function throughRecordLock<T>(
  file: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isLockContention(error)) {
      throw new RecordLockedError(file, detailOf(error));
    }
    throw error;
  }
}

/**
 * Lock contention, plus every other failure read as "this record file cannot be
 * used". Only for a call whose entire throw surface is the engine's record file
 * — see this module's header for why that makes the wide arm precise rather than
 * greedy.
 */
export async function throughRecordRead<T>(
  file: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isLockContention(error)) {
      throw new RecordLockedError(file, detailOf(error));
    }
    throw new RecordUnreadableError(
      file,
      // A `SyntaxError` is `JSON.parse`'s own class, so this arm is a type check
      // rather than a reading of the message. Everything else at this call site
      // is the engine refusing the file's *contents* — a missing or unknown
      // manifest version, an OpenZeppelin CLI-format file, a version with no
      // migration path, or two network files for one chain — and those messages
      // already say which, so they are carried through as the detail.
      error instanceof SyntaxError ? 'not-json' : 'contents-refused',
      detailOf(error),
    );
  }
}
