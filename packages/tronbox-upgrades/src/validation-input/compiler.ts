/**
 * The one declaration of the supported compiler range, and the gate that reads
 * it.
 *
 * **This module used to own a whole compiler lifecycle — locate, load, wrap,
 * retire — and no longer does.** The Foundry-model decision (2026-08-07)
 * removed the embedded compiler entirely: validation reads the build record
 * TronBox already wrote and never invokes solc. What survives is the range,
 * because the range was never about running a compiler — it gates which solc
 * **output** this plugin interprets. The build record was produced by the
 * project's compiler, and this plugin's reading of that output (ASTs, layouts
 * when TronBox can emit them) is verified only across the declared range.
 *
 * **The host is reproduced, never called.** The version comparison below is
 * TronBox's own, cloned, because the question it answers is *"would TronBox
 * consider this version above its ceiling"* — and the host's own answer to an
 * invalid version is `process.exit(1)` (clone `src/components/TronSolc.js:84`,
 * `:92`, `:118` at `v4.9.0`), which is exactly what this plugin must not do.
 */

/**
 * The declared range, declared **once**. Both the gate and the message
 * read it, so the range cannot drift out of sync with the check.
 *
 * **The floor is a plugin claim, not a compiler capability.** `0.5.13` is the
 * version where the TVM registry's builds begin emitting `storageLayout`, as
 * measured against the registry, and that is still the mechanical boundary — but it is
 * the boundary of the *compiler's* capability, and declaring it as the *plugin's*
 * would publish a support claim nothing measured: no probe ran upgrades-core
 * against sub-0.8 compiler output, `@openzeppelin/contracts-upgradeable` has
 * required `^0.8.0` since v4.0, and 12 of the registry's 35 builds are in this
 * range. `0.8.0` also subsumes the mechanical boundary, so the silent-omission
 * hazard measured directly — a sub-0.5.13 compiler accepting a `storageLayout`
 * request with zero diagnostics and simply omitting the key — is unreachable
 * from inside the declared range.
 *
 * **The ceiling is the host's**: clone `src/components/TronSolc.js:9` is
 * `const maxVersion = '0.8.26'` and `:87-93` exits above it, verified at `v4.9.0`
 * and `v4.8.0`. It is *not* a formality under `--evm`, because `:87` reads
 * `compareVersions(compilerVersion, maxVersion) > 0 && !options.evm`, so
 * `0.8.27`–`0.8.29` become reachable there. Those are refused with the same
 * message, because they are equally untested.
 *
 * **The `0.8.26` ceiling is also the base-slot guard.** Raising it past
 * `0.8.28` admits Solidity's `layout at` custom base slots, but upstream's
 * without-storage-layouts comparison drops `baseSlot` (openzeppelin-upgrades#1296):
 * `unfoldStorageLayout` rebuilds both layouts without `baseSlot`, so
 * both missing values normalize to the zero slot, so normalized
 * `0x0 === 0x0` passes and a changed custom base slot can be missed.
 * Do not raise this ceiling without a base-slot comparison guard unless the
 * upstream fix has shipped; `test/baseslot-canary.test.ts` fails the day it does.
 */
export const SUPPORTED_SOLC = { min: '0.8.0', max: '0.8.26' } as const;

/**
 * The host's own version comparison, reproduced.
 *
 * Clone `src/components/TronSolc.js:11-25`: split on `.`, compare numerically,
 * treat missing parts as `0`. Reproduced rather than replaced by a semver library
 * because the question this answers is *"would TronBox consider this version above
 * its ceiling"*, and answering it differently than the host does is how a plugin
 * misreads which compiler the artifacts were built with.
 */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const l = leftParts[index] ?? 0;
    const r = rightParts[index] ?? 0;
    if (l > r) {
      return 1;
    }
    if (l < r) {
      return -1;
    }
  }
  return 0;
}

/** Clone `src/components/TronSolc.js:27-29`. */
function isVersionTriple(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/**
 * The gate. A version, never a probe.
 *
 * A version that is not a triple is out of range too — it is not a version the
 * host would accept either, and the remedy is the same one: name a version inside
 * the range. The host's answer to it is `process.exit(1)`, which is exactly what
 * this plugin must not do.
 */
export function isSupportedSolcVersion(version: string): boolean {
  return (
    isVersionTriple(version) &&
    compareVersions(version, SUPPORTED_SOLC.min) >= 0 &&
    compareVersions(version, SUPPORTED_SOLC.max) <= 0
  );
}
