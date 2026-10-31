/**
 * Lets `node --test` run the dashboard's tests on its source: `.tsx` files
 * are compiled with esbuild (Node strips types from `.ts` itself), `server-only`
 * resolves to an empty module (Next.js gives it meaning, Node does not), and
 * Next.js's extensionless subpaths (`next/link`) resolve to their files.
 */
import { register } from 'node:module';

register('./hooks.ts', import.meta.url);
