import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { environmentSrcDir, packageRoot, srcDir } from './locate';

/**
 * AST-based source scanning for SF-0's *absence* invariants — INV-20, 28, 30,
 * 31, 32, 38, 39, 43, 44, 47, and **INV-49**.
 *
 * Deliberately not regex over raw text. Half of the forbidden identifiers
 * (`process`, `network_config`, `_values`, `console`, `Promise`) appear in the
 * seam's own doc comments, which explain the upstream mechanisms the absences
 * exist to avoid — so a text grep would report a violation for every comment
 * that documents one. Stripping comments with a regex is worse: `artifacts.ts`
 * contains the literal `/^\.\//` whose text includes `//`, so a naive
 * line-comment strip eats the rest of that line.
 *
 * **INV-49 turned that preference into a requirement.** The corrected
 * `errors.ts:declaredTronBoxRange` comment contains the literal strings
 * `require.resolve('tronbox')` and `require('tronbox/package.json')` — as prose
 * explaining why the seam does *not* do that. So a grep for a host specifier
 * returns two hits in the one file whose comment documents the hazard, and the
 * first person the scan fires on would be right to revert it.
 * `inv-49-host-import-boundary.test.ts` asserts that difference directly rather
 * than trusting this note.
 *
 * The TypeScript compiler is already a devDependency, so parsing is free and the
 * result distinguishes a value reference from a comment, a type position, and a
 * property name.
 *
 * SF-11 owns the packaged version of these checks (INV-28, INV-47, INV-49); this
 * module is SF-0 proving its own side now rather than deferring every absence to a
 * sub-feature that has not been built.
 */

export interface IdentifierUse {
  readonly name: string;
  /** True when the identifier is the `b` of `a.b` — not a value reference. */
  readonly isPropertyName: boolean;
  /** True when the identifier appears in a type annotation, not in emitted code. */
  readonly inTypePosition: boolean;
}

export interface TopLevelConst {
  readonly name: string;
  /** `undefined` for `declare const` with no initializer. */
  readonly initializerKind: string | undefined;
  readonly text: string;
  readonly isDeclare: boolean;
}

/**
 * A module specifier written as a static string, with the syntax that carries it.
 *
 * INV-49's subject. `importSpecifiers` was enough for the invariants that only
 * needed to know whether `util` or `fs` was imported, but INV-49 forbids the host
 * *by any path*, so every syntax that names a module has to be collected —
 * `require`, `require.resolve`, `import()` and `import x = require()` included.
 */
export interface ModuleSpecifier {
  readonly specifier: string;
  readonly kind:
    | 'import'
    | 'export-from'
    | 'import-equals'
    | 'require'
    | 'require-resolve'
    | 'dynamic-import';
  /** 1-based, for a failure message that points at the line. */
  readonly line: number;
  /**
   * `true` when the specifier is erased at compile time — `import type …`, or an
   * import whose every named binding is individually `type`-marked.
   *
   * **Added by SF-1, and it closes a real hole in INV-49's pin.**
   * `src/chain/index.ts:15` is `import type { EthereumProvider } from
   * '@openzeppelin/upgrades-core'`, and without this field the pinned allow-list
   * row rendered it as `(import)` — indistinguishable from a **runtime** import of
   * the same specifier. So the row that was added to record a type-only import
   * would also have silently admitted a future value import of upgrades-core from
   * that module, which INV-48 forbids ("`src/chain/**` may import
   * `src/environment/**` and upgrades-core **types** only"). A pin that cannot
   * tell the permitted case from the forbidden one is not pinning the invariant it
   * was added for.
   */
  readonly typeOnly: boolean;
}

/**
 * A `require(…)` / `import(…)` / `require.resolve(…)` whose argument is **not** a
 * string literal.
 *
 * The completeness clause for INV-49's scan, and the reason the invariant is
 * checkable at all: a computed specifier is invisible to any static scan, so the
 * scan's guarantee is only as strong as the absence of these. Zero of them plus
 * zero host specifiers is a proof; zero host specifiers alone is not.
 */
export interface DynamicSpecifierSite {
  readonly kind: 'require' | 'require-resolve' | 'dynamic-import';
  readonly expression: string;
  readonly line: number;
}

export interface ScannedSource {
  readonly file: string;
  readonly relative: string;
  readonly text: string;
  readonly identifiers: readonly IdentifierUse[];
  /** Dotted access chains as written, e.g. `deployer.options.options`. */
  readonly accessChains: readonly string[];
  readonly stringLiterals: readonly string[];
  /** Array literals whose every element is a string, joined with `,`. */
  readonly stringArrayLiterals: readonly string[];
  /** String-literal keys passed to `readOwnProperty` / `readProperty`. */
  readonly readPropertyKeys: readonly string[];
  /**
   * The source text of every `${…}` expression in a template literal.
   *
   * INV-40's primary mechanism is structural — "a host handle never reaches a
   * formatter" — and template interpolation is the formatter the invariant's own
   * violation scenario names (`logger.log(\`resolved: ${env.output}\`)`). The
   * `toJSON` backstop is invisible to it, so this is the one channel a
   * serialization sweep provably cannot cover.
   */
  readonly templateExpressions: readonly string[];
  readonly importSpecifiers: readonly string[];
  /** Every statically written module specifier, in every syntax (INV-49). */
  readonly moduleSpecifiers: readonly ModuleSpecifier[];
  /** Every module-loading call whose specifier is computed rather than literal. */
  readonly dynamicSpecifierSites: readonly DynamicSpecifierSite[];
  readonly topLevelConsts: readonly TopLevelConst[];
  readonly topLevelMutableBindings: readonly string[];
  readonly hasAsyncModifier: boolean;
  readonly hasAwaitExpression: boolean;
}

function listTypeScriptFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function accessChainText(node: ts.PropertyAccessExpression): string {
  const parts: string[] = [node.name.text];
  let current: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current)) {
    parts.unshift(current.text);
  } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
    parts.unshift('this');
  }
  return parts.join('.');
}

/**
 * Whether an import declaration is fully erased at compile time.
 *
 * Three cases, and the second is the one a naive `clause.isTypeOnly` check misses:
 *
 * - `import type { X } from 'm'` — `isTypeOnly` on the clause.
 * - `import { type X, type Y } from 'm'` — no clause-level flag; every *element* is
 *   marked, and TypeScript still erases the specifier. Treating this as runtime
 *   would make the pin fire on a legitimate import.
 * - no import clause at all (`import 'm'`) — a side-effect import, which is the most
 *   runtime an import can be.
 */
function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name !== undefined) {
    // A default binding is a value binding.
    return false;
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) {
    // `import * as ns from 'm'` is a value namespace.
    return false;
  }
  return (
    bindings.elements.length > 0 &&
    bindings.elements.every(element => element.isTypeOnly)
  );
}

/** The `export … from 'm'` mirror of {@link isTypeOnlyImportClause}. */
function isTypeOnlyExportClause(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  const clause = node.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) {
    return false;
  }
  return (
    clause.elements.length > 0 &&
    clause.elements.every(element => element.isTypeOnly)
  );
}

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      ts.isTypeNode(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeParameterDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function scanSource(
  text: string,
  file: string,
  relative: string,
): ScannedSource {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const moduleSpecifiers: ModuleSpecifier[] = [];
  const dynamicSpecifierSites: DynamicSpecifierSite[] = [];

  const recordSpecifierArgument = (
    node: ts.CallExpression,
    kind: 'require' | 'require-resolve' | 'dynamic-import',
  ): void => {
    const argument = node.arguments[0];
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
      moduleSpecifiers.push({
        specifier: argument.text,
        kind,
        line: lineOf(node),
        // `require`, `require.resolve` and `import()` all load at runtime; none has
        // a type-only form.
        typeOnly: false,
      });
      return;
    }
    dynamicSpecifierSites.push({
      kind,
      expression:
        argument === undefined ? '<no argument>' : argument.getText(sourceFile),
      line: lineOf(node),
    });
  };

  const identifiers: IdentifierUse[] = [];
  const accessChains: string[] = [];
  const stringLiterals: string[] = [];
  const stringArrayLiterals: string[] = [];
  const readPropertyKeys: string[] = [];
  const templateExpressions: string[] = [];
  const importSpecifiers: string[] = [];
  let hasAsyncModifier = false;
  let hasAwaitExpression = false;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodSignature(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isEnumMember(parent) && parent.name === node);
      identifiers.push({
        name: node.text,
        isPropertyName,
        inTypePosition: isInTypePosition(node),
      });
    }
    if (ts.isPropertyAccessExpression(node)) {
      accessChains.push(accessChainText(node));
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      stringLiterals.push(node.text);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const elements = node.elements;
      if (
        elements.length > 0 &&
        elements.every(element => ts.isStringLiteral(element))
      ) {
        stringArrayLiterals.push(
          elements.map(element => element.getText(sourceFile)).join(','),
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'readOwnProperty' ||
        node.expression.text === 'readProperty')
    ) {
      const key = node.arguments[1];
      if (key !== undefined && ts.isStringLiteral(key)) {
        readPropertyKeys.push(key.text);
      }
    }
    if (ts.isTemplateSpan(node)) {
      templateExpressions.push(node.expression.getText(sourceFile));
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      importSpecifiers.push(node.moduleSpecifier.text);
      moduleSpecifiers.push({
        specifier: node.moduleSpecifier.text,
        kind: 'import',
        line: lineOf(node),
        typeOnly: isTypeOnlyImportClause(node.importClause),
      });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      importSpecifiers.push(node.moduleSpecifier.text);
      moduleSpecifiers.push({
        specifier: node.moduleSpecifier.text,
        kind: 'export-from',
        line: lineOf(node),
        typeOnly: isTypeOnlyExportClause(node),
      });
    }
    // `import x = require('…')` — the TS-only form, and the one a specifier scan
    // written against `ImportDeclaration` alone misses entirely.
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      moduleSpecifiers.push({
        specifier: node.moduleReference.expression.text,
        kind: 'import-equals',
        line: lineOf(node),
        // `import x = require(…)` always emits a runtime require.
        typeOnly: false,
      });
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        recordSpecifierArgument(node, 'dynamic-import');
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
        recordSpecifierArgument(node, 'require');
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'resolve' &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require'
      ) {
        // `require.resolve` loads nothing, but it is still a dependency on the
        // host's file layout, so INV-49 covers it. Collected as its own kind so a
        // failure message can say which syntax was used.
        recordSpecifierArgument(node, 'require-resolve');
      }
    }
    if (ts.isAwaitExpression(node)) {
      hasAwaitExpression = true;
    }
    if (
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some(
        modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      )
    ) {
      hasAsyncModifier = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  const topLevelConsts: TopLevelConst[] = [];
  const topLevelMutableBindings: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const isConst =
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    const isDeclare = (ts.getModifiers(statement) ?? []).some(
      modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    );
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(sourceFile);
      if (!isConst) {
        topLevelMutableBindings.push(name);
        continue;
      }
      topLevelConsts.push({
        name,
        initializerKind:
          declaration.initializer === undefined
            ? undefined
            : ts.SyntaxKind[declaration.initializer.kind],
        text: declaration.getText(sourceFile),
        isDeclare,
      });
    }
  }

  return {
    file,
    relative,
    text,
    identifiers,
    accessChains,
    stringLiterals,
    stringArrayLiterals,
    readPropertyKeys,
    templateExpressions,
    importSpecifiers,
    moduleSpecifiers,
    dynamicSpecifierSites,
    topLevelConsts,
    topLevelMutableBindings,
    hasAsyncModifier,
    hasAwaitExpression,
  };
}

function scanFile(file: string, rootDir: string): ScannedSource {
  return scanSource(
    fs.readFileSync(file, 'utf8'),
    file,
    path.relative(rootDir, file),
  );
}

/**
 * Scan TypeScript held in a string rather than on disk — for INV-49's fixtures.
 *
 * The fixtures must not be real files under `src/` or `test/`: `tsconfig.test.json`
 * includes both, so a fixture that genuinely imports the host would fail
 * type-checking (the bare name does not resolve at all) and a fixture under `src/`
 * would violate the very invariant it exists to test. Parsing text keeps the
 * fixture next to the assertion that reads it, which is also where a reader looking
 * for "what does a violation look like" will look.
 */
export function scanText(text: string, label: string): ScannedSource {
  return scanSource(text, path.join(packageRoot, label), label);
}

export function scanDirectory(
  dir: string,
  rootDir: string = dir,
): readonly ScannedSource[] {
  return listTypeScriptFiles(dir).map(file => scanFile(file, rootDir));
}

/** Every module in `src/environment/**`. */
export function environmentSources(): readonly ScannedSource[] {
  return scanDirectory(environmentSrcDir, environmentSrcDir);
}

/** Every module under `src/` that is *not* part of the seam (INV-28's subject). */
export function nonEnvironmentSources(): readonly ScannedSource[] {
  return scanDirectory(srcDir, srcDir).filter(
    source => !source.relative.startsWith(`environment${path.sep}`),
  );
}

/** Every module under `src/`, seam included — INV-49's subject, which has no exception. */
export function allSources(): readonly ScannedSource[] {
  return scanDirectory(srcDir, srcDir);
}

/**
 * The ten modules of `src/chain/**` — SF-1's absence invariants' subject.
 *
 * Relative paths are rooted at `src/chain/` rather than at `src/`, so a failure
 * message reads `policy.ts` rather than `chain/policy.ts`. Nine of SF-1's fifty
 * invariants are prohibitions whose enforcement is that a thing is *not there*, and
 * this is what they range over.
 */
export function chainSources(): readonly ScannedSource[] {
  const chainDir = path.join(srcDir, 'chain');
  return scanDirectory(chainDir, chainDir);
}

/**
 * A specifier that names the TronBox host package (INV-49).
 *
 * Deliberately narrower than `/tronbox/`: the plugin's own package is
 * `tronbox-upgrades`, and a pattern that matched it would fire on the day the
 * package imports itself by name and be relaxed for the wrong reason. Matches the
 * bare name and its subpaths, the version-aliased install names the test trees use
 * (`tronbox-4.9.0`, `tronbox-4.8.0/build/…` — the shape a well-meaning "just read
 * the version" edit would actually reach for in this repository), and a future
 * `@tronbox/*` scope.
 */
export const HOST_SPECIFIER = /^(?:@tronbox\/|tronbox(?:$|\/|-\d))/;

/** Host-naming specifiers in one scanned module, in any loading syntax. */
export function hostSpecifiers(
  source: ScannedSource,
): readonly ModuleSpecifier[] {
  return source.moduleSpecifiers.filter(entry =>
    HOST_SPECIFIER.test(entry.specifier),
  );
}

/**
 * The INV-49 violation report over a set of scanned modules: one string per
 * offending site, empty when the invariant holds.
 *
 * Returning renderable strings rather than a boolean is deliberate — the assertion
 * that reads this compares against `[]`, so a failure prints the file, line,
 * syntax and specifier instead of `expected false to be true`.
 */
export function hostImportViolations(
  sources: readonly ScannedSource[],
): readonly string[] {
  return sources.flatMap(source =>
    hostSpecifiers(source).map(
      entry =>
        `${source.relative}:${entry.line} imports the host as ` +
        `'${entry.specifier}' (${entry.kind})`,
    ),
  );
}

export interface TypedInterpolation {
  readonly relative: string;
  /** The `${…}` expression as written. */
  readonly expression: string;
  /** The checker's type for that expression, at that position, after narrowing. */
  readonly type: string;
  /**
   * True when the type renders as a primitive — a string / number / boolean /
   * bigint, a literal or union of those, or a branded primitive such as
   * `AbsolutePath` (`string & { … }`, which interpolates as its string part).
   *
   * False for `unknown`, `any`, and every object type — which is the whole set a
   * host handle can inhabit inside the seam, since INV-25 admits handles as
   * `unknown`.
   */
  readonly isPrimitive: boolean;
}

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike;

function rendersAsPrimitive(type: ts.Type): boolean {
  if (type.isUnion()) {
    // A union renders as a primitive only if every arm does.
    return type.types.every(rendersAsPrimitive);
  }
  if (type.isIntersection()) {
    // A branded primitive: `string & { readonly __brand: … }` renders as the
    // string. One primitive constituent is enough.
    return type.types.some(rendersAsPrimitive);
  }
  return (type.flags & PRIMITIVE_FLAGS) !== 0;
}

let programCache: ts.Program | undefined;

/**
 * The package's own `ts.Program`, built once per test file.
 *
 * Extracted from `typedInterpolations` when INV-49's clause 6 became the second
 * checker-level assertion in the suite. Two independent programs over the same 53
 * files would double the cost of every file that reads both and, worse, would let
 * the two answers be derived from different `tsconfig` readings — so the program is
 * the shared thing and each scan keeps its own projection of it.
 *
 * `tsconfig.json` rather than `tsconfig.test.json` on purpose: the subject of both
 * scans is `src/`, and pulling `test/` into the program would put the suite's own
 * deliberate `createRequire` uses (`sf-10-fixtures.ts:53`, `real-tronbox.test.ts`)
 * inside the range of a scan whose whole claim is about the plugin.
 */
function srcProgram(): ts.Program {
  if (programCache !== undefined) {
    return programCache;
  }
  const configPath = path.join(packageRoot, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, file =>
    fs.readFileSync(file, 'utf8'),
  );
  const parsed = ts.parseJsonConfigFileContent(
    raw.config,
    ts.sys,
    packageRoot,
  );
  programCache = ts.createProgram(parsed.fileNames, parsed.options);
  return programCache;
}

/** The program's own modules under `src/` — no `.d.ts`, no dependency. */
function srcSourceFiles(program: ts.Program): readonly ts.SourceFile[] {
  return program
    .getSourceFiles()
    .filter(
      sourceFile =>
        !sourceFile.isDeclarationFile &&
        sourceFile.fileName.startsWith(srcDir),
    );
}

let interpolationCache: readonly TypedInterpolation[] | undefined;

/**
 * Every `${…}` in `src/environment/**`, with the **type-checker's** verdict on
 * what is being interpolated.
 *
 * This is the one scan in the suite that needs a `ts.Program` rather than a bare
 * parse, and INV-40 is why. Its primary mechanism is structural — "a host handle
 * never reaches a formatter" — and the honest test for that is not a hand-kept
 * deny-list of handle names, which is over-broad (`ambiguity.ts` interpolates a
 * `Dirent`'s `name`, and `network.ts` must never interpolate its `entry`) and
 * under-broad the moment a handle is bound to a fresh local. The property that
 * actually holds is stronger and needs no list: **a host handle enters the seam as
 * `unknown` (INV-25), so every interpolated expression is statically a primitive.**
 * Anything a handle could reach is `unknown` or an object type, and the only way to
 * make it renderable is to pass it through a projection — which is exactly the
 * mechanism.
 *
 * Memoized: the program is built once per test file.
 */
export function typedInterpolations(): readonly TypedInterpolation[] {
  if (interpolationCache !== undefined) {
    return interpolationCache;
  }
  const program = srcProgram();
  const checker = program.getTypeChecker();

  const found: TypedInterpolation[] = [];
  for (const sourceFile of srcSourceFiles(program)) {
    if (!sourceFile.fileName.startsWith(environmentSrcDir)) {
      continue;
    }
    const relative = path.relative(environmentSrcDir, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isTemplateSpan(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        found.push({
          relative,
          expression: node.expression.getText(sourceFile),
          type: checker.typeToString(type),
          isPrimitive: rendersAsPrimitive(type),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  interpolationCache = found;
  return found;
}

/** One argument of a call, with the **checker's** verdict on what it is. */
export interface TypedArgument {
  /** The argument as written. */
  readonly text: string;
  /** The checker's type for it, at that position, after narrowing. */
  readonly type: string;
  /**
   * True when the argument is a plain identifier rather than any expression —
   * a literal, a template, a concatenation and a call are all `false`.
   */
  readonly isIdentifier: boolean;
  /**
   * The `src/`-relative module that declares the argument's type alias, or
   * `undefined` when its type has no symbol declared under `src/` (`string`, a
   * string-literal type, `unknown`).
   *
   * The provenance half of the check, and it is not redundant with {@link type}:
   * `typeToString` renders a *name*, and a local `type AbsolutePath = string`
   * would render identically to the seam's brand while admitting every string.
   */
  readonly typeDeclaredIn: string | undefined;
}

/**
 * A call made **through a `createRequire` product** — anywhere under `src/`,
 * whatever the binding holding it is named.
 *
 * INV-49's clause 6, and the reason it needs a `ts.Program` rather than the bare
 * parse the rest of this module uses. INV-49 bans `createRequire` under `src/`
 * because a call through the *constructed* resolver is invisible to the specifier
 * scan — `recordSpecifierArgument` fires only for a callee spelled literally
 * `require` / `require.resolve` / `import`. One file is exempted
 * (`validation-input/compiler.ts`), so for that file the ban's protection is zero
 * and something has to bound where its resolver can point.
 *
 * **The bound has to be the type, not the spelling.** `AbsolutePath` on
 * `loadCompiler`'s parameter constrains callers, not the body: inside the body the
 * resolver is a general CommonJS resolver in scope, and a text pin on the argument's
 * *name* is satisfied by any binding that happens to be spelled `soljsonPath` —
 * including a nested one shadowing the parameter at type `string`, which is the
 * residual the block that reads this used to record as uncaught.
 *
 * **The resolver type is derived, not named.** `NodeRequire` is not hardcoded here;
 * the type is read off the `createRequire` call site itself and every callee whose
 * type is that same type is a subject. So renaming `runtimeRequire`, passing the
 * resolver to a helper, or invoking `createRequire(__filename)(…)` inline are all
 * still in range — none of which a name-matched scan sees.
 *
 * The one composition this rests on: that `createRequire` is the only way a resolver
 * gets minted under `src/`, which is pinned independently by the `forbidden` regex
 * over `allSources()` in `inv-49-host-import-boundary.test.ts` (`_load` and
 * `_resolveFilename` stay banned outright, in the exempted file too).
 */
export interface ResolverCallSite {
  readonly relative: string;
  readonly line: number;
  /** The callee as written — the resolver binding, whatever it is called. */
  readonly callee: string;
  /** The checker's type for the callee. `Require` for a `createRequire` product. */
  readonly calleeType: string;
  readonly args: readonly TypedArgument[];
}

/** The `rootDir`-relative module declaring a type's symbol, when it has one there. */
function typeDeclarationFile(type: ts.Type, rootDir: string): string | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  if (declaration === undefined) {
    return undefined;
  }
  const file = declaration.getSourceFile().fileName;
  return file.startsWith(rootDir) ? path.relative(rootDir, file) : undefined;
}

/**
 * Every call through a `createRequire` product under `src/` — see
 * {@link ResolverCallSite} for what that means and why it is the checkable form.
 *
 * Returns `[]` when `src/` constructs no resolver at all. That is a *red* result for
 * the assertion reading it, not a green one: the assertion pins the row, so a scan
 * that has stopped finding its subject fails rather than passing vacuously.
 */
export function resolverCallSites(): readonly ResolverCallSite[] {
  const program = srcProgram();
  return resolverCallSitesIn(program, srcDir, srcSourceFiles(program));
}

/**
 * {@link resolverCallSites} over an arbitrary program — the seam its non-vacuity
 * fixtures enter through.
 *
 * The fixtures cannot be real modules under `src/`, for the reason {@link scanText}
 * records: a file that aims a constructed require anywhere but at a branded path
 * would violate the invariant it exists to test, and it would have to pass `tsc`.
 * Since this scan needs a checker rather than a parse, "text rather than a file"
 * means an in-memory program — {@link resolverCallProgram}.
 */
export function resolverCallSitesIn(
  program: ts.Program,
  rootDir: string,
  sourceFiles: readonly ts.SourceFile[] = program
    .getSourceFiles()
    .filter(sourceFile => !sourceFile.isDeclarationFile),
): readonly ResolverCallSite[] {
  const checker = program.getTypeChecker();

  // Pass 1: what type does a constructed resolver have here? Read off the
  // construction site so the answer tracks whatever `@types/node` calls it.
  const resolverTypes = new Set<ts.Type>();
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createRequire'
      ) {
        resolverTypes.add(checker.getTypeAtLocation(node));
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  if (resolverTypes.size === 0) {
    return [];
  }

  // Pass 2: every call whose *callee* is a value of that type.
  const found: ResolverCallSite[] = [];
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const calleeType = checker.getTypeAtLocation(node.expression);
        if (resolverTypes.has(calleeType)) {
          found.push({
            relative: path.relative(rootDir, sourceFile.fileName),
            line:
              sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              ).line + 1,
            callee: node.expression.getText(sourceFile).replace(/\s+/g, ' '),
            calleeType: checker.typeToString(calleeType),
            args: node.arguments.map(argument => {
              const type = checker.getTypeAtLocation(argument);
              return {
                text: argument.getText(sourceFile).replace(/\s+/g, ' '),
                type: checker.typeToString(type),
                isIdentifier: ts.isIdentifier(argument),
                typeDeclaredIn: typeDeclarationFile(type, rootDir),
              };
            }),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return found;
}

/**
 * A checker over fixture text held in memory — {@link scanText}'s program-level twin.
 *
 * `noLib` and an empty `types` are what make it hermetic and instant: the fixtures
 * declare the resolver shape they need, so nothing is read off disk and the scan's
 * *mechanism* — deriving the resolver type from the construction site and matching
 * callees against it by type identity — is what gets exercised, rather than
 * `@types/node`'s spelling of it.
 */
export function resolverCallProgram(
  sources: readonly { readonly name: string; readonly text: string }[],
  rootDir: string,
): ts.Program {
  const files = new Map(
    sources.map(source => [path.join(rootDir, source.name), source.text]),
  );
  const host: ts.CompilerHost = {
    fileExists: file => files.has(file),
    readFile: file => files.get(file),
    getSourceFile: (file, languageVersion) => {
      const text = files.get(file);
      return text === undefined
        ? undefined
        : ts.createSourceFile(
            file,
            text,
            languageVersion,
            /* setParentNodes */ true,
            ts.ScriptKind.TS,
          );
    },
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => rootDir,
    getCanonicalFileName: file => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  return ts.createProgram([...files.keys()], { noLib: true, types: [] }, host);
}

/**
 * The declared members of an interface body, with doc comments stripped.
 *
 * Interface-shape assertions are how three invariants state "exactly these
 * members" (INV-31's two reader methods, INV-43's one dependency, INV-35's one
 * logger method). Documenting a member must not change the member list, so
 * comment lines are filtered rather than counted — otherwise the assertion turns
 * into a prose-diff and gets relaxed the first time it fires for the wrong
 * reason.
 */
export function interfaceMembers(body: string): readonly string[] {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        line.length > 0 &&
        !line.startsWith('//') &&
        !line.startsWith('/*') &&
        !line.startsWith('*'),
    );
}

export interface CallSite {
  readonly relative: string;
  readonly line: number;
  /** The call's arguments as written, one entry each. */
  readonly args: readonly string[];
}

/**
 * Every call to `calleeName` across the scanned modules, with its arguments as
 * written.
 *
 * INV-29's five-handle rule is a rule about the seam's own `sealSlot` sites, not
 * about which handles happen to be credential-reachable in some upstream version —
 * so the enforceable form of it is "exactly these five calls exist, and each names
 * its handle keys". A count alone would let a sixth handle-bearing slot ship
 * unsealed as long as somebody deleted an existing seal in the same commit.
 */
export function callSites(
  sources: readonly ScannedSource[],
  calleeName: string,
): readonly CallSite[] {
  const found: CallSite[] = [];
  for (const source of sources) {
    const sourceFile = ts.createSourceFile(
      source.file,
      source.text,
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined;
        if (name === calleeName) {
          found.push({
            relative: source.relative,
            line:
              sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              ).line + 1,
            args: node.arguments.map(argument =>
              argument.getText(sourceFile).replace(/\s+/g, ' '),
            ),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return found;
}

/** Value references only — excludes comments, type positions and property names. */
export function valueIdentifierNames(
  source: ScannedSource,
): readonly string[] {
  return source.identifiers
    .filter(use => !use.isPropertyName && !use.inTypePosition)
    .map(use => use.name);
}

/** Every identifier that reaches emitted JavaScript, property names included. */
export function emittedIdentifierNames(
  source: ScannedSource,
): readonly string[] {
  return source.identifiers
    .filter(use => !use.inTypePosition)
    .map(use => use.name);
}
