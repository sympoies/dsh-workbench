import { build } from 'esbuild';

const id = '@sympoies/dsh-workbench-web';
const result = await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  sourcemap: 'external',
  metafile: true,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
});

const allowed = new Set(['react', 'react/jsx-runtime']);
for (const output of Object.values(result.metafile.outputs)) {
  for (const item of output.imports) {
    if (item.external && !allowed.has(item.path)) {
      throw new Error(`Unexpected Client module-table request: ${item.path}`);
    }
  }
}
