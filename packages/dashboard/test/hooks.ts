import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { transform } from 'esbuild';

type Resolve = (specifier: string, context: unknown) => Promise<{ url: string }>;
type Load = (url: string, context: unknown) => Promise<{ format?: string; source?: unknown }>;

export async function resolve(specifier: string, context: unknown, next: Resolve): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === 'server-only') return { url: 'data:text/javascript,', shortCircuit: true };
  if (/^next\/[a-z-]+$/.test(specifier)) return next(`${specifier}.js`, context);
  return next(specifier, context);
}

export async function load(url: string, context: unknown, next: Load): Promise<{ format?: string; source?: unknown; shortCircuit?: boolean }> {
  if (!url.endsWith('.tsx')) return next(url, context);
  const path = fileURLToPath(url);
  const result = await transform(await readFile(path, 'utf8'), { loader: 'tsx', jsx: 'automatic', format: 'esm', sourcefile: path, sourcemap: 'inline' });
  return { format: 'module', source: result.code, shortCircuit: true };
}
