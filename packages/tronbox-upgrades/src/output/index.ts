/**
 * The plugin's output and warning channel.
 *
 * INV-43: this directory imports **nothing** — not a package, not the seam, not
 * another sub-feature's module. That is what makes SF-10 a dependency root in the
 * code and not only in the plan.
 *
 * Two deliberate omissions from this surface (INV-45):
 * - `resetSilenceForTests` — test-only, reachable by deep import from
 *   `src/output/silence` and nowhere else. It exists because the silence flag is
 *   process-global and the test suite is not, and it carries no compatibility
 *   promise.
 * - `isSilenced` — read by `channel.ts`'s emitter and by nothing else, because
 *   INV-24 requires the flag be read at exactly one place in the package.
 *
 * SF-11 owns the package entry point; this is the directory's face to its
 * siblings.
 */
export {
  RECORDED_NOTE_CAP,
  DegradedNoteInvalidError,
  createOutputChannel,
} from './channel';

export {
  EngineCallNotSynchronousError,
  EngineCaptureReentrantError,
  capturableEngineExports,
  captureEngineWarnings,
  engineWarningCapableExports,
  uncapturableEngineExports,
  uncapturedEngineWarnings,
  type EngineWarningCapableExport,
  type UncapturedEngineWarning,
} from './engine';

export { silenceWarnings } from './silence';

export {
  degradedCodes,
  type DegradedCode,
  type DegradedNote,
  type HostChannelFacts,
  type LogSink,
  type OutputChannel,
} from './types';
