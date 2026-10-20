import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
async function json(path: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(new URL(path, root), 'utf8')) as Record<string, string>;
}

test('manifest localization keys match and all placeholders resolve', async () => {
  const english = await json('package.nls.json');
  const chinese = await json('package.nls.zh-cn.json');
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  const manifest = await readFile(new URL('package.json', root), 'utf8');
  for (const [, key] of manifest.matchAll(/%([^%]+)%/g)) {
    assert.ok(key && Object.hasOwn(english, key), `Missing manifest key: ${key}`);
  }
  assert.equal(JSON.parse(manifest).l10n, './l10n');
});

test('runtime translations match literal l10n calls and preserve placeholders', async () => {
  const chinese = await json('l10n/bundle.l10n.zh-cn.json');
  const files = await readdir(new URL('src/', root));
  const sources = await Promise.all(files.filter(file => file.endsWith('.ts'))
    .map(file => readFile(new URL(`src/${file}`, root), 'utf8')));
  const calls = new Set<string>();
  // Current calls use ordinary quoted literals; decode their escaped apostrophes/newlines.
  for (const source of sources) {
    for (const match of source.matchAll(/\bl10n\.t\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)) {
      const literal = match[1]!;
      const value = literal.startsWith('"') ? JSON.parse(literal) as string
        : literal.slice(1, -1).replace(/\\(['\\nr])/g, (_, escape: string) =>
          escape === 'n' ? '\n' : escape === 'r' ? '\r' : escape);
      calls.add(value);
    }
  }
  assert.deepEqual(Object.keys(chinese).sort(), [...calls].sort());
  for (const [key, value] of Object.entries(chinese)) {
    assert.ok(value.trim(), `Empty translation: ${key}`);
    assert.deepEqual([...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(),
      [...key.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), `Changed placeholders: ${key}`);
  }
  // New conversion diagnostics must also have a literal translation at the UI boundary.
  for (const source of sources) {
    for (const [, message] of source.matchAll(/new ConversionError\('([^']+)'\)/g)) {
      assert.ok(message && calls.has(message), `Untranslated conversion diagnostic: ${message}`);
    }
  }
});
