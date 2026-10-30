/**
 * Bundle the adapter into a single ESM file for Lambda, the AWS SDK included:
 * the nodejs24.x runtime's copy changes with AWS's runtime updates
 * (packages/orchestration/build.ts has the incident).
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // Bundled CommonJS dependencies may call require(); give them a working one.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
