import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from './helpers/locate';

/*
 * Publication hygiene — nothing a reader of the published package cannot resolve.
 *
 * ## Why this is a test and not a checklist
 *
 * The property is easy to state and was violated four times in a row while it was
 * enforced by hand: each pass swept the hits it had already found instead of
 * re-deriving them from the rule, declared the tree clean, and left members of the
 * same family behind. The pattern list below IS the rule, executed. A completion
 * claim is now worth what this file is worth, rather than what the last ad-hoc
 * grep was worth.
 *
 * ## The rule
 *
 * A reference is internal leakage when **resolving it requires something outside
 * the published repository** — a private planning document, that document's
 * revision history, or an approval authority the reader cannot consult. A
 * reference is fine when the repository itself answers it, however terse it is.
 *
 * That distinction is what admits `cause 7` (enumerated in
 * `src/validation-input/causes.ts`, so a reader can look it up) and rejects
 * `Decision 13` (a numbered entry in a document that does not ship).
 *
 * ## What this file deliberately does NOT check
 *
 * The repository carries private **identifier schemes** in its comments, and by
 * the rule above every one of them is leakage: `INV-4` resolves only in a
 * document that is not published. They are reported rather than banned because
 * removing them is a repository-wide rename — a structural decision, not a
 * hygiene fix — and mechanizing a ban here would pre-empt it. Measured across
 * `src/`, `test/` and `docs/`:
 *
 * | scheme  | references | files |
 * |---------|-----------:|------:|
 * | `INV-n` |      1,712 |   102 |
 * | `SF-n`  |        709 |    99 |
 * | `SC-n`  |         32 |    16 |
 * | `D-n`   |         27 |    14 |
 * | `F-n`   |         25 |     9 |
 * | `CD-n`  |         10 |     6 |
 * | `FX-n`  |          9 |     1 |
 * | `DEV-n` |          5 |     4 |
 *
 * plus nine bare labels of the form `C3`, `G4`, `P4`, and `T1` — of which the
 * `P<n>` group names probe profiles that the citing file defines inline, and `T1`
 * is an address fixture.
 *
 * What IS checked is that the set of schemes does not **grow**: a ninth prefix
 * would be a new private vocabulary entering the published tree, and that is a
 * decision rather than an accident.
 */

/** Case-insensitive bans: the wording carries the leak whatever its capitalization. */
const INSENSITIVE: ReadonlyArray<readonly [string, RegExp]> = [
  ['an approval authority the reader cannot consult', /\bunratifi|\bratifi/i],
  ["a private decision-maker's ruling", /the dev.s (ruling|decision|call)|the dev has/i],
  ['the stage that produced the code', /\bthis stage\b/i],
  ['a numbered entry in a private document', /\bdecision [0-9]+/i],
  ["a private document's revision history", /\brevision[- ][0-9]/i],
  ['a private decision record', /decisions?-[0-9]|\bdecision record\b/i],
  [
    'a stage-document filename',
    /\b0[0-9]-(specify|research|design|invariants|code-draft|tests|docs)\b/i,
  ],
];

/**
 * Case-sensitive bans. Capitalization is the whole signal for these: *the design*
 * is the shape of the code and resolves in the repository; *Design* is a document
 * that does not ship. Folding case would forbid ordinary English.
 */
const SENSITIVE: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'a pipeline stage cited as an authority',
    /(Research|Design|Invariants) (measured|established|claimed|gave|declared|listed|specified|predicted|sent|revision)/,
  ],
  ['a correction addressed to a stage document', /Corrects (the )?Design|correction to Design/],
  [
    'a pipeline stage named as a place or an owner',
    /Code Draft|SF-[0-9]+ (Design|Research|Invariants|Tests|Docs)|\b(Docs|Tests|Design|Research|Invariants) stages?\b/,
  ],
  [
    'a numbered private tension or open question',
    /\bTension [0-9]|\bOpen Question\b|\bopen question [0-9]/,
  ],
  ['an absolute path on the author machine', /\/Users\//],
];

/** Prefixes that are public standards, not this project's private vocabulary. */
const PUBLIC_PREFIXES: readonly string[] = ['ERC', 'EIP', 'UTF'];

/** Every private scheme in the tree today. A ninth is a decision, not a slip. */
const PRIVATE_PREFIXES: readonly string[] = [
  'CD',
  'D',
  'DEV',
  'F',
  'FX',
  'INV',
  'SC',
  'SF',
];

const SELF = 'publication-hygiene.test.ts';

interface Publishable {
  readonly relative: string;
  readonly text: string;
}

function collect(): readonly Publishable[] {
  const found: Publishable[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        continue;
      }
      if (!/\.(ts|js|md)$/.test(entry.name)) continue;
      found.push({
        relative: path.relative(packageRoot, full),
        text: fs.readFileSync(full, 'utf8'),
      });
    }
  };
  for (const top of ['src', 'test', 'docs']) walk(path.join(packageRoot, top));
  return found;
}

/**
 * `matchingLines` rather than a boolean, because a failure has to name the line.
 * A scan that only reports *which file* is one a maintainer deletes instead of
 * fixing.
 */
function matchingLines(text: string, pattern: RegExp): readonly string[] {
  return text
    .split('\n')
    .map((line, index) => [index + 1, line] as const)
    .filter(([, line]) => pattern.test(line))
    .map(([number, line]) => `${number}: ${line.trim()}`);
}

describe('publication hygiene: every reference resolves inside the published repo', () => {
  const all = collect();

  /*
   * The subject is asserted before anything is asserted *about* it. A walk that
   * silently returned nothing — a renamed directory, a changed extension set —
   * would make every ban below pass while measuring no file at all, which is the
   * exact "green for the wrong reason" shape the rest of this suite exists to
   * refuse.
   */
  it('ranges over the whole published tree, and says so by counting it', () => {
    expect(all.length).toBeGreaterThan(100);
    for (const top of ['src', 'test', 'docs']) {
      expect(
        all.filter(file => file.relative.startsWith(`${top}${path.sep}`)).length,
        `${top}/ contributed no file`,
      ).toBeGreaterThan(0);
    }
  });

  /*
   * This file quotes every banned pattern, so it must exempt itself — and the
   * exemption is pinned at exactly one file. An exemption that could widen is how
   * a scan stops covering the thing it was written for.
   */
  it('exempts itself and nothing else', () => {
    const exempt = all.filter(file => file.relative.endsWith(SELF));
    expect(exempt).toHaveLength(1);
  });

  const scanned = all.filter(file => !file.relative.endsWith(SELF));

  it.each([...INSENSITIVE, ...SENSITIVE])(
    'carries no reference to %s',
    (_what, pattern) => {
      const offenders = scanned.flatMap(file =>
        matchingLines(file.text, pattern).map(line => `${file.relative}:${line}`),
      );
      expect(offenders).toEqual([]);
    },
  );

  it('introduces no ninth private identifier scheme', () => {
    const prefixes = new Set<string>();
    for (const file of scanned) {
      for (const match of file.text.matchAll(/\b([A-Z]{1,3})-[0-9]+\b/g)) {
        const prefix = match[1] as string;
        if (!PUBLIC_PREFIXES.includes(prefix)) prefixes.add(prefix);
      }
    }
    // Sorted set equality, not a size check: a scheme swapped for a new one keeps
    // the count and changes the vocabulary, which is the case worth catching.
    expect([...prefixes].sort()).toEqual([...PRIVATE_PREFIXES]);
  });
});
