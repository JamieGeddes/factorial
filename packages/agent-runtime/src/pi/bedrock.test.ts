import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AuthContext } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { DEFAULT_CHAIN, bedrockProvider } from './bedrock.ts';

/** The variables pi's Bedrock auth looks for. */
const CREDENTIAL_VARIABLES = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
];

const context = (env: Record<string, string>): AuthContext => ({ env: async (name) => env[name], fileExists: async () => false });
const resolve = (env: Record<string, string>) => bedrockProvider().auth.apiKey!.resolve({ ctx: context(env), signal: new AbortController().signal });

/** Runs `body` with none of pi's Bedrock credential variables set, as on the Runtime. */
async function withoutCredentialVariables<T>(body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(CREDENTIAL_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of CREDENTIAL_VARIABLES) delete process.env[name];
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
}

const modelRuntime = () => ModelRuntime.create({ authPath: path.join(mkdtempSync(path.join(tmpdir(), 'pi-auth-')), 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });

describe('bedrockProvider', () => {
  it('falls back to the default credential chain, with no API key, when the environment names no source', async () => {
    assert.deepEqual(await resolve({}), { auth: {}, source: DEFAULT_CHAIN });
  });

  it("keeps pi's own resolution when the environment names a source", async () => {
    assert.equal((await resolve({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }))?.source, 'AWS access keys');
  });

  it("makes pi's model runtime treat Bedrock as configured with no credential variables, which pi's own provider does not", async () => {
    await withoutCredentialVariables(async () => {
      const own = await modelRuntime();
      assert.equal(await own.checkAuth('amazon-bedrock'), undefined);
      const runtime = await modelRuntime();
      runtime.registerNativeProvider(bedrockProvider());
      assert.equal((await runtime.checkAuth('amazon-bedrock'))?.source, DEFAULT_CHAIN);
      assert.equal((await runtime.getAuth('amazon-bedrock'))?.auth.apiKey, undefined);
      assert.ok(runtime.getModel('amazon-bedrock', 'global.anthropic.claude-sonnet-5-5'));
    });
  });
});
