/**
 * Bundle the adapter into a single ESM file for Lambda. The AWS SDK is provided
 * by the nodejs22.x runtime, so it is left external.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['@aws-sdk/*'],
  // Bundled CommonJS dependencies may call require(); give them a working one.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
