/**
 * The plugin's silencing control.
 *
 * `silenced` is the one module-scope mutable binding in `src/options/**`,
 * `src/output/**` and `src/results/**`. The only other one in the three
 * directories is `engine.ts`'s re-entrancy guard, which this allowance
 * enumerates as the single permitted addition. Two of them and the audit is
 * no longer a list.
 *
 * Why process-global rather than per-channel: `silenceWarnings()` is
 * called at migration top level — before any operation, and therefore before any
 * channel exists — so a per-channel flag cannot be reached by the call that is
 * supposed to set it. Upstream's control is process-global for the same reason.
 * The coarse consequence is stated rather than discovered: a `silenceWarnings()`
 * in migration 1 stays in effect for migrations 2..n of the same `tronbox
 * migrate` process, and across every migration of the full replay `tronbox test`
 * forces on each run.
 */
let silenced = false;

/**
 * Suppresses the plugin's advisory writes for the life of the process.
 *
 * Mirrors `@openzeppelin/upgrades-core`'s exported `silenceWarnings` in name and
 * in scope, but is backed by this package's own flag rather than by calling
 * it — a recorded divergence from the parity target. Four reasons, all
 * verified against
 * `@openzeppelin/upgrades-core@1.46.0` as installed: upstream's flag is a
 * module-level `let silenced` in `dist/utils/log.js` that is never exported,
 * never readable and never resettable; flipping it silences every other consumer
 * of the same resolved module copy, so behaviour depends on npm hoisting;
 * upstream's own farewell notice is written with `console.error`, which bypasses
 * TronBox's `--quiet` entirely; and with `captureEngineWarnings` in place
 * upstream never writes to the terminal anyway.
 *
 * **What this suppresses and what it cannot:** the flag gates emission
 * and nothing else. It never suppresses a `recorded` append, never suppresses a
 * thrown error, and never suppresses the engine-warning capture — so failures and
 * degraded-mode statements are unaffected by silencing.
 *
 * **Upstream's farewell notice is deliberately not mirrored**, which narrows
 * the divergence recorded above — it does not extend to "its one-time
 * farewell notice". At call time there is no
 * channel to carry it — that is the whole reason the flag is process-global — and
 * writing it to `console` is forbidden outright, because TronBox injects
 * the real `console` into the migration sandbox, so such a write would ignore
 * `--quiet`. The safety information the notice exists to protect is not lost: it
 * warns a user who silenced to re-check their unsafe flags, and this
 * control never suppresses a `DegradedNote`, so every reduced-fidelity statement
 * still reaches the caller on the operation's result.
 */
export function silenceWarnings(): void {
  silenced = true;
}

/**
 * Read by the channel's emitter and by nothing else — the flag must be
 * read at exactly one place in the package, so that "silencing gates emission
 * only" is structural rather than reviewed. Read at emission time, never captured
 * at construction time, so a channel created before the call and one created
 * after it behave identically.
 */
export function isSilenced(): boolean {
  return silenced;
}

/**
 * Test-only. Clears the flag, which is otherwise monotonic for the life of the
 * process.
 *
 * **Not re-exported from `output/index.ts` and not from the package entry
 * point.** It is reachable only by deep import (`src/output/silence`) and used
 * only by this package's own tests — the same shape as the Hardhat sibling's
 * `src/utils/namespaced.ts:setNamespacedWarningSink`. It exists because the flag
 * is process-global and the test suite is not; it carries no compatibility
 * promise.
 */
export function resetSilenceForTests(): void {
  silenced = false;
}
