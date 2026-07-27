// `erc7201:` and `trc7201:` hash the namespace id WITHOUT the prefix, so the
// same id under both prefixes is one storage slot. upgrades-core keys
// namespaces by the full annotation string, so it sees two namespaces and
// misses the overlap; this scan catches it before validation runs.
const SLOT_EQUIVALENT_PREFIXES = ['erc7201:', 'trc7201:'] as const;

export function canonicalNamespaceId(storageLocation: string): string {
  for (const p of SLOT_EQUIVALENT_PREFIXES) {
    if (storageLocation.startsWith(p)) return `erc7201:${storageLocation.slice(p.length)}`;
  }
  return storageLocation;
}

interface NamespaceDecl {
  storageLocation: string;
  contractName: string;
  structName: string;
}

// Mirrors upgrades-core's NatSpec parsing, which is not re-exported from its
// entrypoint: the tag's arguments run to the next `@tag`. Zero or several
// arguments is malformed — return undefined so core raises its own error
// rather than this scan masking it with different wording.
function storageLocationOf(node: any): string | undefined {
  const doc = node?.documentation;
  const text: string = typeof doc === 'string' ? doc : (doc?.text ?? '');
  if (!/^\s*@custom:storage-location(\s|$)/m.test(text)) return undefined;
  const args: string[] = [];
  for (const match of text.matchAll(
    /^\s*@custom:storage-location(?<args>(?:(?!^\s*@\w+)[^])*)/gm,
  )) {
    const trimmed = (match.groups?.args ?? '').trim();
    if (trimmed.length > 0) args.push(...trimmed.split(/\s+/));
  }
  return args.length === 1 ? args[0] : undefined;
}

// The target contract's inheritance chain (most-derived first), read from the
// PRIMARY output AST: annotations are identical in the namespaced recompile and
// the primary is always present, so collisions surface even in AST-only fallback.
function* linearizedContractDefs(buildInfo: any, fqName: string): Generator<any> {
  const separator = fqName.lastIndexOf(':');
  const sourceName = fqName.slice(0, separator);
  const contractName = fqName.slice(separator + 1);

  const byId = new Map<number, any>();
  for (const source of Object.values<any>(buildInfo?.output?.sources ?? {})) {
    for (const node of source?.ast?.nodes ?? []) {
      if (node.nodeType === 'ContractDefinition') byId.set(node.id, node);
    }
  }
  const target = (buildInfo?.output?.sources?.[sourceName]?.ast?.nodes ?? []).find(
    (node: any) => node.nodeType === 'ContractDefinition' && node.name === contractName,
  );
  if (target === undefined) return;
  for (const id of target.linearizedBaseContracts ?? []) {
    const def = byId.get(id);
    if (def !== undefined) yield def;
  }
}

export function assertNoNamespaceSlotCollisions(buildInfo: any, fqName: string): void {
  const byCanonicalId = new Map<string, NamespaceDecl>();
  for (const def of linearizedContractDefs(buildInfo, fqName)) {
    for (const node of def.nodes ?? []) {
      if (node.nodeType !== 'StructDefinition') continue;
      const loc = storageLocationOf(node);
      if (loc === undefined) continue;
      const id = canonicalNamespaceId(loc);
      const prev = byCanonicalId.get(id);
      if (prev === undefined) {
        byCanonicalId.set(id, {
          storageLocation: loc,
          contractName: def.name,
          structName: node.name,
        });
        continue;
      }
      // Identical strings are upgrades-core's own duplicate-namespace case.
      if (prev.storageLocation !== loc) {
        throw new Error(
          `Namespaces '${prev.storageLocation}' (${prev.contractName}.${prev.structName}) and ` +
            `'${loc}' (${def.name}.${node.name}) resolve to the same storage slot ` +
            '(the prefix is not part of the hash). Use a distinct namespace id.',
        );
      }
    }
  }
}
