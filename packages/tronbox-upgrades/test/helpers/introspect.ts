/**
 * Structural introspection over a resolved composite.
 *
 * Two modes, and the distinction matters.
 *
 * {@link serializedTree} walks the composite *after* `toJSON` redaction, so all
 * **five** deliberately exposed host handles (`scheduling.deployer`,
 * `artifacts.intercept`, `chain.tronWrap`, `output.logger`,
 * `receipts.waitForTransactionReceipt`) appear as the redaction marker instead of
 * as objects. That is the right view for the handle-sealing rule's and the
 * credential-redaction guarantee's sweeps: a live `deployer` reaches the
 * `Config` — and from there a configured `privateKey` — by enumerable
 * traversal, and so does a live `ResolverIntercept`, so an unredacted walk
 * would report a violation for exposures the handle-sealing rule explicitly
 * permits.
 *
 * {@link reachableObjects} walks live object identities with an explicit stop
 * set, for the aliasing assertions that need identity rather than shape.
 */

export function serializedTree(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : (JSON.parse(json) as unknown);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every property key appearing anywhere in a parsed JSON tree. */
export function collectKeys(tree: unknown): readonly string[] {
  const keys: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!isPlainRecord(node)) {
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      keys.push(key);
      visit(child);
    }
  };
  visit(tree);
  return keys;
}

/** Every string value appearing anywhere in a parsed JSON tree. */
export function collectStrings(tree: unknown): readonly string[] {
  const strings: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (isPlainRecord(node)) {
      for (const child of Object.values(node)) {
        visit(child);
      }
    }
  };
  visit(tree);
  return strings;
}

export interface LeafEntry {
  readonly path: string;
  readonly value: unknown;
}

/** Dotted paths to every primitive leaf of a parsed JSON tree. */
export function collectLeaves(tree: unknown, prefix = ''): readonly LeafEntry[] {
  const leaves: LeafEntry[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isPlainRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    leaves.push({ path, value: node });
  };
  visit(tree, prefix);
  return leaves;
}

export interface ReachableObject {
  readonly path: string;
  readonly value: object;
}

/**
 * Live object identities reachable by own enumerable properties, stopping at any
 * value in `stopAt` and never following functions.
 */
export function reachableObjects(
  root: unknown,
  stopAt: ReadonlySet<unknown> = new Set(),
): readonly ReachableObject[] {
  const found: ReachableObject[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (seen.has(node) || stopAt.has(node)) {
      return;
    }
    seen.add(node);
    found.push({ path, value: node });
    for (const [key, child] of Object.entries(node)) {
      visit(child, path === '' ? key : `${path}.${key}`);
    }
  };
  visit(root, '');
  return found;
}

/**
 * Every dotted path at which `target` is reachable from `root` by **own enumerable**
 * properties, up to `maxDepth` segments.
 *
 * This is the definition behind the handle-sealing rule's reachability
 * column, and the reason it is path-based rather than identity-based.
 * {@link reachableObjects} carries one global `seen` set, which is right for
 * aliasing assertions and wrong for counting routes:
 * on a real host graph `config.networks` and `config._values.networks` are the *same
 * object*, so a global visited set reports whichever route it reaches first and
 * structurally cannot observe the other. That is why `real-tronbox.test.ts` could
 * only ever assert a lower bound before this helper existed — the earlier `>= 2` was
 * weaker than the fact, not wrong.
 *
 * Cycles are cut per path rather than globally, so the traversal terminates without
 * losing a route that revisits a shared object along a different path. Measured cost
 * on a real `Deployer` at `maxDepth` 6: ~120 node visits.
 */
export function ownEnumerableRoutes(
  root: unknown,
  target: string,
  maxDepth: number,
): readonly string[] {
  const found: string[] = [];
  const visit = (
    node: unknown,
    at: string,
    depth: number,
    ancestors: ReadonlySet<unknown>,
  ): void => {
    if (typeof node === 'string') {
      if (node === target) {
        found.push(at);
      }
      return;
    }
    if (node === null || typeof node !== 'object' || ancestors.has(node)) {
      return;
    }
    if (depth >= maxDepth) {
      return;
    }
    const next = new Set(ancestors).add(node);
    for (const [key, value] of Object.entries(node)) {
      visit(value, at === '' ? key : `${at}.${key}`, depth + 1, next);
    }
  };
  visit(root, '', 0, new Set());
  return found;
}

/** The shallowest route's segment count, or `undefined` when there is none. */
export function shallowestRouteDepth(
  routes: readonly string[],
): number | undefined {
  return routes.length === 0
    ? undefined
    : Math.min(...routes.map(route => route.split('.').length));
}

/** Own enumerable keys, sorted — for stable slot-shape assertions. */
export function sortedOwnKeys(value: object): readonly string[] {
  return Object.keys(value).sort();
}

/**
 * The credential-redaction guarantee's subject: what the seam **projects**,
 * with the host handles it deliberately exposes (per the handle-sealing
 * rule) dropped rather than serialized.
 *
 * The third view, and it exists because the other two cannot express this
 * invariant. {@link serializedTree} runs `toJSON`, so it only ever tests the
 * *backstop*; a live traversal tests the handle-sealing rule's exposure, not
 * the credential-redaction guarantee's subject. This one identifies handle
 * members the way the implementation defines them — a key
 * whose position in the slot's own `toJSON` output holds `redactionMarker`, since
 * `handles.ts:sealSlot` is the only producer of that string — drops exactly those
 * keys, and keeps **every other value live and by reference**.
 *
 * That last property is what makes the result safe to hand to `util.inspect`: the
 * redaction is never applied to a retained value, so a projected field aliasing a
 * host object is still fully reachable in the output. Only the handles
 * themselves are gone, which is precisely the scoping the credential-redaction
 * guarantee states.
 */
export function projectedSurface(
  value: unknown,
  redactionMarker: string,
  seen: Set<unknown> = new Set(),
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[cycle]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => projectedSurface(item, redactionMarker, seen));
  }

  const toJSON = (value as { toJSON?: unknown }).toJSON;
  const redacted =
    typeof toJSON === 'function'
      ? (toJSON.call(value) as Record<string, unknown>)
      : undefined;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (redacted !== undefined && redacted[key] === redactionMarker) {
      // A host handle: the handle-sealing rule governs it, and the
      // credential-redaction guarantee explicitly does not range over the
      // graph reachable through it.
      continue;
    }
    out[key] = projectedSurface(child, redactionMarker, seen);
  }
  return out;
}
