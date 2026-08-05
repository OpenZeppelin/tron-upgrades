import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Filesystem locators for the suite.
 *
 * Derived from `__dirname` rather than `process.cwd()` on purpose: the test that
 * exists to prove the seam is cwd-independent calls `process.chdir` mid-run, so
 * any cwd-derived locator would break exactly that test.
 */
export const testDir: string = __dirname.endsWith(`${path.sep}helpers`)
  ? path.dirname(__dirname)
  : __dirname;

export const packageRoot: string = path.dirname(testDir);
export const srcDir: string = path.join(packageRoot, 'src');
export const environmentSrcDir: string = path.join(srcDir, 'environment');
export const repoRoot: string = path.resolve(packageRoot, '..', '..');

/**
 * The TronBox trees the real-host suites run against. Both are installed
 * side by side so a fact the seam depends on that changes between minors fails
 * loudly here rather than surfacing as a behavioural bug.
 */
export const tronBoxVersionsUnderTest: readonly string[] = [
  'tronbox-4.9.0',
  'tronbox-4.8.0',
];

export function tronBoxRoot(installName: string): string {
  return path.join(repoRoot, 'node_modules', installName);
}

export function tronBoxIsInstalled(installName: string): boolean {
  return fs.existsSync(path.join(tronBoxRoot(installName), 'build'));
}

/** Absolute paths only — the seam refuses anything else. */
export function makeTempDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sf0-${tag}-`));
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}
