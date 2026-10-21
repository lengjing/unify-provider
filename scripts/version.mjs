#!/usr/bin/env node
// Bump the root and every workspace package to one version, refresh the lockfile,
// and optionally commit + tag. Usage:
//   node scripts/version.mjs <patch|minor|major|x.y.z> [--tag]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const tag = args.includes('--tag');
const spec = args.find(arg => !arg.startsWith('--'));
if (!spec) {
  console.error('usage: node scripts/version.mjs <patch|minor|major|x.y.z> [--tag]');
  process.exit(2);
}

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const rootPkg = read(join(root, 'package.json'));
const workspaces = rootPkg.workspaces.flatMap(pattern => {
  if (!pattern.endsWith('/*')) return [pattern];
  const dir = join(root, pattern.slice(0, -2));
  return execFileSync('git', ['ls-files', '--', `${pattern.slice(0, -2)}/*/package.json`], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map(file => file.replace(/\/package\.json$/, ''));
});
const files = ['package.json', ...workspaces.map(ws => `${ws}/package.json`)];

const current = rootPkg.version;
let next = spec;
if (['patch', 'minor', 'major'].includes(spec)) {
  const [major, minor, patch] = current.split('.').map(Number);
  next = spec === 'major' ? `${major + 1}.0.0` : spec === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`invalid version: ${next}`);
  process.exit(2);
}

if (tag) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) {
    console.error('working tree is not clean; commit or stash first when using --tag');
    process.exit(1);
  }
}

for (const file of files) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const pkg = JSON.parse(text);
  if (pkg.version !== current) {
    console.error(`${file}: version ${pkg.version} differs from root ${current}; fix manually first`);
    process.exit(1);
  }
  // Replace only the top-level version line so the file's formatting is untouched.
  const pattern = new RegExp(`^(\\s*"version":\\s*")${current.replace(/[.]/g, '\\.')}(")`, 'm');
  if (!pattern.test(text)) {
    console.error(`${file}: could not locate the version field`);
    process.exit(1);
  }
  writeFileSync(path, text.replace(pattern, `$1${next}$2`));
  console.log(`${pkg.name}: ${current} -> ${next}`);
}
execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

if (tag) {
  execFileSync('git', ['add', ...files, 'package-lock.json'], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', `v${next}`], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['tag', '-a', `v${next}`, '-m', `v${next}`], { cwd: root, stdio: 'inherit' });
  console.log(`\ntagged v${next}; push with: git push && git push origin v${next}`);
} else {
  console.log(`\nversions updated; review, then: git commit -am "v${next}" && git tag -a v${next} -m "v${next}"`);
}
