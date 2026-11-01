/**
 * `npm run snapshot:build`: bundles the static page (`app.tsx`, the app's own
 * views and styles, with `next/link`, `next/navigation` and `server-only`
 * replaced by `shims/`) and everything `capture.ts` wrote under
 * `snapshot-out/data/`, gzipped and base64-encoded, into one HTML file:
 * `snapshot-out/factorial-command-centre-<date>.html`. The file opens from
 * disk in any current browser, so it is the thing to send.
 */
import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'snapshot-out');

const html = (css: string, js: string, data: string, title: string): string => `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
<div id="root"></div>
<script id="snapshot-data" type="application/octet-stream">
${data}
</script>
<script>
${js.replace(/<\/script/gi, '<\\/script')}
</script>
</body>
</html>
`;

/** Every file under `dir`, by path relative to `base`. */
async function files(dir: string, base: string, into: Record<string, string>): Promise<void> {
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) await files(full, base, into);
    else into[path.relative(base, full).split(path.sep).join('/')] = await readFile(full, 'utf8');
  }
}

async function main(): Promise<void> {
  const data: Record<string, string> = {};
  await files(path.join(out, 'data'), out, data);
  const index = data['data/snapshot.json'];
  if (!index) throw new Error(`no snapshot-out/data/snapshot.json: run \`npm run snapshot:capture\` first`);
  const capturedAt = (JSON.parse(index) as { capturedAt: string }).capturedAt;
  const date = capturedAt.slice(0, 10);

  const result = await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'snapshot', 'app.tsx')],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { 'next/link': './snapshot/shims/link.tsx', 'next/navigation': './snapshot/shims/navigation.ts', 'server-only': './snapshot/shims/empty.ts' },
    legalComments: 'none',
    write: false,
    outdir: out,
    logLevel: 'warning',
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text;
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text;
  if (!js || !css) throw new Error('the bundle has no script or no stylesheet');

  const raw = Buffer.from(JSON.stringify(data));
  const packed = gzipSync(raw, { level: 9 }).toString('base64');
  const file = path.join(out, `factorial-command-centre-${date}.html`);
  const page = html(css, js, packed, `Factorial Command Centre, snapshot of ${date}`);
  await writeFile(file, page);
  const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
  console.log(`Built ${file}: ${mib(page.length)} (${Object.keys(data).length} data files, ${mib(raw.length)} before compression; snapshot of ${capturedAt}).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
