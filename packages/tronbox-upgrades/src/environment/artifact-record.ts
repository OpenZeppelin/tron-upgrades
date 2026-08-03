import {
  InternalPathRecorder,
  isObjectLike,
  readOwnProperty,
  type PropertyRead,
} from './handles';
import type {
  ArtifactRecord,
  ArtifactRecordField,
  ArtifactRecordReport,
  ContractAbstraction,
} from './types';

/**
 * **Why this module exists.** SF-2 needs four facts about a compiled contract —
 * the long compiler version, both bytecodes and the source — plus the artifact's
 * own source path. All five live behind `contract._json`, which
 * `build/components/Contract/contract.js` assigns as an own data property
 * (`temp._json = json`), and `_json` is a TronBox-internal property path. INV-28
 * reserves those to `src/environment/**`, so the *observation* happens here and a
 * consumer receives frozen plain data.
 *
 * This is the compiler slot's argument applied a second time, not a new one: the
 * alternative was never "SF-2 reads it" but "SF-2 reads it *inside*
 * `src/environment/`".
 *
 * **What this module deliberately does not do.** It performs no I/O, opens no
 * artifact file and consults no build-info. Everything here comes off the
 * abstraction the seam already resolved, so `record()` costs no filesystem access
 * — which is what lets it stay off the `resolve()` path (INV-23's memoized index is
 * the expensive thing, and this touches none of it).
 */

/** The one hop that makes every read below a TronBox-internal read. */
const JSON_PATH = 'contract._json';

/**
 * How one field is reached, and which {@link ArtifactRecord} member it fills.
 *
 * Every read is a **direct `readOwnProperty` call with a literal key**, and both
 * halves of that are load-bearing rather than stylistic. `source-scan.ts` collects
 * `readPropertyKeys` by matching call expressions whose callee is literally
 * `readOwnProperty` or `readProperty` and whose second argument is a string
 * literal, and INV-28's enumeration test asserts that set exactly. So a generic
 * hop-walker (key passed as a variable) *or* a one-line local wrapper (callee not
 * the primitive) would report this module's drift surface as one host key when it
 * is seven. The repetition below buys the enumeration; a helper would spend it.
 *
 * This was not reasoned in advance — the first draft used a two-line `ownRead`
 * wrapper and the enumeration test failed, naming the five keys it could no longer
 * see. Recorded because the failure is invisible to a reader of the wrapper.
 */
interface ArtifactRecordFieldSpec {
  readonly member: keyof ArtifactRecord;
  read(json: unknown, recorder: InternalPathRecorder): FieldRead;
}

/**
 * A field's read together with **the path that produced it**, which is not always
 * the field's full path: for the two-hop `compiler.version` a throw may come from
 * either hop, and a refusal naming `…compiler.version` when `…compiler` is what
 * raised names a path the seam never reached. Carrying the path out of the read is
 * what keeps the message and the failure the same event.
 */
interface FieldRead {
  readonly read: PropertyRead;
  readonly path: string;
}

const ARTIFACT_RECORD_FIELDS = Object.freeze({
  /**
   * Two hops, and the only field whose name and member differ — see
   * {@link ArtifactRecord.longCompilerVersion} for why the member is named for the
   * long form.
   *
   * The second hop is attempted only when the first yielded an object, so a
   * `compiler` that is a bare string ends the chain without recording
   * `…compiler.version` as read (INV-33: the reported set is never a superset).
   */
  'compiler.version': {
    member: 'longCompilerVersion',
    read: (json, recorder) => {
      const outer = `${JSON_PATH}.compiler`;
      const compiler = readOwnProperty(json, 'compiler', outer, recorder);
      if (!compiler.ok) {
        return { read: compiler, path: outer };
      }
      if (!isObjectLike(compiler.value)) {
        return { read: { ok: false, reason: 'missing' }, path: outer };
      }
      const inner = `${JSON_PATH}.compiler.version`;
      return {
        read: readOwnProperty(compiler.value, 'version', inner, recorder),
        path: inner,
      };
    },
  },
  source: {
    member: 'source',
    read: (json, recorder) => ({
      read: readOwnProperty(json, 'source', `${JSON_PATH}.source`, recorder),
      path: `${JSON_PATH}.source`,
    }),
  },
  sourcePath: {
    member: 'sourcePath',
    read: (json, recorder) => ({
      read: readOwnProperty(
        json,
        'sourcePath',
        `${JSON_PATH}.sourcePath`,
        recorder,
      ),
      path: `${JSON_PATH}.sourcePath`,
    }),
  },
  bytecode: {
    member: 'bytecode',
    read: (json, recorder) => ({
      read: readOwnProperty(json, 'bytecode', `${JSON_PATH}.bytecode`, recorder),
      path: `${JSON_PATH}.bytecode`,
    }),
  },
  deployedBytecode: {
    member: 'deployedBytecode',
    read: (json, recorder) => ({
      read: readOwnProperty(
        json,
        'deployedBytecode',
        `${JSON_PATH}.deployedBytecode`,
        recorder,
      ),
      path: `${JSON_PATH}.deployedBytecode`,
    }),
  },
} as const satisfies Record<ArtifactRecordField, ArtifactRecordFieldSpec>);

type FieldTable = typeof ARTIFACT_RECORD_FIELDS;

/**
 * The compiler slot's coverage instrument, for the same reason it has one:
 * {@link readArtifactRecord} builds the record by iterating this table alone, so a
 * field declared in {@link ArtifactRecordField} but absent from the table would be
 * silently omitted from every record and never reported missing. `satisfies` above
 * closes one direction (a missing key is an error, an extra key is an excess
 * property); these close it as an assertion a reader can see.
 */
type AssertTrue<T extends true> = T;
export type ArtifactRecordFieldCoverage = AssertTrue<
  [keyof FieldTable] extends [ArtifactRecordField]
    ? [ArtifactRecordField] extends [keyof FieldTable]
      ? true
      : false
    : false
>;

/**
 * The other half, and the half `satisfies` cannot give: the table's `member` values
 * cover **every** member of {@link ArtifactRecord}. Without it two fields could
 * name the same member, leaving one record member never assigned — which
 * field-name completeness alone does not catch, and which the `as ArtifactRecord`
 * at the end of {@link readArtifactRecord} would then wave through.
 */
export type ArtifactRecordMemberCoverage = AssertTrue<
  [FieldTable[ArtifactRecordField]['member']] extends [keyof ArtifactRecord]
    ? [keyof ArtifactRecord] extends [FieldTable[ArtifactRecordField]['member']]
      ? true
      : false
    : false
>;

/** Declaration order, which is also the order `missing` is reported in. */
const FIELD_NAMES = Object.freeze(
  Object.keys(ARTIFACT_RECORD_FIELDS) as ArtifactRecordField[],
);

/**
 * A host accessor raised, rather than an artifact being incomplete.
 *
 * Kept out of {@link ArtifactRecordReport} on purpose. A consumer's diagnosis for
 * an incomplete artifact is *"your TronBox is older than this field"*, and a
 * raising getter is not that — it is a malfunctioning host, which INV-15 turns
 * into one of the seam's own typed errors. `artifacts.ts` owns that translation
 * because it owns the `artifacts` slot's failure wording; this module stays total
 * so it never needs to import the error family.
 */
export type ArtifactRecordOutcome =
  | ArtifactRecordReport
  | { readonly status: 'host-accessor-threw'; readonly path: string };

/**
 * `Object.keys` behind INV-15, exactly as `compiler.ts:ownKeyCount` does it: the
 * argument is object-like by construction here, but a host object may still be
 * exotic enough to raise from its own trap, and no host throw leaves the seam.
 */
function observedKeysOf(json: Record<PropertyKey, unknown>): string[] | null {
  try {
    return Object.keys(json).sort();
  } catch {
    return null;
  }
}

/** Nothing to read: every field is missing and the artifact showed no keys. */
function noArtifactRecord(
  recorder: InternalPathRecorder,
): ArtifactRecordReport {
  return Object.freeze({
    status: 'incomplete',
    missing: FIELD_NAMES,
    observedKeys: Object.freeze([]),
    internalPathsRead: recorder.snapshot(),
  });
}

/**
 * Projects the five artifact fields off one contract abstraction.
 *
 * **A field counts as present iff its own-property read yields a `string`.** Two
 * consequences, both deliberate:
 *
 * - Presence, never truthiness (INV-17). `bytecode: "0x"` is what TronBox writes
 *   for an abstract contract and `""` is reachable too; both are *present*, and a
 *   truthiness test would report the artifact as shape-unsupported for a contract
 *   that simply has no code.
 * - A key present but holding a **non-string** is folded into `missing` rather
 *   than given a third state. The record's contract is that every member is a
 *   `string`, so there is nothing honest to put in the member; and the
 *   information is not lost, because `observedKeys` still contains the key — a
 *   consumer can tell "absent" from "present but unusable" from the report it
 *   already has. On a real artifact the state is unreachable anyway: TronBox
 *   assembles every artifact from a hard-coded field allow-list
 *   (`src/components/Compile/index.js:165-179` at `v4.9.0`), so these keys carry
 *   what the compiler produced or are absent entirely.
 *
 * The values are not shape-checked beyond `string`, the same choice
 * `CompilerConfiguration.resolvedVersion` makes: whether a bytecode is usable hex
 * or a compiler version is supported is a policy the consumer owns, and a seam
 * holding a second gate would have to be kept in step with the first.
 */
export function readArtifactRecord(
  contract: ContractAbstraction,
): ArtifactRecordOutcome {
  const recorder = new InternalPathRecorder();

  const json = readOwnProperty(contract, '_json', JSON_PATH, recorder);
  if (!json.ok) {
    return json.reason === 'threw'
      ? { status: 'host-accessor-threw', path: JSON_PATH }
      : noArtifactRecord(recorder);
  }
  if (!isObjectLike(json.value)) {
    // Present but not an object — no keys to observe and no field to read, which
    // is the same report as an absent `_json`. A distinct status would give a
    // consumer a branch whose remedy is identical.
    return noArtifactRecord(recorder);
  }

  const observedKeys = observedKeysOf(json.value);
  if (observedKeys === null) {
    return { status: 'host-accessor-threw', path: JSON_PATH };
  }

  const missing: ArtifactRecordField[] = [];
  const values: Partial<Record<keyof ArtifactRecord, string>> = {};

  for (const field of FIELD_NAMES) {
    const spec: ArtifactRecordFieldSpec = ARTIFACT_RECORD_FIELDS[field];
    const { read, path } = spec.read(json.value, recorder);
    if (!read.ok && read.reason === 'threw') {
      return { status: 'host-accessor-threw', path };
    }
    if (read.ok && typeof read.value === 'string') {
      values[spec.member] = read.value;
    } else {
      missing.push(field);
    }
  }

  const frozenKeys = Object.freeze(observedKeys);
  const internalPathsRead = recorder.snapshot();

  if (missing.length > 0) {
    return Object.freeze({
      status: 'incomplete',
      missing: Object.freeze(missing),
      observedKeys: frozenKeys,
      internalPathsRead,
    });
  }

  // Every member was assigned: `missing` is empty, and the two coverage
  // assertions above are what make "every field in the table" mean "every member
  // of the record". The cast carries that reasoning across the one boundary
  // `Partial` cannot.
  return Object.freeze({
    status: 'complete',
    record: Object.freeze(values as ArtifactRecord),
    observedKeys: frozenKeys,
    internalPathsRead,
  });
}
