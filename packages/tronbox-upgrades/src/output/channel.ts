import { isSilenced } from './silence';
import type {
  DegradedNote,
  HostChannelFacts,
  LogSink,
  OutputChannel,
} from './types';

/**
 * INV-38: the documented maximum length of a channel's `recorded` array.
 *
 * Any number is arbitrary; the truncation note is what carries the honesty. 100
 * per channel, on the dev's ruling and reasoning: a single operation producing
 * more than 100 distinct degraded statements has a problem the notes cannot
 * express anyway, and the truncation note says so.
 *
 * The bound is not theoretical. Upstream performs **no dedupe** —
 * `dist/utils/log.js:log` writes every call, verified present at
 * `@openzeppelin/upgrades-core@1.46.0` — and `validate` emits one warning per
 * offending struct through `dist/storage/namespace.js` and
 * `dist/validate/run.js`. A large project can therefore produce hundreds of
 * relayed notes on one operation, which are then held on the returned result for
 * the caller's lifetime and re-emitted on every migration of a `tronbox test`
 * replay. Silent truncation would be an SC-003 hole; unbounded growth is a memory
 * and legibility problem. Capping with an explicit statement violates neither.
 */
export const RECORDED_NOTE_CAP = 100;

/**
 * Four spaces, matching both TronBox's own
 * `build/components/WorkflowCompile.js:writeBuildInfo` house style and upstream's
 * `indent(l, 4)`.
 */
const DETAIL_INDENT = '    ';

/**
 * A `DegradedNote` that cannot be recorded because a required field is missing or
 * malformed.
 *
 * Added at Code Draft: INV-35 requires `degraded` to reject an empty `summary` or
 * `remedy` "with a typed error" but does not name the class, and INV-8 requires
 * every rejection in the package to be a typed error carrying a stable `code`.
 * The `detail` case is the same class of defect — a JavaScript producer can pass a
 * non-array — and refusing it is INV-9's never-coerce rule applied to the note's
 * own shape.
 *
 * This is a plugin defect, not a user error: the note's producer is always plugin
 * code. The message therefore names the channel's provenance, which is what makes
 * the report actionable (SC-006).
 */
export class DegradedNoteInvalidError extends Error {
  readonly code = 'DEGRADED_NOTE_INVALID' as const;
  readonly field: 'summary' | 'detail' | 'remedy';
  readonly channel: string;

  constructor(field: 'summary' | 'detail' | 'remedy', channel: string) {
    super(
      `Refusing to record a degraded-mode note whose "${field}" is ` +
        `${field === 'detail' ? 'not an array' : 'empty'}. Every note must name ` +
        'the actual state and what the user can do about it; a note without ' +
        'both is a degraded path the caller cannot act on. Channel: ' +
        `${channel}.`,
    );
    this.name = 'DegradedNoteInvalidError';
    this.field = field;
    this.channel = channel;
  }
}

type EmissionLevel = 'Warning' | 'Note';

/**
 * The single write path, and the single place the silence flag is read (INV-24).
 *
 * Formatting follows TronBox rather than upstream: the bare ASCII prefix
 * `"Warning: "` and four-space-indented detail lines, matching
 * `build/components/WorkflowCompile.js:writeBuildInfo`'s `"Warning: failed to
 * write build-info: …"`. No colour and no `chalk` dependency — requiring `chalk`
 * probes `tty.isatty` at import time, a frozen environment-dependent decision the
 * plugin has no reason to take.
 *
 * INV-25, three properties in six lines:
 * - `typeof` rather than `in`, because `console`'s methods and a closure-built
 *   wrapper's differ in ownership.
 * - `.call(sink, …)` because `console`'s methods are not safe to invoke detached
 *   on every host.
 * - **Exactly one** `write` call per emission, because the deployer's own wrapper
 *   (`{ log: msg => logger.log('  ' + msg) }`) indents by two spaces per call, so
 *   a three-call emission would get three prefixes.
 */
function emit(
  sink: LogSink,
  level: EmissionLevel,
  title: string,
  detail: readonly string[],
): void {
  if (isSilenced()) {
    return;
  }

  const candidate = (sink as { warn?: unknown }).warn;
  const write: (...args: unknown[]) => void =
    typeof candidate === 'function'
      ? (candidate as (...args: unknown[]) => void)
      : sink.log;
  const lines = detail.map(line => `${DETAIL_INDENT}${line}`);

  try {
    write.call(sink, [`${level}: ${title}`, ...lines].join('\n'));
  } catch {
    // INV-23: the write is a courtesy and nothing load-bearing rides it — the
    // `recorded` append already happened, and failures travel as thrown typed
    // errors. A host sink that throws (or a JavaScript host that supplied an
    // object with no `log` at all) must not fail an operation that otherwise
    // succeeded. Swallowed deliberately and only here; every caller's guarantee
    // is the returned value, not this write.
  }
}

/**
 * Builds the plugin's channel over a host sink.
 *
 * Every dependency is injected as data (INV-44): the sink and its provenance
 * arrive as {@link HostChannelFacts}, so every test is a plain object — no
 * TronBox process, no node, no seam. The channel reads no ambient state: no
 * `process.env`, no clock, no filesystem, no network, and no `console`.
 *
 * The channel is stateful for the life of one operation (it accumulates
 * `recorded`) and synchronous throughout (INV-40).
 */
export function createOutputChannel(facts: HostChannelFacts): OutputChannel {
  const appended: DegradedNote[] = [];
  let suppressed = 0;

  const describe = (): string =>
    'the plugin output channel ' +
    `(sink lineage: ${facts.origin}; host quiet requested: ` +
    `${String(facts.hostQuietRequested)})`;

  /**
   * INV-38's truncation statement, built at read time so it names the **final**
   * suppressed count rather than the count at the moment the cap was reached.
   */
  const truncationNote = (count: number): DegradedNote =>
    Object.freeze({
      code: 'notes-truncated',
      summary:
        `${count} further degraded-mode note(s) were suppressed after the ` +
        `first ${RECORDED_NOTE_CAP} on this operation`,
      detail: Object.freeze([
        `This channel records at most ${RECORDED_NOTE_CAP} notes per operation.`,
        'Suppressed notes were neither recorded nor written, so the count ' +
          'above is the only record of them.',
      ]),
      remedy:
        'Re-run the operation on a smaller set of contracts to see the ' +
        'remaining notes, or address the notes already listed — an operation ' +
        `producing more than ${RECORDED_NOTE_CAP} distinct degraded ` +
        'statements usually has one underlying cause.',
    });

  const channel: OutputChannel = {
    origin: facts.origin,

    describe,

    warn(title: string, detail: readonly string[] = []): void {
      emit(facts.logger, 'Warning', title, detail);
    },

    note(title: string, detail: readonly string[] = []): void {
      emit(facts.logger, 'Note', title, detail);
    },

    degraded(note: DegradedNote): DegradedNote {
      // INV-35: validate first, so a malformed note can never reach `recorded`.
      if (note.summary.trim() === '') {
        throw new DegradedNoteInvalidError('summary', describe());
      }
      if (note.remedy.trim() === '') {
        throw new DegradedNoteInvalidError('remedy', describe());
      }
      if (!Array.isArray(note.detail)) {
        throw new DegradedNoteInvalidError('detail', describe());
      }

      const frozen: DegradedNote = Object.freeze({
        code: note.code,
        summary: note.summary,
        detail: Object.freeze([...note.detail]),
        remedy: note.remedy,
      });

      // INV-38: the one documented exception to INV-23's unconditional append.
      // Past the cap the note is neither recorded nor written, and the
      // truncation note in `recorded` states that and how many. The validated,
      // frozen note is still returned, so the caller gets back what it handed
      // in rather than a silent `undefined`.
      if (appended.length >= RECORDED_NOTE_CAP) {
        suppressed += 1;
        return frozen;
      }

      // INV-23: record, *then* attempt the write. The record is the guarantee.
      appended.push(frozen);
      emit(facts.logger, 'Warning', frozen.summary, [
        ...frozen.detail,
        `Remedy: ${frozen.remedy}`,
      ]);
      return frozen;
    },

    /**
     * INV-37: the same members in the same order as the `degraded` calls that
     * produced them — nothing added, reordered, deduplicated or dropped. Frozen
     * (INV-16), and built fresh on each read so the truncation note carries the
     * final count; the caller's `notes` is a snapshot of this.
     */
    get recorded(): readonly DegradedNote[] {
      return Object.freeze(
        suppressed === 0
          ? [...appended]
          : [...appended, truncationNote(suppressed)],
      );
    },
  };

  return Object.freeze(channel);
}
