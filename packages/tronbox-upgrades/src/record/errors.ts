/**
 * The record layer's additions to the plugin's error family.
 *
 * **This module imports nothing.** That is deliberate and it is what makes
 * `address.ts` — the module whose failure mode is a wrong record key — reachable
 * from a test with no fixture, no network and no host: `address.ts` imports
 * `tronweb`, `ethers` and this file, and this file's own closure is empty, so the
 * transitive closure of the highest-consequence module in the sub-feature is
 * exactly two third-party packages.
 *
 * Family membership here is *stylistic*, not by inheritance, following
 * `src/chain/errors.ts`: a `code` field, a **closed** `because` union, and one
 * table-driven renderer per class, so a new cause is a compile error at the table
 * rather than a message that quietly falls through to a generic remedy.
 *
 * **No two causes share a remedy string.** That is the point of having causes: the
 * remedy is what tells the user which situation they are in, and two of
 * {@link RecordLocationUnusableError}'s four are opposite problems — one is a
 * load-order defect in this plugin, one is the user's own environment variable.
 */

/** Why the deployment record's location could not be established or trusted. */
export type RecordLocationCause =
  /**
   * The anchor this plugin derived is not an absolute path. Unreachable through
   * TypeScript — the anchor is built from a branded `AbsolutePath` — and therefore
   * reachable only from JavaScript or through a suppressed type error, which is
   * exactly when a guard has to fail closed rather than assume.
   */
  | 'anchor-not-absolute'
  /**
   * A pre-existing `MANIFEST_DEFAULT_DIR` is relative. Refused rather than
   * resolved: the engine re-resolves a relative value against the current working
   * directory at every filesystem call, and TronBox's working directory is not the
   * project root.
   */
  | 'configured-value-relative'
  /**
   * The value in force is absolute but is not the one this plugin resolved — a
   * stale export or CI variable pointing at another project's records.
   */
  | 'resolved-outside-anchor'
  /**
   * The engine's manifest module was loaded before the location was configured, so
   * the assignment was a silent no-op and the record would land under whatever
   * directory the process happens to be in.
   */
  | 'set-too-late';

interface RecordLocationContext {
  /** The directory this plugin resolved the record into. */
  readonly intendedDir: string;
  /** The manifest path the engine actually produced. */
  readonly resolvedFile: string;
  /** A pre-existing `MANIFEST_DEFAULT_DIR`, when one is what failed. */
  readonly configuredValue?: string;
}

const MANIFEST_DIR_VAR = 'MANIFEST_DEFAULT_DIR';

/**
 * One remedy per cause, exhaustive over the union.
 *
 * `Record<RecordLocationCause, string>` rather than a `switch`: adding a cause
 * without a remedy is a compile error here, where it is cheap, instead of a
 * fall-through at runtime, where it is a user reading advice for a different
 * problem.
 */
const locationRemedies: Readonly<Record<RecordLocationCause, string>> =
  Object.freeze({
    'anchor-not-absolute':
      'This is a defect in the plugin rather than in your project: the project ' +
      'root it was given is not an absolute path. Please report it with the ' +
      'command you ran.',
    'configured-value-relative':
      `Set ${MANIFEST_DIR_VAR} to an absolute path, or unset it and let the ` +
      'plugin place the records under your project root. A relative value is ' +
      'resolved against the current working directory, not against the project, ' +
      'so the records would move with the directory you happen to run from.',
    'resolved-outside-anchor':
      `Unset ${MANIFEST_DIR_VAR}, or point it at this project. A value left over ` +
      "from another project or a CI variable would write this project's " +
      "deployment records into the other project's manifest, where the chain " +
      'fingerprints of both would be compared against each other.',
    'set-too-late':
      'This is a defect in the plugin rather than in your project: something ' +
      'loaded the upgrades engine before the record location was configured, and ' +
      'the engine reads that location once, when it is first loaded. Please ' +
      'report it, and note whether your migration requires ' +
      '"@openzeppelin/upgrades-core" itself before requiring this plugin — that ' +
      'is the one form of this failure you can work around, by requiring the ' +
      'plugin first.',
  });

function renderLocationFailure(
  because: RecordLocationCause,
  context: RecordLocationContext,
): string {
  const configured =
    context.configuredValue === undefined
      ? ''
      : ` ${MANIFEST_DIR_VAR} is set to "${context.configuredValue}".`;

  const diagnosis =
    because === 'set-too-late'
      ? `The deployment record would be written to the relative path ` +
        `"${context.resolvedFile}", which resolves against whatever directory ` +
        `this process is in rather than against ${context.intendedDir}.`
      : because === 'anchor-not-absolute'
        ? `The deployment record cannot be anchored: "${context.intendedDir}" is ` +
          'not an absolute path.'
        : because === 'configured-value-relative'
          ? `The deployment record cannot be anchored to a relative ` +
            `${MANIFEST_DIR_VAR}.${configured}`
          : `The deployment record would be written to ` +
            `"${context.resolvedFile}", which is not under ` +
            `${context.intendedDir}.${configured}`;

  return `${diagnosis}\n\n${locationRemedies[because]}`;
}

/**
 * The record's location could not be established, or the engine is not using it.
 *
 * Covers all four states in which the *assignment* succeeds while the location is
 * still wrong, which is why the plugin asserts the **outcome** — the manifest path
 * the engine produced — rather than the assignment.
 */
export class RecordLocationUnusableError extends Error {
  readonly code = 'TRON_RECORD_LOCATION_UNUSABLE' as const;

  constructor(
    readonly because: RecordLocationCause,
    readonly context: RecordLocationContext,
  ) {
    super(renderLocationFailure(because, context));
    this.name = 'RecordLocationUnusableError';
  }
}

/**
 * Why an address could not be brought to the one canonical form the record uses.
 *
 * Five members, and each one is a distinct measured behaviour rather than a
 * category invented for symmetry: TronWeb's `toHex` throws on malformed base58 but
 * returns `41deadbeef` for `0xdeadbeef` and passes a wrong prefix byte through
 * unchanged, so "invalid address" would collapse three different mistakes — a
 * mistyped address, a truncated one, and a string that is not an address at all —
 * into one message.
 */
export type AddressRejectionCause =
  /** The input matches none of the three accepted encodings. */
  | 'unrecognised-encoding'
  /** base58check-shaped, and its checksum does not verify. */
  | 'base58-checksum'
  /** The right alphabet, the wrong number of characters. */
  | 'wrong-length'
  /** 21 hex bytes that do not begin with TRON's fixed `41` prefix byte. */
  | 'wrong-prefix-byte'
  /**
   * The conversion produced something that is not an address, or the input's own
   * mixed-case spelling asserts a checksum that does not hold. Reached only after
   * the input passed the shape gate, which is why it is a separate cause: the
   * caller's encoding was recognised and the value inside it still was not one.
   */
  | 'post-conversion-shape';

const addressRemedies: Readonly<Record<AddressRejectionCause, string>> =
  Object.freeze({
    'unrecognised-encoding':
      'Pass a TRON address in one of three forms: base58check ("T" followed by ' +
      '33 characters), 21-byte TRON hex ("41" followed by 40 hex digits), or ' +
      'EVM-style hex ("0x" followed by 40 hex digits). A contract name is not an ' +
      'address — if you meant to name a contract, this argument is the wrong one ' +
      'for it.',
    'base58-checksum':
      'The address has the right shape but its checksum does not verify, so at ' +
      'least one character is wrong. Copy it again from its source rather than ' +
      'retyping it.',
    'wrong-length':
      'A TRON address is exactly 20 bytes. Check for a truncated or ' +
      'double-pasted value — a block explorer selection that stops short is the ' +
      'usual cause.',
    'wrong-prefix-byte':
      'A TRON address in hex form always begins with the byte "41". A value ' +
      'beginning with anything else is either a different chain\'s address or a ' +
      'hex string that is not an address at all.',
    'post-conversion-shape':
      'If you copied this address in mixed case, its capitalisation is itself a ' +
      'checksum and it does not match. Use the address exactly as its source ' +
      'gives it, or pass it in lower case so no checksum is claimed.',
  });

/**
 * An address the record layer was asked to use is not usable as one.
 *
 * The message names **the address input** rather than reporting a missing
 * deployment record. That ordering is the whole point of gating on shape before
 * converting: the alternative surfaces a mistyped address as "this contract has no
 * deployment record", which points the user at the wrong subsystem.
 */
export class AddressNotCanonicalizableError extends Error {
  readonly code = 'TRON_RECORD_ADDRESS_INVALID' as const;

  constructor(
    /**
     * The caller's value in full, and the only field anywhere that carries it.
     * An address is public by construction and a redacted one makes the
     * diagnosis useless; what must never appear beside it is a contract name, a
     * source path or a host handle.
     */
    readonly received: string,
    readonly because: AddressRejectionCause,
  ) {
    super(
      `"${received}" is not a usable TRON address ` +
        `(${because}).\n\n${addressRemedies[because]}`,
    );
    this.name = 'AddressNotCanonicalizableError';
  }
}

/** Why a fingerprint file that exists could not be used. */
export type FingerprintUnreadableCause =
  /** The file is not JSON. */
  | 'not-json'
  /** Valid JSON whose root is not an object. */
  | 'not-an-object'
  /** Written by a schema this version does not recognise. */
  | 'unrecognised-schema'
  /** `chainId` is absent, not a string, or not a hex quantity. */
  | 'chain-id-unusable'
  /**
   * A hash field is **present** and is not a hash — an explicit `null`, a number,
   * or the wrong width.
   *
   * This is the cause the comparator cannot survive being handed: it tests
   * `genesisHash` for `undefined` rather than for a string, so an explicit `null`
   * reaches a helper typed over `string` and raises a raw `TypeError` from inside
   * a dependency, with no named cause and nothing connecting it to the file the
   * user just edited. Gating here is what keeps that unreachable.
   */
  | 'hash-field-unusable'
  /** Extra keys under a recognised schema, so the file was written by something else. */
  | 'unexpected-keys'
  /** The file could not be read at all, for a reason other than not existing. */
  | 'unreadable-file';

/**
 * The disposition, shared verbatim by every cause below.
 *
 * A fingerprint that cannot be read has nothing left to launder: unlike
 * {@link ChainInstanceChangedError}'s own refusal — which must never let a user delete
 * the fingerprint *alone*, because that would erase the one signal that a readable
 * mismatch is real — an unreadable file carries no signal to erase. So the same two
 * outcomes that refusal names are available here without that restriction: deleting
 * the fingerprint by itself is a legitimate exit rather than a way to make the guard
 * silently trust a wrong chain. Named identically across all seven causes so that
 * which cause fired never changes what the user is told to *do* — only the diagnosis
 * that precedes it does.
 */
const fingerprintTwoExits =
  'If this is still the same chain, delete the fingerprint file and re-run — the ' +
  'guard re-arms itself from the current chain. If the node was wiped, delete the ' +
  'record file and the fingerprint together, and redeploy — the same two outcomes ' +
  'the readable-mismatch refusal already names.';

const fingerprintRemedies: Readonly<
  Record<FingerprintUnreadableCause, string>
> = Object.freeze({
  'not-json':
    'The fingerprint file is not JSON, so nothing could be read from it at all — ' +
    'not even a value to disagree with. ' +
    fingerprintTwoExits,
  'not-an-object':
    'The fingerprint file holds a JSON value that is not an object, so there is ' +
    'no field in it to compare against. ' +
    fingerprintTwoExits,
  'unrecognised-schema':
    'The fingerprint was written by a newer version of this plugin. Upgrading is ' +
    'the exit that loses nothing: an older version rewriting the file loses ' +
    'whatever the newer one recorded. If upgrading is not possible right now, ' +
    'the fingerprint is still unreadable to this version, so the same two exits ' +
    'apply as to any other unreadable one. ' +
    fingerprintTwoExits,
  'chain-id-unusable':
    'The fingerprint names no usable chain id, so there is nothing to compare ' +
    'against. This is what a hand-edited file most often looks like; restore it ' +
    'from version control if you have it, or take one of the two exits below. ' +
    fingerprintTwoExits,
  'hash-field-unusable':
    'One of the fingerprint\'s hashes is present but is not a 32-byte hash. ' +
    'Clearing a field does not clear the check it feeds — it turns the check ' +
    'off, which is why this is reported rather than ignored. ' +
    fingerprintTwoExits,
  'unexpected-keys':
    'The fingerprint file carries fields this plugin does not write, so it was ' +
    'not written by this plugin. ' +
    fingerprintTwoExits,
  'unreadable-file':
    'The fingerprint file exists and could not be read — check its permissions ' +
    'and the permissions of the directory holding it, and once it is readable ' +
    'again the check runs normally with no further action needed. If fixing ' +
    'permissions is not an option right now: ' +
    fingerprintTwoExits,
});

/**
 * The fingerprint exists and cannot be used.
 *
 * **Thrown by exactly one caller, and before any write: `openRecord`'s session
 * gate, at the read that precedes the chain-instance comparison.** An unusable
 * fingerprint used to be treated as behaviourally identical to an absent one —
 * proceed, rewrite, report — on the reasoning that an absent fingerprint must
 * never refuse, since that is the state every existing project is in on its
 * first run. The flaw in that reasoning is that absence and corruption are not
 * the same evidence: absence says nothing has happened yet, and corruption says
 * something already has — a hand-edit, a merge conflict, a half-written file
 * from a process that died mid-write — and any of those can just as easily have
 * happened to the *chain* the fingerprint exists to guard. Proceeding past that
 * is the silent continue this sub-feature exists to close, so this class is now
 * the record layer's second refusal, alongside `ChainInstanceChangedError`:
 * named by `because`, with a remedy per cause, and every one of those remedies
 * resolves to the two exits that refusal already names.
 */
export class RecordFingerprintUnreadableError extends Error {
  readonly code = 'TRON_RECORD_FINGERPRINT_UNREADABLE' as const;

  constructor(
    readonly file: string,
    readonly because: FingerprintUnreadableCause,
  ) {
    super(
      `The chain fingerprint in ${file} cannot be used ` +
        `(${because}).\n\n${fingerprintRemedies[because]}`,
    );
    this.name = 'RecordFingerprintUnreadableError';
  }
}

/**
 * The three remedy tables, exported as data so a test reads the tables rather
 * than restating them — the same reason the seam exports its slot matrix.
 */
export const recordRemedyTables = Object.freeze({
  location: locationRemedies,
  address: addressRemedies,
  fingerprint: fingerprintRemedies,
});
