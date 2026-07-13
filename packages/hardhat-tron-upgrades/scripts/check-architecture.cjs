'use strict';

// Enforces the module architecture (mirrors upstream plugin-hardhat):
//   1. no operation module imports another operation module
//   2. no utils/* module imports an operation module
//   3. the monolithic src/upgrades.ts must not exist
//
// A Node script rather than a Mocha test on purpose: the runtime suite
// count is a compatibility gate and must not change when this check runs.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const srcDir = path.resolve(__dirname, '..', 'src');
const NON_OPERATIONS = new Set(['index.ts', 'types.ts', 'type-extensions.ts']);

const violations = [];

if (fs.existsSync(path.join(srcDir, 'upgrades.ts'))) {
  violations.push('src/upgrades.ts exists — the monolithic module must stay split per operation');
}

const topLevel = fs
  .readdirSync(srcDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => path.join(srcDir, name));
const utilsDir = path.join(srcDir, 'utils');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}
const utilsFiles = fs.existsSync(utilsDir) ? walk(utilsDir) : [];

const operationFiles = new Set(
  topLevel.filter((file) => !NON_OPERATIONS.has(path.basename(file))),
);

function moduleSpecifiers(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (node.expression.kind === ts.SyntaxKind.Identifier && node.expression.text === 'require') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.kind === ts.SyntaxKind.Identifier &&
          node.expression.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

for (const file of [...topLevel, ...utilsFiles]) {
  const isOperation = operationFiles.has(file);
  const isUtil = file.startsWith(utilsDir + path.sep);
  for (const specifier of moduleSpecifiers(file)) {
    const target = resolveRelative(file, specifier);
    if (!target) continue;
    if (operationFiles.has(target)) {
      const from = path.relative(srcDir, file);
      const to = path.relative(srcDir, target);
      if (isOperation) {
        violations.push(`operation module ${from} imports operation module ${to}`);
      } else if (isUtil) {
        violations.push(`utils module ${from} imports operation module ${to}`);
      }
    }
  }
}

const indexImports = new Set(
  moduleSpecifiers(path.join(srcDir, 'index.ts'))
    .map((specifier) => resolveRelative(path.join(srcDir, 'index.ts'), specifier))
    .filter(Boolean),
);
for (const operation of operationFiles) {
  if (!indexImports.has(operation)) {
    violations.push(
      `index.ts does not compose operation module ${path.relative(srcDir, operation)}`,
    );
  }
}

if (violations.length > 0) {
  console.error('Architecture check FAILED:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log(
  `Architecture check OK: ${operationFiles.size} operation modules, ${utilsFiles.length} utils modules`,
);
