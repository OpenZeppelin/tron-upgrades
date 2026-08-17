import { createRequire } from 'node:module';
import path from 'node:path';

import ts from 'typescript';

import type {
  ResolvedUpgradeOptions,
  UpgradeOptions,
} from '../../src/options';
import { resolveUpgradeOptions } from '../../src/options';
import type {
  DegradedCode,
  DegradedNote,
  HostChannelFacts,
  LogSink,
} from '../../src/output';
import {
  scanDirectory,
  type ScannedSource,
} from './source-scan';
import { repoRoot, srcDir, tronBoxRoot } from './locate';

/**
 * The option/result surface's own fixtures. Kept separate from the
 * environment seam's helpers on purpose.
 *
 * `helpers/handles.ts`, `helpers/fixture-catalogue.ts`, `helpers/source-scan.ts`
 * and `helpers/locate.ts` are pinned by the environment seam's own assertions
 * — `fixture-catalogue` by a `probes.length > 20` floor and two
 * whole-catalogue sweeps, `source-scan`'s `typedInterpolations()` by a single
 * module-level cache scoped to `src/environment/**`. Extending any of them
 * would silently widen an environment-seam assertion, so every
 * option/result-surface fixture lives here and the environment-seam helpers
 * are only *read*.
 *
 * Everything below is a plain object or a plain function: every host
 * dependency the option/result surface touches is injected, so no fixture
 * needs a TronBox process, a node runtime seam, or the environment seam's own
 * module.
 */

// ---------------------------------------------------------------------------
// Locating the installed engine
// ---------------------------------------------------------------------------

/**
 * `createRequire` rooted at the monorepo, matching the established pattern at
 * `real-tronbox.test.ts` and `host-import-boundary.test.ts`.
 *
 * `@openzeppelin/upgrades-core` is hoisted to the repo root, and the
 * environment seam's host-import-boundary scan forbids `createRequire` in
 * `src/` while explicitly exempting `test/` — which is the whole point of the
 * canary pattern the version and override checks below rest on: the fragile
 * deep import lives where breaking it is a signal rather than an outage.
 */
export const engineRequire = createRequire(path.join(repoRoot, 'package.json'));

/** The installed engine's `dist/` directory. */
export function engineDistDir(): string {
  return path.dirname(
    engineRequire.resolve('@openzeppelin/upgrades-core/dist/index.js'),
  );
}

/** The engine's own `package.json`, for the version every canary states. */
export function engineVersion(): string {
  const manifest = engineRequire('@openzeppelin/upgrades-core/package.json') as {
    version: string;
  };
  return manifest.version;
}

/**
 * The version every option/result-surface canary claims its facts against.
 *
 * Stated as a constant rather than read at each assertion so a bump produces one
 * failing equality naming the old and new versions, instead of a scatter of
 * unrelated failures whose common cause a reader has to infer.
 */
export const ENGINE_VERSION_UNDER_TEST = '1.46.0';

// ---------------------------------------------------------------------------
// Host sinks — one fixture per real TronBox injection path
// ---------------------------------------------------------------------------

export interface SinkSpy extends LogSink {
  /** Every argument list the sink was called with, in call order. */
  readonly calls: readonly (readonly unknown[])[];
}

export interface WarnCapableSinkSpy extends SinkSpy {
  warn(...args: unknown[]): void;
  /** Every argument list `warn` was called with. */
  readonly warnCalls: readonly (readonly unknown[])[];
}

/**
 * The four-of-five TronBox paths that supply a single-method object:
 * `migrate --quiet`, `lib/test.js`'s migration phase, `Config`'s own default and
 * the `Deployer`'s fallback. The guaranteed-logger-surface invariant's
 * primary subject.
 */
export function recordingSink(): SinkSpy {
  const calls: unknown[][] = [];
  return {
    calls,
    log(...args: unknown[]): void {
      calls.push(args);
    },
  };
}

/**
 * The one live path: `build/index.js`'s `{ logger: console }`, which is the only
 * injected sink carrying `warn`. The guaranteed-logger-surface invariant's
 * probe is what makes this path and the four above behave identically.
 */
export function warnCapableSink(): WarnCapableSinkSpy {
  const calls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  return {
    calls,
    warnCalls,
    log(...args: unknown[]): void {
      calls.push(args);
    },
    warn(...args: unknown[]): void {
      warnCalls.push(args);
    },
  };
}

/**
 * A host sink that throws. The write is a courtesy and may not fail an
 * operation.
 */
export function throwingSink(message = 'sink exploded'): LogSink {
  return {
    log(): void {
      throw new Error(message);
    },
  };
}

/** `build/lib/test.js`'s `{ log: function log(){} }` — discards on every run, no flag involved. */
export function noopSink(): LogSink {
  return {
    log(): void {
      // Deliberately empty: this is the host's own noop, verbatim.
    },
  };
}

/**
 * A JavaScript host that supplied an object with **no `log` at all**.
 *
 * Built by deleting the member at runtime rather than by casting: the type system
 * cannot express this shape, and `as unknown as LogSink` would assert a claim
 * about the value instead of modelling the hazard. `Reflect.deleteProperty` on a
 * correctly typed literal produces the real runtime object with no cast anywhere.
 */
export function sinkMissingLog(): LogSink {
  const sink: LogSink = {
    log(): void {
      throw new Error('unreachable: this member is deleted below');
    },
  };
  Reflect.deleteProperty(sink, 'log');
  return sink;
}

/**
 * `build/components/Deployer/index.js`'s wrapper: `{ log: msg => logger.log('  ' + msg) }`.
 *
 * Indents by two spaces **per call**, which is why the
 * guaranteed-logger-surface invariant requires exactly one `write` per
 * emission — a three-call emission would get three prefixes.
 */
export function deployerStyleSink(inner: SinkSpy): LogSink {
  return {
    log(...args: unknown[]): void {
      inner.log(`  ${args.map(a => (typeof a === 'string' ? a : '')).join('')}`);
    },
  };
}

/**
 * The un-quieted CLI path reduced to its hazard: a sink whose write goes to
 * `console.error`.
 *
 * This is the whole reason the capture window buffers writes rather than
 * passing them through. If the relay ran inside the capture window, this sink
 * would feed the window's own stub — a duplicated, mislabelled note in the mild
 * case and an unbounded loop in the worst.
 */
export function consoleBackedSink(): LogSink {
  return {
    log(...args: unknown[]): void {
      console.error(...args);
    },
  };
}

// ---------------------------------------------------------------------------
// Channel facts
// ---------------------------------------------------------------------------

export const CHANNEL_ORIGINS: readonly HostChannelFacts['origin'][] =
  Object.freeze(['deployer', 'config-lineage']);

export const QUIET_VALUES: readonly boolean[] = Object.freeze([true, false]);

/**
 * The four `(origin, hostQuietRequested)` combinations, as data.
 *
 * The origin/quiet-neutrality invariant's behavioural half needs every
 * combination driven against one fixture, because the property is that none
 * of them changes what is written or recorded.
 */
export const FACT_COMBINATIONS: readonly {
  readonly origin: HostChannelFacts['origin'];
  readonly hostQuietRequested: boolean;
}[] = Object.freeze(
  CHANNEL_ORIGINS.flatMap(origin =>
    QUIET_VALUES.map(hostQuietRequested =>
      Object.freeze({ origin, hostQuietRequested }),
    ),
  ),
);

export function channelFacts(
  logger: LogSink,
  origin: HostChannelFacts['origin'] = 'deployer',
  hostQuietRequested = false,
): HostChannelFacts {
  return { logger, origin, hostQuietRequested };
}

// ---------------------------------------------------------------------------
// Degraded notes
// ---------------------------------------------------------------------------

/**
 * A well-formed `DegradedNote`, so a test that is about something *else*
 * does not accidentally exercise the degraded-note non-empty-fields
 * invariant's refusals.
 */
export function validNote(
  code: DegradedCode = 'storage-layout-unavailable',
  overrides: Partial<Omit<DegradedNote, 'code'>> = {},
): DegradedNote {
  return {
    code,
    summary: overrides.summary ?? `a fixture note for ${code}`,
    detail: overrides.detail ?? ['first detail line', 'second detail line'],
    remedy: overrides.remedy ?? 'nothing — this note is a test fixture',
  };
}

// ---------------------------------------------------------------------------
// The option surface
// ---------------------------------------------------------------------------

/**
 * Every key `UpgradeOptions` declares, which is the accepted list a full-surface
 * operation would pass to `resolveUpgradeOptions`.
 *
 * Written out rather than derived: the unknown-key check is the thing under
 * test, so deriving the list from the type under test would make the test
 * agree with the implementation by construction.
 */
export const UPGRADE_OPTION_KEYS: readonly string[] = Object.freeze([
  'kind',
  'unsafeAllow',
  'unsafeAllowCustomTypes',
  'unsafeAllowLinkedLibraries',
  'unsafeAllowRenames',
  'unsafeSkipStorageCheck',
  'constructorArgs',
  'useDeployedImplementation',
  'redeployImplementation',
  'timeout',
  'pollingInterval',
]);

/** `deployProxy`'s list: the upgrade surface plus `initializer`, less nothing. */
export const DEPLOY_PROXY_OPTION_KEYS: readonly string[] = Object.freeze([
  ...UPGRADE_OPTION_KEYS,
  'initializer',
]);

/**
 * Resolves options the way a **JavaScript migration** supplies them.
 *
 * The consumer base is JavaScript migrations, where the declared parameter type
 * reaches nothing — which is *why* every check in `resolve.ts` is a runtime one,
 * and why the interesting inputs (an unknown key, a wrong-cased value, a
 * `null`) are exactly the ones a TypeScript caller cannot write. Modelling that
 * caller needs one widening, and it is confined here with its reason rather than
 * scattered as a cast at every call site. There is no `as any` and no
 * `as unknown as` anywhere in the option/result-surface suite; this is the
 * single assertion, and
 * it asserts the declared parameter type, not a shape claim about the value.
 */
export function resolveAsJavaScriptCaller(
  supplied: object | undefined,
  accepted: readonly string[],
): ResolvedUpgradeOptions {
  return resolveUpgradeOptions(supplied as UpgradeOptions | undefined, accepted);
}

/**
 * The `unsafeAllow` fixture that makes upstream's aliasing **observable**.
 *
 * Verified by execution against `@openzeppelin/upgrades-core@1.46.0`:
 * `withValidationDefaults`/`processExceptions` derive
 * `unsafeAllowLinkedLibraries` from `unsafeAllow.includes('external-library-linking')`
 * and then `push` the member back in when the derived flag is truthy — so one
 * call leaves **two** copies and two calls leave **three**. It is also the opt-out
 * v1 ships, so this is the array a real caller writes.
 */
export const ACCUMULATING_UNSAFE_ALLOW: readonly string[] = Object.freeze([
  'external-library-linking',
]);

/**
 * The fixture that would make every aliasing test pass **vacuously**.
 *
 * `['constructor']` drives no derived flag, so upstream pushes nothing and the
 * caller's array is byte-identical after two calls even when the plugin copies
 * nothing. Kept as a named constant so the tests that use it as a negative
 * control say so, and so nobody reaches for it as "some valid kind".
 */
export const NON_ACCUMULATING_UNSAFE_ALLOW: readonly string[] = Object.freeze([
  'constructor',
]);

// ---------------------------------------------------------------------------
// Source scanning over the option/result surface's three directories
// ---------------------------------------------------------------------------

export const SF10_DIRECTORIES: readonly string[] = Object.freeze([
  'options',
  'output',
  'results',
]);

/**
 * Every module in one of the option/result surface's directories, relative
 * paths rooted at `src/`.
 */
export function directorySources(directory: string): readonly ScannedSource[] {
  return scanDirectory(path.join(srcDir, directory), srcDir);
}

/** Every module in all three of the option/result surface's directories. */
export function sf10Sources(): readonly ScannedSource[] {
  return SF10_DIRECTORIES.flatMap(directory => directorySources(directory));
}

/**
 * The member names an interface or object-type alias declares **in its own body**,
 * excluding everything it inherits.
 *
 * This is exactly the distinction the portable-option-surface check needs:
 * the portable option surface reaches upstream's members by `extends`, so a
 * member name that appears as a property signature *in* `StandaloneOptions`
 * is a local re-declaration, while the same name reached through `extends` is
 * the property holding. `source-scan.ts:interfaceMembers` works on body text
 * a caller already has; this locates the body by name so the assertion
 * cannot drift to the wrong declaration.
 */
export function declaredMembers(
  source: ScannedSource,
  typeName: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const members: string[] = [];
  let found = false;
  const collect = (node: ts.TypeLiteralNode | ts.InterfaceDeclaration): void => {
    found = true;
    for (const member of node.members) {
      if (member.name !== undefined && ts.isIdentifier(member.name)) {
        members.push(member.name.text);
      }
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === typeName) {
      collect(statement);
    }
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === typeName &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      collect(statement.type);
    }
  }
  if (!found) {
    throw new Error(
      `No interface or object-type alias named '${typeName}' in ${source.relative}.`,
    );
  }
  return members;
}

export interface ThrowSite {
  readonly relative: string;
  readonly line: number;
  /**
   * The constructor name for `throw new X(…)`, or a rendering of whatever else is
   * thrown — `'<rethrow>'` for a bare identifier, `'<non-construction>'`
   * otherwise. The enumerated throw-class rule forbids everything except an
   * enumerated class, so the catch-all cases have to be visible rather than
   * filtered out.
   */
  readonly thrown: string;
}

/**
 * Every `throw` in a scanned module, with what it throws.
 *
 * The enumerated throw-class rule's mechanical half — "no path throws a bare
 * `Error`, a string, or an upstream error re-thrown unwrapped" — is a
 * statement about throw *sites*, and a grep for `throw new Error` would miss
 * `throw 'text'`, `throw error` and
 * `throw { code: … }`. This returns all of them so the assertion can be an
 * equality against the enumerated class list rather than an absence check that
 * only covers the spelling somebody thought of.
 */
export function throwSites(source: ScannedSource): readonly ThrowSite[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: ThrowSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) {
      const thrownExpression = node.expression;
      let thrown = '<non-construction>';
      if (
        ts.isNewExpression(thrownExpression) &&
        ts.isIdentifier(thrownExpression.expression)
      ) {
        thrown = thrownExpression.expression.text;
      } else if (ts.isIdentifier(thrownExpression)) {
        thrown = '<rethrow>';
      }
      found.push({
        relative: source.relative,
        line:
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
          1,
        thrown,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Every expression that appears in a **condition** position, as written.
 *
 * The origin/quiet-neutrality invariant's real content is that `origin` and
 * `hostQuietRequested` are never read *in a conditional that controls
 * emission, recording, or degraded-path selection*. An identifier scan cannot
 * say that — the channel legitimately
 * copies `origin` onto itself and legitimately interpolates both into
 * `describe()`. Collecting condition text turns the invariant into an assertion
 * about exactly the positions it forbids.
 */
export function conditionExpressions(source: ScannedSource): readonly string[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const record = (node: ts.Node | undefined): void => {
    if (node !== undefined) {
      found.push(node.getText(sourceFile).replace(/\s+/g, ' '));
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      record(node.expression);
    } else if (ts.isConditionalExpression(node)) {
      record(node.condition);
    } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      record(node.expression);
    } else if (ts.isForStatement(node)) {
      record(node.condition);
    } else if (ts.isSwitchStatement(node)) {
      record(node.expression);
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      record(node.left);
      record(node.right);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Every call to `console.<method>` in a scanned module.
 *
 * The single-console-reference invariant's stated instrument is *"a
 * source-level scan asserting exactly one `console` occurrence"*, and
 * implementing it as written **fails on correct code**: a comment-stripped
 * token count of `console.` in the three directories
 * returns **6**, because `EngineCallNotSynchronousError`'s message and
 * `BLANK_WRITE_SUMMARY` deliberately name `console.error` as user-facing text —
 * which is what makes them actionable, so weakening the messages to satisfy the
 * grep would be backwards. The invariant's real content is **zero writes and one
 * swap site**, and that is what this measures: writes are calls, and the swap is
 * an assignment.
 */
export function consoleCallSites(source: ScannedSource): readonly string[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console'
    ) {
      found.push(
        `${source.relative}:${
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        } console.${node.expression.name.text}(…)`,
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * The name of the innermost named function enclosing `node`, or `'<module scope>'`.
 *
 * Handles the three shapes the option/result surface's sources use: a
 * `function` declaration, a named arrow or function expression bound to a
 * `const`, and a method or arrow in an object literal
 * (`degraded(note) { … }`, `get recorded() { … }`).
 */
function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return current.name.text;
    }
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (
        (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
        ts.isIdentifier(parent.name)
      ) {
        return parent.name.text;
      }
      return '<anonymous function>';
    }
    current = current.parent;
  }
  return '<module scope>';
}

/**
 * The innermost named function enclosing each reference to `identifier` **as a
 * value** — property-name positions excluded.
 *
 * The single-console-reference invariant does not only bound the *count* of
 * `console` references; it says all of them are the save-and-swap inside
 * `runCaptureWindow`. A count alone would pass if
 * one reference moved into a different function.
 */
export function enclosingFunctionsOf(
  source: ScannedSource,
  identifier: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === identifier &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      found.push(enclosingFunctionName(node));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * The innermost named function enclosing each **property-access read** of
 * `chain`, e.g. `facts.hostQuietRequested`.
 *
 * `enclosingFunctionsOf` deliberately skips property-name positions, because
 * the single-console-reference invariant's subject is `console` as an
 * object. The origin/quiet-neutrality invariant's subject is the opposite:
 * the reads that matter *are* property accesses off the injected `facts`, so
 * they need their own instrument rather than a loosened version of the first
 * one.
 */
export function enclosingFunctionsOfChain(
  source: ScannedSource,
  chain: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.getText(sourceFile).replace(/\s+/g, '') === chain
    ) {
      found.push(enclosingFunctionName(node));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

export interface ReExportedName {
  /** The exported name, as it appears on the surface. */
  readonly name: string;
  /** `export { type X }` and `export type { X }` alike. */
  readonly isTypeOnly: boolean;
  readonly from: string;
}

/**
 * Every name a module re-exports through an `export { … } from '…'` clause.
 *
 * The right instrument for the re-export ban's *"not re-exported from
 * `output/index.ts`"* and for the root-export surface pin. Two weaker
 * instruments are available and both are wrong: a text search for the
 * identifier **fails on correct code**, because `output/index.ts` documents
 * the two deliberate omissions **by name** — that documentation is the record
 * of the decision, so weakening it to satisfy a grep would be backwards. And
 * `Object.keys(module)` sees only the value exports, so it cannot pin a type
 * export at all, and the surface it pins includes twenty-odd of them.
 */
export function reExportedNames(
  source: ScannedSource,
): readonly ReExportedName[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: ReExportedName[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const from =
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : '<local>';
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        found.push({
          name: element.name.text,
          isTypeOnly: statement.isTypeOnly || element.isTypeOnly,
          from,
        });
      }
    }
  }
  return found;
}

/**
 * The trap names declared on every `new Proxy(target, handler)` in a module.
 *
 * The sealing-neutrality invariant's enforcement clause is *"only a `get`
 * trap; no `set`, `defineProperty`, `ownKeys` or `getOwnPropertyDescriptor`
 * trap that alters visibility"*, and that is a statement about which traps
 * **exist**, not about what they happen to return. A behavioural check can
 * only observe the traps that were written; this observes the ones that
 * were not.
 */
export function proxyTrapNames(source: ScannedSource): readonly string[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Proxy'
    ) {
      const handler = node.arguments?.[1];
      if (handler !== undefined && ts.isObjectLiteralExpression(handler)) {
        for (const member of handler.properties) {
          if (member.name !== undefined && ts.isIdentifier(member.name)) {
            found.push(member.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

export interface DeclaredReturnType {
  /** The function's name, or `'<anonymous>'` for an unbound arrow. */
  readonly name: string;
  /** The return-type annotation as written, whitespace collapsed. */
  readonly returnType: string;
  readonly line: number;
}

/**
 * Every **explicitly annotated** return type in a scanned module.
 *
 * The synchronous-surface invariant's type-level half is *"no declared
 * return type in the three directories contains `Promise`"*, and that is a
 * statement about annotations, not
 * about text: `Promise` appears in `engine.ts` as prose, as a `declaredReturn:
 * 'promise'` data value, and inside `UncapturedEngineWarning`'s documentation. A
 * text search would report all three and a reader would learn nothing. This walks
 * the AST so the assertion is about the positions the invariant names.
 *
 * Annotated returns only, deliberately: this package compiles under `strict`, and
 * every function in the three directories carries one. A function that dropped its
 * annotation would fall out of this list, which is why the callers also assert the
 * list is non-empty and contains the returns that are known to be there.
 */
export function declaredReturnTypes(
  source: ScannedSource,
): readonly DeclaredReturnType[] {
  const sourceFile = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found: DeclaredReturnType[] = [];
  const nameOf = (node: ts.SignatureDeclaration): string => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessorDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      return node.name.text;
    }
    const parent: ts.Node | undefined = node.parent;
    if (
      parent !== undefined &&
      (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text;
    }
    return '<anonymous>';
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessorDeclaration(node)) &&
      node.type !== undefined
    ) {
      found.push({
        name: nameOf(node),
        returnType: node.type.getText(sourceFile).replace(/\s+/g, ' '),
        line:
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
          1,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

export function sourceNamed(relative: string): ScannedSource {
  const found = sf10Sources().find(
    source => source.relative === relative.split('/').join(path.sep),
  );
  if (found === undefined) {
    throw new Error(
      `No option/result-surface source module at '${relative}'. Present: ` +
        sf10Sources()
          .map(source => source.relative)
          .join(', '),
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Contract-handle fixtures for `sealUnavailable`
// ---------------------------------------------------------------------------

/**
 * A target whose `events` member is installed **exactly the way TronBox installs
 * it** — a non-configurable, non-enumerable accessor whose getter closes over the
 * target.
 *
 * This shape is exactly why `sealUnavailable` has to handle a genuinely
 * non-configurable accessor rather than only a plain data property.
 * `src/components/Contract/contract.js:Contract._static_methods.addProp`
 * builds every `_properties` member with `definition.enumerable = false;
 * definition.configurable = false` and a getter that opens `const self = this`,
 * and `Utils.bootstrap` applies it to the abstraction *and to every clone*.
 * Verified by execution on the installed `tronbox-4.9.0` and `tronbox-4.8.0`
 * trees: the descriptor is `{ get, set, enumerable: false,
 * configurable: false }` on both, and `Object.defineProperty(abstraction,
 * 'events', …)` throws `TypeError: Cannot redefine property: events` on both.
 *
 * A plain data property would make every such test pass against a mechanism
 * that **cannot run** — exactly the failure a real accessor-shaped fixture
 * exists to avoid.
 */
export function addPropStyleTarget(
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const target: Record<string, unknown> = {
    contractName: 'Box',
    address: 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh',
    _json: { contractName: 'Box', bytecode: '0x6080', sourceMap: '0:1:2:-' },
    ...extra,
  };
  const self = target;
  Object.defineProperty(target, 'events', {
    enumerable: false,
    configurable: false,
    get: () => [],
    set: () => {
      throw new Error('events property is immutable');
    },
  });
  Object.defineProperty(target, 'isDeployed', {
    enumerable: true,
    configurable: false,
    value: () => self.address !== undefined,
  });
  Object.defineProperty(target, 'retrieve', {
    enumerable: true,
    configurable: true,
    value: () => 'an ABI-derived call',
  });
  return target;
}

/**
 * A real TronBox contract abstraction, from an installed aliased tree.
 *
 * `Contract.clone(json)` is the host's own construction path and runs
 * `Utils.bootstrap` on the result, so the abstraction it returns carries the same
 * non-configurable accessors `Contract.at`'s clone does — without needing a
 * `TronWrap` instance, which `at()` would.
 */
export function tronBoxAbstraction(installName: string): Record<string, unknown> {
  const contractModule = engineRequire(
    path.join(tronBoxRoot(installName), 'build/components/Contract/contract.js'),
  ) as {
    clone(json: unknown): Record<string, unknown>;
    _properties: Record<string, unknown>;
  };
  return contractModule.clone({
    contractName: 'Box',
    abi: [
      {
        type: 'function',
        name: 'retrieve',
        inputs: [],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
      },
    ],
    networks: {},
    bytecode: '0x6080',
    deployedBytecode: '0x6080',
    schemaVersion: '3.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

/**
 * A real TronBox abstraction with a network id set and **no transaction hash**.
 *
 * This is the fixture the transaction-hash divergence's test line asks for,
 * and it can only be built on the real host: the divergence it pins is a
 * property of
 * `Contract._properties.transactionHash`'s getter, which needs `network_id` set
 * before it will look anything up at all.
 *
 * Verified by execution on both installed trees: reading an absent
 * hash **throws** `Could not find transaction hash for Box` on 4.9.0 and returns
 * **`undefined`** on 4.8.0. Both accessors are non-configurable, so the plugin
 * cannot repair either in place — which is why supplying the value is the
 * plugin's own obligation.
 */
export function tronBoxAbstractionWithNetwork(
  installName: string,
  networkId = '1',
): Record<string, unknown> & { setNetwork(id: string): void } {
  const contractModule = engineRequire(
    path.join(tronBoxRoot(installName), 'build/components/Contract/contract.js'),
  ) as {
    clone(json: unknown): Record<string, unknown> & { setNetwork(id: string): void };
  };
  const abstraction = contractModule.clone({
    contractName: 'Box',
    abi: [],
    networks: {
      [networkId]: {
        address: 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh',
        events: {},
        links: {},
      },
    },
    bytecode: '0x6080',
    deployedBytecode: '0x6080',
    schemaVersion: '3.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  abstraction.setNetwork(networkId);
  return abstraction;
}

// ---------------------------------------------------------------------------
// Upstream's own warning writer
// ---------------------------------------------------------------------------

export interface UpstreamLogWriters {
  logWarning(title: string, lines?: string[]): void;
  logNote(title: string, lines?: string[]): void;
}

/**
 * Upstream's real writers, deep-imported.
 *
 * `logWarning` is root-exported but **`logNote` is not** — verified at 1.46.0 —
 * so the pair is only reachable through `dist/utils/log`. The relay-fidelity
 * invariant says the relay must be tested against upstream's real output
 * rather than a hand-written string, and this is the only way to produce it.
 *
 * **Never call upstream's `silenceWarnings`.** It sets a module-level `let
 * silenced` in the same resolved copy, is not exported, not readable and not
 * resettable — so one call would silence every later test in the file. That
 * property is exactly why the option/result surface keeps its own flag — a
 * recorded divergence from calling upstream's mechanism directly.
 */
export function upstreamLogWriters(): UpstreamLogWriters {
  return engineRequire(
    '@openzeppelin/upgrades-core/dist/utils/log',
  ) as UpstreamLogWriters;
}

export interface UpstreamOverrides {
  withValidationDefaults(opts: object): Record<string, unknown>;
  processExceptions(contractName: string, errors: unknown[], opts: object): unknown[];
}

/**
 * Upstream's `dist/validate/overrides`, deep-imported.
 *
 * `processExceptions` is **not** root-exported at 1.46.0, which is why the import
 * is deep and why it lives in the test rather than in `src/`: the package ships no
 * `exports` map today, so a minor that adds one would break a `src/` deep import,
 * and a canary that fails loudly is a signal where an outage is not.
 *
 * This is the function the accumulating-`unsafeAllow` aliasing rests on. It
 * is reached from `getErrors` and therefore
 * from `assertUpgradeSafe`, opens with `withValidationDefaults(opts)`, **aliases**
 * `opts.unsafeAllow`, and `push`es into it whenever either derived flag is truthy.
 */
export function upstreamOverrides(): UpstreamOverrides {
  return engineRequire(
    '@openzeppelin/upgrades-core/dist/validate/overrides',
  ) as UpstreamOverrides;
}

/** `chalk`, as upstream resolves it, so colour can be forced on and off. */
export function chalkUnderTest(): { level: number } {
  return engineRequire('chalk') as { level: number };
}

/**
 * Runs `emit` with `chalk.level` forced, restoring it afterwards.
 *
 * The relay-fidelity invariant requires the ANSI strip to be unconditional,
 * and `chalk@4.1.2` auto-detects the terminal — so a recorded note whose text
 * depended on whether a
 * TTY was attached would be untestable. Driving both levels is what turns
 * "unconditional" into an assertion.
 */
export function atChalkLevel<T>(level: number, run: () => T): T {
  const chalk = chalkUnderTest();
  const saved = chalk.level;
  chalk.level = level;
  try {
    return run();
  } finally {
    chalk.level = saved;
  }
}
