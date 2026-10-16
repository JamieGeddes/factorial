# Bootstrapping a Factorial account

All Factorial deployments run through GitHub Actions, with one exception: the foundation stack creates the role that GitHub Actions assumes, so it cannot deploy itself. A human deploys it once per account, and redeploys it only when the guardrails themselves change.

The foundation stack (`templates/00-foundation.yml`) creates:

| Resource | Purpose |
|---|---|
| GitHub OIDC provider | Lets GitHub Actions obtain AWS credentials without stored keys. |
| `factorial-deploy` role | Assumed only by Actions runs on `main` of this repository. Drives CloudFormation, publishes artefacts, and is the only principal that may move `live` aliases. It is explicitly denied from touching the foundation stack. |
| `factorial-cloudformation` role | Assumed by CloudFormation to create resources in Factorial's stacks. Scoped to `factorial-*` resource names, and may only create IAM roles that carry the permissions boundary. |
| `factorial-permissions-boundary` | Upper bound for every role Factorial creates. An allowlist of the services Factorial uses at runtime, so IAM, CloudFormation changes and everything else are outside it by construction, plus explicit denies on promotion, deployment artefacts and the foundation itself. |
| Artefact bucket | Packaged templates and Lambda bundles. |
| `factorial/agent-environment` ECR repository | The agent harness container image. |

## Prerequisites

- AWS CLI authenticated as an administrator of the target account, in `eu-west-1`.
- `cfn-lint` installed (`uv tool install cfn-lint` or `pipx install cfn-lint`).
- `gh` authenticated with admin access to the repository.

## Steps

1. Lint the template.

   ```sh
   cfn-lint
   ```

2. Deploy the stack. GitHub issues OIDC tokens with an immutable subject that embeds the owner and repository IDs, so the deploy role's trust policy needs both the names and the IDs.

   ```sh
   OWNER=<owner> REPO=<repository>
   aws cloudformation deploy \
     --stack-name factorial-foundation \
     --template-file templates/00-foundation.yml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       GitHubOwner="$OWNER" \
       GitHubRepository="$REPO" \
       GitHubOwnerId="$(gh api repos/$OWNER/$REPO --jq .owner.id)" \
       GitHubRepositoryId="$(gh api repos/$OWNER/$REPO --jq .id)" \
     --tags Project=Factorial \
     --no-fail-on-empty-changeset
   ```

   If a deploy run later fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`, compare the subject GitHub is sending (`gh api repos/$OWNER/$REPO/actions/oidc/customization/sub`) with the trust policy on the `factorial-deploy` role.

3. Give GitHub Actions the deploy role ARN. It contains the account ID, so it is a repository secret, never committed.

   ```sh
   gh secret set AWS_DEPLOY_ROLE_ARN --body "$(aws cloudformation describe-stacks \
     --stack-name factorial-foundation \
     --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" \
     --output text)"
   ```

Everything else is deployed by the `deploy` workflow on merge to `main`, which passes the `factorial-cloudformation` role to CloudFormation and reads the other foundation outputs through their `Factorial-*` exports.

## Human-provided secrets

Two kinds of secret are created by a human, never by a template, because their values must not pass through CloudFormation or the repository. Templates reference them by name.

**Model provider API key** (required before the agent stack can deploy). Enter the key at the prompt so it does not land in your shell history:

```sh
printf 'Model provider API key: '; read -rs MODEL_API_KEY; echo
aws secretsmanager create-secret \
  --name factorial/zai/api-key \
  --description "Z.ai API key used by the Factorial builder harness" \
  --secret-string "$(jq -n --arg apiKey "$MODEL_API_KEY" '{apiKey: $apiKey}')"
unset MODEL_API_KEY
```

To rotate it later, use `put-secret-value` with the same shape. The harness reads the current value on every invocation.

**GitHub App private key and identifiers**: see `docs/github-app.md`.

## Changing the foundation

Changes to this stack change Factorial's safety limits. They are made by a human, reviewed as such, and deployed by re-running step 2. The deploy role cannot do it.
