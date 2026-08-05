import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { srcDir } from './helpers/locate';

/*
 * The entry module's static value-closure must never reach the validation
 * engine.
 *
 * The engine's record layer reads its location once, at module scope, and a
 * later configuration is a silent no-op — so an entry point that loads the
 * engine at import time puts every subsequent record write in the wrong place
 * with no diagnostic. The rule is stated in `src/index.ts`'s own header; this
 * file is what makes it structural: the closure is recomputed from disk on
 * every run, so an operation wired in later with a static engine-reaching
 * import fails here by name instead of shipping.
 *
 * Type-only imports are exempt because they are erased at compile time — the
 * scan follows only imports that survive into the emitted module graph.
 */

const ENGINE = '@openzeppelin/upgrades-core';

interface ModuleEdges {
  /** Relative in-src targets of value (non-type-only) imports and re-exports. */
  readonly internal: readonly string[];
  /** True when the module value-imports the engine directly. */
  readonly reachesEngine: boolean;
}

function valueEdges(filePath: string): ModuleEdges {
  const sourceFile = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const internal: string[] = [];
  let reachesEngine = false;

  const consider = (specifier: string, typeOnly: boolean): void => {
    if (typeOnly) {
      return;
    }
    if (specifier === ENGINE || specifier.startsWith(`${ENGINE}/`)) {
      reachesEngine = true;
      return;
    }
    if (specifier.startsWith('.')) {
      internal.push(specifier);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      // `import './x'` (no clause) executes the module: a value edge.
      const typeOnly = clause !== undefined && clause.isTypeOnly;
      consider(node.moduleSpecifier.text, typeOnly);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      consider(node.moduleSpecifier.text, node.isTypeOnly);
    }
    // Dynamic `import(...)` is deliberately NOT an edge: deferring the engine
    // behind one is exactly the sanctioned pattern.
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { internal, reachesEngine };
}

function resolveInternal(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    `${base}.ts`,
    path.join(base, 'index.ts'),
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : undefined,
  ]) {
    if (candidate !== undefined && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Every file reachable from `entry` through value imports, plus offenders. */
function valueClosure(entry: string): {
  visited: readonly string[];
  engineReachers: readonly string[];
} {
  const visited = new Set<string>();
  const engineReachers: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const edges = valueEdges(file);
    if (edges.reachesEngine) {
      engineReachers.push(path.relative(srcDir, file));
    }
    for (const specifier of edges.internal) {
      const target = resolveInternal(file, specifier);
      if (target !== undefined) {
        queue.push(target);
      }
    }
  }
  return { visited: [...visited], engineReachers };
}

describe('the entry point never loads the engine at import time', () => {
  const entry = path.join(srcDir, 'index.ts');

  it('has an empty engine-reaching set in its static value-closure', () => {
    const { visited, engineReachers } = valueClosure(entry);
    // The subject is asserted before the property: an entry whose closure is
    // one file proves the type-only exports were recognised as erased, not
    // that the scan went nowhere — index.ts itself must always be in it.
    expect(visited.length).toBeGreaterThanOrEqual(1);
    expect(engineReachers).toEqual([]);
  });

  it('non-vacuity: the scan reports the module the rule exists for', () => {
    // `options/resolve.ts` holds the one static value import of the engine in
    // `src/` today (`output/engine.ts` and the record layer already defer
    // theirs) — measured, and asserted so the scan cannot rot into one that
    // recognises nothing as engine-reaching.
    expect(
      valueEdges(path.join(srcDir, 'options', 'resolve.ts')).reachesEngine,
      `options/resolve.ts should register as engine-reaching`,
    ).toBe(true);
    // And the closure walk finds them from a synthetic entry that re-exports
    // one, proving the edge-following half rather than only the leaf check.
    const closure = valueClosure(path.join(srcDir, 'options', 'resolve.ts'));
    expect(closure.engineReachers).toContain(path.join('options', 'resolve.ts'));
  });

  it('non-vacuity: a type-only re-export is exempt and a value re-export is an edge', () => {
    const dir = fs.mkdtempSync(path.join(srcDir, '..', 'closure-fixture-'));
    try {
      const engineful = path.join(dir, 'engineful.ts');
      fs.writeFileSync(
        engineful,
        `import { withValidationDefaults } from '${ENGINE}';\nexport const v = withValidationDefaults;\n`,
      );
      fs.writeFileSync(
        path.join(dir, 'value-entry.ts'),
        `export { v } from './engineful';\n`,
      );
      fs.writeFileSync(
        path.join(dir, 'type-entry.ts'),
        `export type { v } from './engineful';\n`,
      );
      expect(
        valueClosure(path.join(dir, 'value-entry.ts')).engineReachers,
      ).toHaveLength(1);
      expect(
        valueClosure(path.join(dir, 'type-entry.ts')).engineReachers,
      ).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
