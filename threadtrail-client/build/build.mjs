/**
 * Client bundle build: esbuild bundles `src/client.ts` (and its modules) into
 * an IIFE with `react` external, then wraps it in the module-loader contract:
 *
 *   window.__ModuleLoader__.load({
 *     id: "threadtrail-client",
 *     factory: function (require) { <bundle>; return ThreadTrailClient; },
 *   });
 *
 * Nesting the bundle inside the factory is what makes the bundle's external
 * `require("react")` calls resolve through the loader's module table at
 * runtime. The served URL stays `/plugins/threadtrail-client/client.js`
 * (exports["./client"] → dist/client.js).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outBundle = path.join(dist, '_bundle.js');
const outFinal = path.join(dist, 'client.js');

await build({
  entryPoints: [path.join(root, 'src', 'client.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'ThreadTrailClient',
  external: ['react'],
  jsx: 'transform',
  jsxFactory: 'createElement',
  jsxFragment: 'Fragment',
  target: 'es2020',
  platform: 'neutral',
  outfile: outBundle,
  logLevel: 'info',
  sourcemap: false,
});

const body = readFileSync(outBundle, 'utf8');
const out = `window.__ModuleLoader__.load({
  id: "threadtrail-client",
  factory: function (require) {
${body}
    return ThreadTrailClient;
  },
});
`;
writeFileSync(outFinal, out);
rmSync(outBundle, { force: true });
console.log('built dist/client.js');
