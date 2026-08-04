# The deployment record

Two files, three address spellings, and one refusal you need to understand before you delete
anything.

This page is about **what you see on disk and in error messages**, not about an API. The record
layer is package-internal — the plugin's operations reach it, you do not — so there is nothing here
to import. What there *is*, is a second file next to your manifest, a stricter view of what counts
as the same address, and a refusal that stops a run before it touches either file.

---

## The two files

After a state-changing operation on a network the plugin does not have a well-known name for, your
project has:

```
.openzeppelin/
  unknown-3448148188.json           ← the deployment record (the manifest)
  unknown-3448148188.instance.json  ← the chain-instance fingerprint
```

The first is the manifest you already know: which proxies exist, which implementations they point
at, which admin owns them. The second is new, and it exists because of a problem the manifest alone
cannot see.

### Why the fingerprint exists

A local TRON node can be **wiped and restarted while keeping the same chain id**. Nothing in the
chain id changes, nothing in the manifest changes — and yet every contract the manifest describes
is gone. The next upgrade would then be computed against a record of deployments that no longer
exist.

So the fingerprint records two values that a wipe *does* change: the genesis block's hash and the
first block's hash. Before any operation touches the record, the plugin reads them back and
compares. If they diverge, it **refuses, before writing anything**.

The fingerprint holds four keys and nothing else — a schema number, the chain id, and the two
hashes. No endpoint, no credential, no host configuration. If you open it and find anything else,
that file did not come from this plugin.

---

## The refusal, and the mistake to avoid

When the fingerprint diverges you get a refusal naming **both** files and telling you that removing
one of them is not a reset.

That warning is the important part, because the intuitive move is wrong:

> **Deleting the fingerprint on its own resets nothing.** It does not restore the old chain and it
> does not make the record correct — it only stops the check from running. Afterwards nothing can
> tell a cleared fingerprint from a first run, so the guard is silently off and the stale manifest
> is treated as authoritative.

If the node really was replaced and you want a clean start, remove **both** files. If you did not
expect the node to have changed, do not delete anything yet — a diverging fingerprint on a network
you believed stable is worth understanding before it is erased.

### A corrupt fingerprint is reported, not ignored

If the file is unreadable, hand-edited into an unparseable shape, or carries a field that is
present but not a hash, the plugin treats it as **no usable record**, rewrites it, and **says so**.
It does not proceed silently. A silently ignored corrupt fingerprint would be the worst of both
worlds: the guard appears to be on, and it is not.

---

## Addresses: three spellings, one identity

TRON addresses appear in three encodings, and all three refer to the same twenty bytes:

| form | looks like |
|---|---|
| base58check | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |
| TRON hex (21 bytes) | `41…` followed by 40 hex digits |
| EVM-style hex | `0x…` followed by 40 hex digits |

The deployment record is looked up by **exact string equality**. So without normalisation, writing
a proxy in one spelling and looking it up in another would report *no such proxy* — and the plugin
would offer to deploy a second one beside the first.

Every address therefore passes through one conversion before it reaches the record, and **the
result of that conversion is checked again rather than trusted.** That second check is not
belt-and-braces: the underlying conversion accepts input that is not an address at all and hands
back a string anyway. Trusting it is how a non-address ends up written into a manifest, where
nothing will ever match it again.

### Why your address might be refused

Five distinct reasons, each with its own remedy in the message:

1. **Unrecognised encoding** — it matches none of the three forms. A contract *name* lands here; if
   you meant to name a contract, that argument is the wrong one for it.
2. **base58 checksum** — the shape is right and the checksum does not verify. Usually a
   transcription slip: one wrong character.
3. **Wrong length** — the right alphabet, the wrong number of characters. A truncated copy-paste.
4. **Wrong prefix byte** — 21 hex bytes that do not begin with TRON's fixed `41`. Often an
   Ethereum address with a `41` prefix bolted on by hand.
5. **Post-conversion shape** — the subtle one. The encoding *was* recognised, and the value inside
   it still was not an address. **A mixed-case `0x…` address whose capitalisation asserts a checksum
   that does not hold lands here** — the string is well-formed, and its own spelling says it is
   wrong.

The refusal echoes **your input, unmodified**. That is deliberate: a normalised echo would hide the
very typo you need to find.

---

## Ordering guarantees

Two properties worth knowing, because they determine what a failed run leaves behind:

- **The fingerprint is written before the manifest**, via write-to-temp-then-rename. A partial
  fingerprint file is never observable — you either see the previous one or the new one.
- **A refusal happens before any write.** A run that refuses leaves both files **byte-unchanged**.
  You can re-run it, inspect it, or walk away, and nothing has moved.

## What the plugin will not do

**It never deletes a stale entry from your record.** If a stored deployment no longer matches the
chain, that is reported per entry, and removing it stays your decision. A tool that silently pruned
your deployment history to make its own bookkeeping tidy would be trading your audit trail for its
convenience.
