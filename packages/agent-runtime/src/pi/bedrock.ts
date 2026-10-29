/**
 * pi's Bedrock provider with one change to its auth. pi resolves Bedrock auth
 * by looking for a credential source in the environment (a profile, static
 * keys, the ECS or web identity variables) and, finding none, reports no
 * credentials and refuses to start. AgentCore Runtime supplies the execution
 * role in a way that check does not see, so #166's first pi run failed with
 * "No API key found for amazon-bedrock" before any model call, although pi's
 * Bedrock client, which signs with the AWS SDK's default credential chain,
 * would have reached the model. This provider resolves to that chain instead.
 * It never carries an API key, so every request stays SigV4-signed with the
 * execution role and no bearer token is sent.
 */
import type { ApiKeyAuth, Provider } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

/** What pi reports as the auth source when nothing in the environment names one. */
export const DEFAULT_CHAIN = 'AWS SDK default credential chain';

export function bedrockProvider(base: Provider<'bedrock-converse-stream'> = amazonBedrockProvider()): Provider<'bedrock-converse-stream'> {
  const apiKey = base.auth.apiKey;
  if (!apiKey) throw new Error(`pi's ${base.id} provider has no API key auth to extend`);
  const resolve: ApiKeyAuth['resolve'] = async (input) => (await apiKey.resolve(input)) ?? { auth: {}, source: DEFAULT_CHAIN };
  return { ...base, auth: { ...base.auth, apiKey: { ...apiKey, resolve } } };
}
