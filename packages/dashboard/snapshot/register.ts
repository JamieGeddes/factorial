/**
 * Lets Node run the snapshot scripts on the dashboard's source: `.tsx` files
 * through esbuild and `server-only` as an empty module (`test/hooks.ts`).
 * Unlike the tests' `register.ts` it leaves the time zone alone: the
 * snapshot's days are the capturing machine's, as the live app's are.
 */
import { register } from 'node:module';

register('../test/hooks.ts', import.meta.url);
