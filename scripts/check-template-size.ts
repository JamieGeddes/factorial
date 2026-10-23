/**
 * Keep the foundation template under CloudFormation's 51,200-byte limit for an inline
 * template body. A human deploys it with `--template-file` and no S3 bucket
 * (`docs/bootstrap.md`), so a larger template only fails at that deploy. The other
 * templates go through S3 in the deploy workflow, where the limit is 1 MB.
 */
import { statSync } from 'node:fs';

const template = 'templates/00-foundation.yml';
const limit = 51_200;
const size = statSync(template).size;

if (size > limit) {
  console.error(`${template} is ${size} bytes, over the ${limit}-byte inline template limit.`);
  process.exit(1);
}

console.log(`template size check passed (${template}: ${size} of ${limit} bytes).`);
