/** Bundle the invoker, SDK included, into invoker/dist/ for the container image. */
import { build } from 'esbuild';

await build({
  entryPoints: { invoker: 'src/index.ts' },
  outdir: '../../invoker/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
