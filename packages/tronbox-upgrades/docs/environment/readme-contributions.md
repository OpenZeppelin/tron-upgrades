# README contributions from the environment seam

**This is source material, not the README itself.** It is the environment seam's share of the
package README that the consumer end-to-end harness assembles and proves followable — prose
fragments held here with each claim's evidence attached, so the assembled page inherits claims
that were verified where they were written.

## Why the environment seam contributes no quickstart

README quickstart / options / divergence content belongs to the sub-features that own
the operations. The environment seam has **no public consumer API**: it is an internal seam
whose only entry point, `resolveEnvironment`, is consumed by sibling modules and is not
re-exported from the package. Packaging owns the package entry point.

Writing a quickstart here would mean inventing the call a user makes, and that call runs
through the deploy/upgrade operations, whose shape is **the deploy seam's to settle** —
specifically how the deployer enters the public API. Two tests assert something narrower and
more useful: that nothing at this layer presupposes a deployer, so the deploy seam stays free
to decide. So the environment seam contributes the **environment, compatibility, divergence
and troubleshooting** material a README needs, and no usage example.

Everything below is user-observable. Nothing below depends on the deploy seam's or the
option/result surface's undecided contracts.

---

## Fragment 1 — Requirements

> **TronBox 4.8.0 or 4.9.0.** The plugin is verified against both, in-process, against the
> tool's own `Config`, `Deployer` and `Resolver`.
>
> **TypeScript 5.0 or later**, if you consume the plugin's types. Below 5.0 the plugin still
> runs, but its compile-time guarantees silently weaken rather than failing loudly.

**Evidence.** `test/real-tronbox.test.ts` runs the full drift canary against
`node_modules/tronbox-4.9.0` and `node_modules/tronbox-4.8.0`. The TypeScript floor is set by
requiring `const` type parameters; the package declares `typescript: ^5.7.0`.

> ⚠️ **For the consumer end-to-end harness and the validation ladder:** do **not** publish
> `peerDependencies.tronbox`'s current value as the supported range. It is `>=4.0.0`, which the
> evidence contradicts, and setting the real range belongs to the validation ladder. The seam
> quotes whatever it finds in the manifest and never compares against it, so the value in an
> error message is not a tested compatibility claim.

---

## Fragment 2 — Where the plugin works

> The plugin needs capabilities that TronBox injects into a migration's sandbox, and TronBox
> injects different sets in different commands. What is available where:
>
> | | `tronbox migrate` | `tronbox test` (migrations) | `tronbox test` (mocha files) | `tronbox console` |
> |---|---|---|---|---|
> | Project paths | ✅ | ✅ | ✅ | — |
> | Network configuration | ✅ | ✅ | ✅ | — |
> | Artifact resolution | ✅ | ✅ | ✅ | — |
> | Chain access | ✅ | ✅ | ✅ | ✅ |
> | Transaction receipts | ✅ | ✅ | ✅ | — |
> | Deployment scheduling | ✅ | ✅ | — | — |
> | Log output | ✅ | ✅ | — | — |
>
> Run outside any TronBox command — plain `node` — and the plugin reports
> `TRONBOX_ENV_ABSENT` rather than failing obscurely.

**Evidence.** `src/environment/slots.ts:slotRequirements`. Render the table from that constant
rather than copying it; the plugin's own error messages already do.

> ⚠️ **For the consumer end-to-end harness:** whether `tronbox test` mocha files are in v1
> scope is not yet decided by the deploy seam and is not settled here. The column states what
> the seam can supply there; it does not promise the plugin supports that context. Confirm
> before publishing the column.

---

## Fragment 3 — Deliberate divergences from TronBox

Four places the plugin behaves differently from the tool it runs inside. Each is intentional,
each is user-visible, and the first is the one users will notice.

### 3a. A network name that is not in `networks` is an error

> If the `--network` you select has no entry in your `tronbox.js` `networks` map, the plugin
> refuses with a named error listing the networks you did configure.
>
> TronBox itself does not. It silently substitutes a complete set of defaults —
> `feeLimit: 1000000000`, `userFeePercentage: 100`, `originEnergyLimit: 10000000` — so a
> misspelled network name produces a plausible, entirely fictional configuration and the
> migration proceeds against it. An empty config reaches that state with no error at all,
> because TronBox defaults to `network: "development"` with `networks: {}`.
>
> The plugin is stricter here on purpose: for an upgrade, silently using default transaction
> parameters against the wrong network is worse than stopping.

**Evidence.** `build/components/Config.js:Config`'s `network_config` getter throws only when
the selected network is *falsy*; an absent name yields
`_.extend({}, default_tx_values, self.networks[network] || {})`. Defaults from
`build/components/TronWrap/constants.js:deployParameters`. Verified on 4.9.0 and 4.8.0.
Enforced by `src/environment/network.ts:assertSelectedNetworkIsConfigured`.

### 3b. `network_id` may be a number, but not a falsy one

> `network_id: 1` and `network_id: '1'` are both accepted and behave identically — TronBox's
> own canonical form is the string, and it does that coercion itself.
>
> `network_id: 0` is refused, while `network_id: '0'` is accepted. That asymmetry is TronBox's,
> not the plugin's: the tool gates on truthiness and refuses a numeric `0` one step before the
> plugin sees it. The plugin reproduces the tool's behaviour rather than accepting a
> configuration the tool then rejects.
>
> `network_id: '*'` is legal and is never resolved to a concrete id — again matching TronBox.

**Evidence.** `build/components/Contract/contract.js:setNetwork` does
`this.network_id = network_id + ""`; `build/lib/environment.js:Environment.detect` gates on
`if (!network_id)` and runs on `migrate`, `test` and `console` alike. Implemented at exactly
two call sites through `src/environment/network.ts:normalizeNetworkId`.

### 3c. Configure transaction parameters in camelCase

> Use `feeLimit`, `userFeePercentage`, `originEnergyLimit`, `callValue`, `tokenValue`,
> `tokenId`. The snake_case spellings (`fee_limit`, `consume_user_resource_percent`,
> `call_value`) are documented by TronBox as fallbacks, but in practice they almost never take
> effect: TronBox merges its own truthy defaults in first, and those short-circuit the
> fallback. A project configuring only `fee_limit: 456` gets `1000000000`.
>
> Separately, a parameter you configure as `0` reads back as unset, because TronBox resolves
> these through `||` chains.

**Evidence.** `config.feeLimit` is `network_config.feeLimit || network_config.fee_limit`, and
`deployParameters` injects a truthy `feeLimit: 1e9` — so the injected default satisfies the
`||` and the snake_case spelling is never consulted. Measured against the tool rather than read
off the config schema, which is the point: from the schema alone the fallback looks effective.

### 3d. `build_info_directory` must stay inside the project

> The plugin refuses a `build_info_directory` resolved outside your project root.
> `contracts_build_directory` may legally point outside it — that is how `tronbox test` uses a
> temporary build tree — but the build-info directory may not.

**Evidence.** `src/environment/paths.ts:projectPathValues`;
`build/lib/commands/test.js` is the legitimate external-build-tree case.

---

## Fragment 4 — Limitations

> **Under `tronbox test`, contract-name collision detection is unavailable.** TronBox does not
> write build-info output in that command, so the plugin cannot tell whether a bare contract
> name is unique across your project. It says so rather than assuming — this is reported, never
> silent — and proceeds with reduced verification.
>
> **Plugin output may be discarded, and not only under `--quiet`.** TronBox replaces the log
> channel with a no-op under `--quiet` and `--silent`, and passes a no-op throughout
> `tronbox test`. Anything the plugin needs you to know is therefore in the value it returns or
> in the error it throws, never only in a log line.
>
> **A permission error on a packaged artifact is reported as "not found."** If the plugin
> cannot load a JSON artifact from `node_modules` because the path is unreadable, the message
> says the file does not exist. Check permissions if the file is where you expect it.
>
> **The `from` address in your config is not necessarily the sender.** TronBox chooses the
> effective account at send time, and on a local TRE node it replaces the account list
> wholesale. Do not treat a passing authority check against `from` as proof the transaction
> will send from that account.
>
> **Path containment is tested on POSIX only.** Windows behaviour is unverified.

**Evidence, in order.** The ambiguity report's own `indeterminate` status, reported as a
routine state rather than a rare fallback, and `ArtifactAmbiguityReport`; the logger's
single-method guarantee, substituted with a no-op at
`build/lib/commands/migrate.js:command.run` and `build/lib/test.js`;
`src/environment/ambiguity.ts:defaultExists` using the stat-class `fs.existsSync` probe, a
deliberate choice whose cost is recorded; `TronWrap._getAccounts` and `NonAuthoritativeSender`,
wrapped so the caveat cannot be skipped at a call site; and for the last, the absence of
any Windows case in the path-containment suite — a declared limit of what was tested, not an
assumption that the behaviour holds.

---

## Fragment 5 — Troubleshooting

> Environment failures carry a stable `code`. Switch on that, not on the message text.
>
> | `code` | Means | First thing to check |
> |---|---|---|
> | `TRONBOX_ENV_ABSENT` | The plugin was called outside a TronBox command | Run through `tronbox migrate` or `tronbox test`, not plain `node` |
> | `TRONBOX_ENV_INCOMPLETE` | A capability the operation needs is unavailable here | The message names the capability and the commands that provide it |
> | `TRONBOX_ENV_INCONSISTENT` | Two views of your configuration disagree | Usually a hand-built harness pairing objects from different migrations |
>
> `TRONBOX_ENV_INCOMPLETE` messages name the exact configuration property that was missing or
> that raised, and list the commands where the capability exists. They also quote the plugin's
> declared TronBox range.

**Evidence.** `src/environment/errors.ts`; the three-member family is fixed and
`UnsatisfiedSlot` carries `providedIn` / `absentIn` from the slot table.

---

## What the environment seam does *not* contribute

- **A quickstart, or any usage example.** No public API exists at this layer, and the shape of
  the one that will is the deploy seam's to settle.
- **Options documentation.** The plugin's own option surface (`kind`, `unsafeAllow`, and kin)
  is the deploy seam's and the validation ladder's.
- **Parity divergences from the Hardhat-plugin target.** The environment seam implements no
  operation, so it has no operation to diverge. The documented per-operation divergence list
  belongs to the operation-owning sub-features.
- **Result-shape or warning-channel documentation.** Belongs to the option/result surface, and
  its contract is not yet settled.
- **Installation and packaging.** Belongs to packaging.
