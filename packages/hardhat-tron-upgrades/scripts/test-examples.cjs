'use strict';

// Consumer E2E driver: runs examples/BoxUpgrades against a FRESHLY packed
// archive of the current source.
//
// The archive filename is taken from `npm pack --json` — never hardcoded —
// and stale local archives are removed before packing, so a version bump can
// neither silently install an old archive nor fail with ENOENT.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pkgDir = path.resolve(__dirname, '..');
const exampleDir = path.join(pkgDir, 'examples', 'BoxUpgrades');
const installedRoot = path.join(exampleDir, 'node_modules', '@openzeppelin', 'hardhat-tron-upgrades');

const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: 'inherit' });

// 1. Remove stale local archives so an old one can never be picked up.
for (const entry of fs.readdirSync(exampleDir)) {
  if (entry.startsWith('openzeppelin-hardhat-tron-upgrades-') && entry.endsWith('.tgz')) {
    fs.rmSync(path.join(exampleDir, entry));
  }
}

// 2. Pack the current source into the example dir (gitignored there) and
//    take the exact filename npm reports.
const packJson = execFileSync(npm, ['pack', '--json', '--pack-destination', exampleDir], {
  cwd: pkgDir,
  encoding: 'utf8',
});
const [packed] = JSON.parse(packJson);
const archive = path.join(exampleDir, packed.filename);
if (!fs.existsSync(archive)) {
  throw new Error(`npm pack reported ${packed.filename} but it is not in ${exampleDir}`);
}

// 3. Lockfile-verified install (plugin resolves to the committed vendor
//    tarball), then replace only the installed plugin with the archive we just
//    packed. npm does not re-extract a changed file dependency when its
//    package name, version, and resolved path are unchanged, even with --force.
run(['install'], exampleDir);
fs.rmSync(installedRoot, { recursive: true, force: true });
run(['install', '--no-save', `./${packed.filename}`], exampleDir);

// 4. Prove the override took: every dist file installed in the example must
//    be byte-identical to the corresponding entry in the fresh archive.
const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
  .split('\n')
  .filter((e) => e.startsWith('package/dist/'));
for (const entry of entries) {
  const fromArchive = execFileSync('tar', ['-xOf', archive, entry]);
  const installed = fs.readFileSync(path.join(installedRoot, entry.slice('package/'.length)));
  if (!fromArchive.equals(installed)) {
    throw new Error(`Installed ${entry} differs from the freshly packed archive — stale code in node_modules`);
  }
}
console.log(`Installed dist matches ${packed.filename} (${entries.length} files verified byte-identical).`);

// 5. Run the example suite against the verified-fresh install.
run(['test'], exampleDir);
