# The Factorial GitHub App

Factorial acts on GitHub as a GitHub App, not as a person. The App receives issue webhooks and, in later stages, pushes branches and opens pull requests. Because the App is the author of Factorial's PRs, a human approving them is a real second party.

Creating the App is a one-off, done by a human. The triggers stack must be deployed first, because the webhook URL and secret come from it.

## 1. Collect the webhook URL and secret

Run these in your own terminal (the secret should not be pasted into shared logs or chat):

```sh
aws cloudformation describe-stacks --stack-name factorial-triggers \
  --query "Stacks[0].Outputs[?OutputKey=='GitHubWebhookUrl'].OutputValue" --output text

aws secretsmanager get-secret-value --secret-id factorial/github/webhook-secret \
  --query SecretString --output text
```

## 2. Create the App

1. On GitHub, open your profile menu, **Settings**, then in the left nav **Developer settings**, **GitHub Apps**, and click **New GitHub App**.
2. **GitHub App name:** `Factorial (<your login>)`. App names are global, so include something unique.
3. **Homepage URL:** the URL of this repository.
4. Under **Webhook**, tick **Active**. **Webhook URL:** the function URL from step 1. **Secret:** the secret from step 1.
5. Under **Permissions**, expand **Repository permissions** and set:

   | Permission | Access | Why |
   |---|---|---|
   | Metadata | Read-only | Mandatory. |
   | Issues | Read and write | Receive issue events; comment progress back on the issue. |
   | Contents | Read and write | Clone and push branches. |
   | Pull requests | Read and write | Open the PR. |
   | Actions | Read and write | Dispatch the test workflow and read its result. |

6. Under **Subscribe to events**, tick **Issues**.
7. Under **Where can this GitHub App be installed?**, choose **Only on this account**.
8. Click **Create GitHub App**.

## 3. Generate the private key

1. On the App's **General** page, scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads.
2. Note the **App ID** shown at the top of the same page.
3. Store the key in Secrets Manager and delete the downloaded file:

   ```sh
   aws secretsmanager create-secret \
     --name factorial/github/app-private-key \
     --description "Private key of the Factorial GitHub App" \
     --secret-string file://<downloaded>.pem
   rm <downloaded>.pem
   ```

## 4. Install the App on the repository

1. In the App's left nav click **Install App**, then **Install** next to your account.
2. Choose **Only select repositories**, select the Factorial repository, and click **Install**.
3. The URL you land on ends in the **installation ID**.
4. Record both identifiers where the agent environment reads them:

   ```sh
   aws ssm put-parameter --name /factorial/github/app-id --type String --value <app id> --overwrite
   aws ssm put-parameter --name /factorial/github/installation-id --type String --value <installation id> --overwrite
   ```

   Only the orchestrator's Lambda functions read these and the private key. They mint one-hour installation tokens scoped to the single target repository. The agent sandbox has no access to the key, the identifiers or any token.

   Note that an installation token with `contents: write` can push to any branch of the repository, including `main`. On a private repository on the GitHub Free plan branch protection is unavailable, so the only safeguard is that the orchestrator pushes exclusively to `factorial/*` branches and the agent holds no token at all. Enable branch protection on `main` as soon as the plan allows it.

## 5. Verify the webhook

1. Back on the App's page, open **Advanced** in the left nav. The **Recent Deliveries** list shows the `ping` GitHub sent when the webhook was saved. It should show a `200` response.
2. Create a label named `factorial` in the repository (**Issues**, **Labels**, **New label**).
3. Open a test issue and add the `factorial` label. Only users listed in the triggers stack's `AllowedGitHubUserIds` parameter (default: the repository owner) can trigger work: both the issue author and whoever applies the label must be listed, otherwise the delivery returns `202` with an "untrusted user" reason and no WorkItem is created. The delivery for the `issues` event should show `202` with a `workItemId` in the response body, and the adapter's log group `/aws/lambda/factorial-github-issues-adapter` should contain a `WorkItem created` line.

Until the orchestration stack exists, nothing consumes the event. That is expected.
