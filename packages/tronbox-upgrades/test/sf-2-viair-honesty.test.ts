import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { srcDir } from './helpers/locate';

/**
 * SF-2's **INV-47** — `viaIR` is recorded as untested, never as refuted or tested.
 *
 * INV-47 was adopted with its own instrument marked *specified, not yet written*,
 * because at the time `src/validation-input/` did not exist and the scan had an
 * empty subject. The directory exists now, so the scan is written here rather than
 * left as a specification.
 *
 * **This is the one scan in SF-2's territory that reads raw text, comments
 * included, and that is deliberate:** the obligation *is* about prose. Everywhere
 * else in this package an AST scan is mandatory, because SF-0 and SF-1 both found
 * greps that fired on the comment explaining the hazard they were checking for
 * (`test/helpers/source-scan.ts:6-33` records that history). Here the comment is
 * the subject.
 *
 * **Territory.** `src/validation-input/**` only — INV-47 scopes to that directory,
 * SF-2's artifact and SF-2's docs. The repository contains exactly two live
 * `viaIR: true` settings outside `node_modules/` and `artifacts/`, at
 * `packages/hardhat-tron-upgrades/hardhat.config.cjs:15` and
 * `packages/hardhat-tron-upgrades/examples/BoxUpgrades/hardhat.config.cjs:37`.
 * Neither carries the word *untested* and **neither is a violation**: they are in a
 * different package, and they are configuration *values* rather than claims — a
 * compiler flag asserts nothing about the TVM wasm's memory ceiling, so there is
 * nothing for the word to qualify. This scan must never be widened to reach them.
 *
 * **Why the obligation exists.** `evidence/probe-wasm-memory-ceiling.js` measured
 * the optimizer half of the ceiling claim (profile P1, optimizer off, last N that
 * compiled 360; P2, optimizer on, 160) and **skipped P3, the `viaIR` profile, for
 * budget**. P2's first failure was a *timeout* rather than an out-of-bounds access,
 * so even P1-versus-P2 is not mechanism-identical. So `viaIR` is **untested, not
 * refuted**, in either direction, and reversal is one flag on a persisted probe:
 * `node evidence/probe-wasm-memory-ceiling.js --profiles=P3`.
 */

const territory = path.join(srcDir, 'validation-input');

function sourceFilesUnder(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFilesUnder(full);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });
}

/** The property, as one predicate, so the assertion and the self-test share it. */
function offendingLines(text: string): string[] {
  return text
    .split('\n')
    .filter(line => line.includes('viaIR') && !line.includes('untested'));
}

describe('SF-2 INV-47: viaIR is recorded as untested', () => {
  it('has a non-empty subject, so the scan is not vacuous', () => {
    expect(fs.existsSync(territory)).toBe(true);
    expect(sourceFilesUnder(territory).length).toBeGreaterThan(0);
  });

  it('discriminates a claim from a qualified claim', () => {
    // The instrument's own check. Without it a scan whose predicate had been
    // broken would pass for as long as the directory happened to mention nothing,
    // which is indistinguishable from the property holding.
    expect(offendingLines('the ceiling moves with viaIR, measured.')).toEqual([
      'the ceiling moves with viaIR, measured.',
    ]);
    expect(
      offendingLines("viaIR's effect on the ceiling is untested."),
    ).toEqual([]);
    expect(offendingLines('nothing about the optimizer here')).toEqual([]);
  });

  it('finds no unqualified viaIR claim in src/validation-input', () => {
    const violations = sourceFilesUnder(territory).flatMap(file =>
      offendingLines(fs.readFileSync(file, 'utf8')).map(
        line => `${path.relative(srcDir, file)}: ${line.trim()}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it('does not reach outside its declared territory', () => {
    // The table in INV-47 exists because the first person to run this scan
    // repo-wide would otherwise believe it found two violations and "fix" them by
    // writing `untested` into two hardhat configs, where the word would be
    // meaningless. Pinning the root keeps that from being a judgement call.
    expect(path.basename(territory)).toBe('validation-input');
    expect(path.dirname(territory)).toBe(srcDir);
  });
});
