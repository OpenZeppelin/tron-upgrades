import { expect } from 'chai';
import { storageLocationOf } from '../src/utils/namespace-prefix';

// storageLocationOf (src/utils/namespace-prefix.ts) hand-mirrors the NatSpec
// parsing upgrades-core applies to `@custom:storage-location`, because core
// does not re-export it from its package entrypoint. A hand-mirrored parser
// can silently drift from upstream on a core bump (different regex, a
// tightened/loosened separator rule, a changed multi-arg policy, ...), and
// nothing in the type system would catch it. This test pins the two parsers
// against each other across a wide table of annotation shapes so any future
// drift fails loudly here instead of surfacing as a missed or wrongly
// collision-checked namespace in production.

// A minimal StructDefinition-shaped AST node — the only part either parser
// reads is `documentation`, which solc emits as a raw string in some solc
// versions and as a `{ text }` NatSpec node in others.
interface MinimalStructNode {
  nodeType: 'StructDefinition';
  name: string;
  documentation?: string | { text: string };
}

const SHAPES: ReadonlyArray<{ label: string; node: MinimalStructNode }> = [
  {
    label: 'erc7201, space separator, string doc',
    node: { nodeType: 'StructDefinition', name: 'S1', documentation: '@custom:storage-location erc7201:example.plain' },
  },
  {
    label: 'trc7201, space separator, string doc',
    node: { nodeType: 'StructDefinition', name: 'S2', documentation: '@custom:storage-location trc7201:example.plain' },
  },
  {
    label: 'erc7201, space separator, {text} object doc',
    node: { nodeType: 'StructDefinition', name: 'S3', documentation: { text: '@custom:storage-location erc7201:example.objdoc' } },
  },
  {
    label: 'trc7201, space separator, {text} object doc',
    node: { nodeType: 'StructDefinition', name: 'S4', documentation: { text: '@custom:storage-location trc7201:example.objdoc' } },
  },
  {
    label: 'tab separator after tag (malformed upstream: reads as zero args)',
    node: { nodeType: 'StructDefinition', name: 'S5', documentation: '@custom:storage-location\terc7201:example.tab' },
  },
  {
    label: 'tab separator, {text} object doc (malformed)',
    node: { nodeType: 'StructDefinition', name: 'S6', documentation: { text: '@custom:storage-location\ttrc7201:example.tabobj' } },
  },
  {
    label: 'newline separator, arg on its own line (malformed)',
    node: { nodeType: 'StructDefinition', name: 'S7', documentation: '@custom:storage-location\nerc7201:example.newline' },
  },
  {
    label: 'zero args, bare tag (malformed)',
    node: { nodeType: 'StructDefinition', name: 'S8', documentation: '@custom:storage-location' },
  },
  {
    label: 'zero args, trailing space only (malformed)',
    node: { nodeType: 'StructDefinition', name: 'S9', documentation: '@custom:storage-location ' },
  },
  {
    label: 'two args on one line (malformed)',
    node: { nodeType: 'StructDefinition', name: 'S10', documentation: '@custom:storage-location erc7201:a erc7201:b' },
  },
  {
    label: 'arg followed by another @custom: tag (accepted)',
    node: {
      nodeType: 'StructDefinition',
      name: 'S11',
      documentation: '@custom:storage-location erc7201:example.followed\n@custom:oz-upgrades-unsafe-allow delegatecall',
    },
  },
  {
    label: 'multiline documentation, annotation mid-text (accepted)',
    node: {
      nodeType: 'StructDefinition',
      name: 'S12',
      documentation: '@notice Some description\nspanning multiple lines\n@custom:storage-location erc7201:example.midtext\n@dev trailing note',
    },
  },
  {
    label: 'no documentation at all (property omitted)',
    node: { nodeType: 'StructDefinition', name: 'S13' },
  },
  {
    label: 'empty-string doc',
    node: { nodeType: 'StructDefinition', name: 'S14', documentation: '' },
  },
  {
    label: 'empty-string doc, {text} object',
    node: { nodeType: 'StructDefinition', name: 'S15', documentation: { text: '' } },
  },
  {
    label: 'near-miss tag: @custom:storage-locations',
    node: { nodeType: 'StructDefinition', name: 'S16', documentation: '@custom:storage-locations erc7201:example.nearmiss' },
  },
  {
    label: 'near-miss tag: @custom:storage',
    node: { nodeType: 'StructDefinition', name: 'S17', documentation: '@custom:storage erc7201:example.nearmiss2' },
  },
  {
    label: 'leading whitespace before tag (accepted)',
    node: { nodeType: 'StructDefinition', name: 'S18', documentation: '   @custom:storage-location erc7201:example.leadingws' },
  },
  {
    label: 'trailing whitespace after arg (accepted)',
    node: { nodeType: 'StructDefinition', name: 'S19', documentation: '@custom:storage-location erc7201:example.trailingws   ' },
  },
  {
    label: 'CRLF line endings (accepted)',
    node: { nodeType: 'StructDefinition', name: 'S20', documentation: '@custom:storage-location erc7201:example.crlf\r\n@notice x' },
  },
  {
    label: 'duplicate annotation lines, same value (malformed: two args)',
    node: {
      nodeType: 'StructDefinition',
      name: 'S21',
      documentation: '@custom:storage-location erc7201:example.dup\n@custom:storage-location erc7201:example.dup',
    },
  },
  {
    label: 'duplicate annotation lines, different value (malformed: two args)',
    node: {
      nodeType: 'StructDefinition',
      name: 'S22',
      documentation: '@custom:storage-location erc7201:a\n@custom:storage-location erc7201:b',
    },
  },
  {
    label: 'annotation not at start of line (undefined: tag unrecognized)',
    node: { nodeType: 'StructDefinition', name: 'S23', documentation: 'Some text @custom:storage-location erc7201:example.notatstart' },
  },
  {
    label: 'double space separator (accepted)',
    node: { nodeType: 'StructDefinition', name: 'S24', documentation: '@custom:storage-location  erc7201:example.doublespace' },
  },
  {
    label: 'tag glued to a suffix, no boundary (undefined: tag unrecognized)',
    node: { nodeType: 'StructDefinition', name: 'S25', documentation: '@custom:storage-locationX erc7201:example.glued' },
  },
  {
    label: 'annotation preceded by blank lines (accepted)',
    node: { nodeType: 'StructDefinition', name: 'S26', documentation: '\n\n@custom:storage-location erc7201:example.blanklines' },
  },
  {
    label: 'arg followed by an indented continuation line (malformed: continuation counts as extra args)',
    node: { nodeType: 'StructDefinition', name: 'S27', documentation: '@custom:storage-location erc7201:example.cont\n   continued text' },
  },
  {
    label: 'trc7201 with tab separator (malformed)',
    node: { nodeType: 'StructDefinition', name: 'S28', documentation: '@custom:storage-location\ttrc7201:example.trctab' },
  },
];

describe('storageLocationOf vs @openzeppelin/upgrades-core parsing (differential)', function () {
  let coreParse: (node: MinimalStructNode) => string | undefined;

  before(function () {
    // Deep-require: getStorageLocationAnnotation is core's internal function
    // for this exact job and is not re-exported from the package entrypoint.
    // If a core version bump relocates or renames it, this require throws —
    // that IS the drift alarm this test exists to raise, so it must fail
    // loudly here rather than this suite silently skipping.
    let mod: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('@openzeppelin/upgrades-core/dist/storage/namespace.js');
    } catch (e: any) {
      throw new Error(
        'Could not deep-require getStorageLocationAnnotation from ' +
          "'@openzeppelin/upgrades-core/dist/storage/namespace.js'. A core version bump likely " +
          'relocated or renamed this parser — update the deep-require path in ' +
          'test/storage-location-parser-differential.test.ts and re-verify that storageLocationOf ' +
          `in src/utils/namespace-prefix.ts still mirrors its behavior. Original error: ${e?.message}`,
      );
    }
    if (typeof mod?.getStorageLocationAnnotation !== 'function') {
      throw new Error(
        "'@openzeppelin/upgrades-core/dist/storage/namespace.js' no longer exports " +
          'getStorageLocationAnnotation as a function. This is the drift alarm this test exists to ' +
          'raise — update test/storage-location-parser-differential.test.ts to match core\'s new shape.',
      );
    }
    coreParse = mod.getStorageLocationAnnotation;
  });

  it('agrees with core on every annotation shape: same value when core accepts, undefined exactly when core throws', function () {
    const mismatches: string[] = [];
    for (const { label, node } of SHAPES) {
      let expected: string | undefined;
      try {
        expected = coreParse(node);
      } catch {
        // Core's malformed-annotation error is the "reject" signal: storageLocationOf
        // must decline to parse it too, rather than accepting something core would not.
        expected = undefined;
      }
      const actual = storageLocationOf(node);
      if (actual !== expected) {
        mismatches.push(`${label}: core=${JSON.stringify(expected)} storageLocationOf=${JSON.stringify(actual)}`);
      }
    }
    expect(mismatches, `Divergences from upgrades-core parsing:\n${mismatches.join('\n')}`).to.deep.equal([]);
  });
});
