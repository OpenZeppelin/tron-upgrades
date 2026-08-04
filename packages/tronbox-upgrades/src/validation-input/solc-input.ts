import type { SolcInput, SolcOutput } from '@openzeppelin/upgrades-core';

import type { CompilerConfiguration } from '../environment';

/**
 * The solc standard-JSON boundary: the two record shapes SF-2 hands its
 * consumers, and the assembly of the input.
 *
 * **The output type is upgrades-core's own `SolcOutput`, not a local copy.** It is
 * literally the parameter type of `validate(solcOutput, decodeSrc, solcVersion,
 * solcInput)`, so aliasing it means a produced record is assignable at the
 * consumer boundary by construction rather than by inspection. A local
 * re-declaration would be a second shape to keep in step with an upstream one,
 * which is the drift the *"deliberately the shape Hardhat's build-info hands
 * upgrades-core"* requirement exists to avoid.
 */
export type SolcStandardOutput = SolcOutput;

/** One solc diagnostic, narrowed to the two fields SF-2 reads. */
export interface SolcDiagnostic {
  /**
   * solc also emits `'info'` on newer compilers; upstream's own type declares
   * only these two, and SF-2 only ever asks whether a diagnostic is an `error`,
   * so a wider value is read as "not an error" — which is correct.
   */
  readonly severity: 'error' | 'warning' | string;
}

/**
 * The input SF-2 constructs.
 *
 * Pinned assignable to upstream's `SolcInput` by {@link _InputIsUpstreamShaped}
 * below, so `validate`'s fourth argument and `solcInputOutputDecoder`'s first
 * accept it without a cast.
 */
export interface SolcStandardInput {
  readonly language: 'Solidity';
  /** INV-39: the *only* place Solidity source text exists in this sub-feature. */
  readonly sources: Readonly<Record<string, { readonly content: string }>>;
  readonly settings: SolcStandardSettings;
}

export type SolcStandardSettings = Readonly<Record<string, unknown>> & {
  readonly outputSelection: Readonly<Record<string, Record<string, string[]>>>;
};

type AssertTrue<T extends true> = T;
type _InputIsUpstreamShaped = AssertTrue<
  SolcStandardInput extends SolcInput ? true : false
>;

/**
 * TronBox's own `outputSelection`, reproduced verbatim.
 *
 * Clone `src/components/Compile/index.js:71-94` at `v4.9.0` — `'': ['ast']` at
 * `:78` plus exactly ten contract-level outputs at `:80-89`, and **`storageLayout`
 * is not among them**. That single omission is the whole reason this sub-feature
 * exists, and it cannot be fixed through config because the literal comes *after*
 * the user-settings spread — `...settings` at `:75` and `outputSelection:` at
 * `:76` on `v4.9.0`, `:76` and `:77` on `v4.8.0`, read at both tags this stage —
 * so the host overwrites a user-supplied `outputSelection` rather than merely
 * declining to extend it.
 */
const HOST_CONTRACT_OUTPUTS = [
  'abi',
  'evm.bytecode.object',
  'evm.bytecode.sourceMap',
  'evm.bytecode.linkReferences',
  'evm.deployedBytecode.object',
  'evm.deployedBytecode.sourceMap',
  'evm.deployedBytecode.linkReferences',
  'evm.deployedBytecode.immutableReferences',
  'evm.methodIdentifiers',
  'metadata',
] as const;

/**
 * The one thing SF-2 adds to what the host would have sent (INV-28).
 *
 * F-6 is the measurement the whole ruling rests on: with TronBox's exact
 * selection versus that selection plus this entry, `evm.bytecode.object`,
 * `evm.deployedBytecode.object` **and** `metadata` all come back byte-identical,
 * because `outputSelection` is not a member of solc metadata. Sanity-checked in
 * the same probe against `optimizer`, which *is* in metadata and changes both —
 * so this is a property of `outputSelection` specifically and not of the compiler
 * ignoring settings. `evidence/probe-recompile-fidelity.js` §1.
 */
const STORAGE_LAYOUT_OUTPUT = 'storageLayout';

function outputSelection(): Record<string, Record<string, string[]>> {
  return {
    '*': {
      '': ['ast'],
      '*': [...HOST_CONTRACT_OUTPUTS, STORAGE_LAYOUT_OUTPUT],
    },
  };
}

/**
 * Assembles the standard-JSON input for one partition.
 *
 * **The settings arrive as the seam's frozen copy and are neither mutated nor
 * normalized** (INV-28). `CompilerConfiguration.settings` is
 * `Object.freeze(structuredClone(value))` (`src/environment/compiler.ts:349-366`),
 * so an attempted mutation throws in strict mode instead of silently reaching the
 * user's next `tronbox compile`. Nothing here "helpfully" enables the optimizer
 * either: F-6 measured that `optimizer` *is* in solc metadata, so touching it
 * changes both bytecode hashes and makes the staleness gate fire on every
 * correctly built project with a remedy that cannot help.
 *
 * `outputSelection` is placed **after** the spread, reproducing the host's own
 * precedence, so a user-configured `outputSelection` is overwritten here exactly
 * as TronBox overwrites it. That is not a liberty: if the plugin honoured a
 * user's selection where the host does not, the recompile would no longer be the
 * host's compile plus one entry, and F-6's byte-identity would not transfer.
 */
export function buildSolcInput(
  sources: Readonly<Record<string, string>>,
  compiler: Pick<CompilerConfiguration, 'settings'>,
): SolcStandardInput {
  const contents: Record<string, { readonly content: string }> = {};
  for (const [key, content] of Object.entries(sources)) {
    contents[key] = { content };
  }

  return {
    language: 'Solidity',
    sources: contents,
    settings: {
      ...compiler.settings,
      outputSelection: outputSelection(),
    },
  };
}

/**
 * The `error`-severity diagnostic count, which is all cause 11 ever carries.
 *
 * Never the text: solc's error strings are unbounded and
 * routinely carry absolute filesystem paths, and the host already renders them in
 * its own channel.
 */
export function countErrorDiagnostics(output: SolcStandardOutput): number {
  const diagnostics: readonly SolcDiagnostic[] = output.errors ?? [];
  return diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    .length;
}
