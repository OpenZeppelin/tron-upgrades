import type { SolcInput, SolcOutput } from '@openzeppelin/upgrades-core';

/**
 * The solc standard-JSON boundary: the two record shapes the validation
 * pipeline hands its consumers.
 *
 * **Nothing is assembled here any more.** This module used to build the solc
 * input from the contracts directory; under the Foundry model the input a
 * consumer receives is the paired `<hash>.json` compiler input TronBox wrote
 * next to the build record — the exact input that produced the output beside
 * it — narrowed at the pipeline's gate. Reconstructing it from the current
 * contracts directory was the wrong-span hazard (ex-M2): source text on disk
 * can drift from what was compiled while the bytecode still verifies, and a
 * consumer decoding AST spans against drifted text reads the wrong characters.
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

/**
 * The input the validation pipeline hands its consumers — the shape the paired
 * `<hash>.json` file is narrowed to before anything reads it.
 *
 * Pinned assignable to upstream's `SolcInput` by {@link _InputIsUpstreamShaped}
 * below, so `validate`'s fourth argument and `solcInputOutputDecoder`'s first
 * accept it without a cast.
 */
export interface SolcStandardInput {
  readonly language: 'Solidity';
  /** The *only* place Solidity source text exists in this sub-feature. */
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
