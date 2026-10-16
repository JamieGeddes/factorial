/**
 * Enforce the convention that YAML files use the `.yml` extension, never `.yaml`.
 * A globbing mismatch between the two spellings is exactly the kind of thing that sends
 * an agent down a rabbit hole, so the repository allows only one.
 */
import { execFileSync } from 'node:child_process';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.length > 0);

const offenders = tracked.filter((file) => file.endsWith('.yaml'));

if (offenders.length > 0) {
  console.error('YAML files must use the .yml extension. Rename:');
  for (const file of offenders) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

console.log(`yml extension check passed (${tracked.length} tracked files).`);
