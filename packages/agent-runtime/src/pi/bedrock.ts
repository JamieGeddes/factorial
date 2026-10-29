/**
 * pi's Bedrock provider with one change to its auth. Before each model call
 * pi asks the provider how to authenticate. pi's own answer looks for a
 * credential source named in the environment (a profile, static keys, the
 * ECS or web identity variables) and, finding none, says the provider is not
 * configured, so pi refuses to start. AgentCore Runtime sets none of them, so
 * #166's first pi run failed with "No API key found for amazon-bedrock"
 * before any model call, although pi's Bedrock client, which signs with the
 * AWS SDK's default credential chain, would have reached the model with the
 * execution role. This provider answers "configured, with no key" instead,
 * and the client finds the credentials itself. With no key pi never switches
 * to bearer-token auth, so every request stays SigV4-signed with the
 * execution role.
 */
import type { ApiKeyAuth, Provider } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

/** What pi reports as the auth source when nothing in the environment names one. */
export const DEFAULT_CHAIN = 'AWS SDK default credential chain';

export function bedrockProvider(base: Provider<'bedrock-converse-stream'> = amazonBedrockProvider()): Provider<'bedrock-converse-stream'> {
  // pi names its non-OAuth auth method `apiKey`; for Bedrock it covers every
  // source above, not only keys. This checks that pi's provider defines the
  // method at all, which pi 1.4.0's always does: a later pi that moved it
  // would fail here at startup rather than leave the fallback unapplied.
  const piAuth = base.auth.apiKey;
  if (!piAuth) throw new Error(`pi's ${base.id} provider no longer defines its auth method in auth.apiKey; bedrock.ts needs updating`);
  // pi's own answer when it finds a source; otherwise no key, and the chain's credentials.
  const resolve: ApiKeyAuth['resolve'] = async (input) => (await piAuth.resolve(input)) ?? { auth: {}, source: DEFAULT_CHAIN };
  return { ...base, auth: { ...base.auth, apiKey: { ...piAuth, resolve } } };
}
