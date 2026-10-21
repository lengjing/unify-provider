import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  // Bundle workspace packages from source so the extension never ships stale dist output
  // and does not depend on workspace build order.
  alias: {
    '@unify-provider/core': `${here}../core/src/index.ts`,
    '@unify-provider/local-endpoint': `${here}../local-endpoint/src/index.ts`,
  },
  sourcemap: true,
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
} else {
  await build(options);
}
