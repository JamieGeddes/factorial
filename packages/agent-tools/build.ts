/**
 * Bundle the in-image tools into agent-environment/dist/. Unlike the Lambda
 * bundles, the AWS SDK is included: the container has no runtime-provided SDK.
 */
import { build } from 'esbuild';

await build({
  entryPoints: { 'factorial-github-token': 'src/github-token.ts' },
  outdir: '../../agent-environment/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
