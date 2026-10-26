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
   | Pull requests | Read and write | Open the PR; check a PR and read a review's comments before rework, reply on it and re-request review. |
   | Actions | Read and write | Dispatch the test workflow and read its result. Rework of failed checks also reads the failing jobs' logs (the orchestrator's token is narrowed to `actions: read` for that). |
   | Workflows | Read and write | Push branches that change files under `.github/workflows/`. GitHub rejects such pushes otherwise. The orchestrator requests this permission on a token only when the change edits a workflow file. |

6. Under **Subscribe to events**, tick **Issues**, **Issue comment**, **Pull request review**, **Pull request review comment** and **Workflow run**. The last four let Factorial rework its own pull requests (see **Pull request events** below).
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

   Note that an installation token with `contents: write` can push to any branch of the repository, including `main`. `main` is therefore protected by a repository ruleset ("Protect main", applied 2026-10-17): changes reach it only through a pull request with one approving review from a code owner, both CI jobs ("Typecheck, test and lint" and "Lint CloudFormation") must pass, and force pushes and deletions are blocked. The repository admin role bypasses the ruleset so the owner can still commit directly at this stage; the Factorial App is not a bypass actor, so its `contents: write` token cannot reach `main`. The ruleset is managed in **Settings → Rules → Rulesets** and was created with:

```sh
gh api -X POST repos/<owner>/<repo>/rulesets --input ruleset.json
```

where `ruleset.json` targets `~DEFAULT_BRANCH` with the rules `deletion`, `non_fast_forward`, `pull_request` (1 review, code owners, dismiss stale reviews) and `required_status_checks` for the two CI job names, and lists `RepositoryRole` 5 (admin) with `bypass_mode: always`.

## 5. Verify the webhook

1. Back on the App's page, open **Advanced** in the left nav. The **Recent Deliveries** list shows the `ping` GitHub sent when the webhook was saved. It should show a `200` response.
2. Create a label named `factorial` in the repository (**Issues**, **Labels**, **New label**).
3. Open a test issue and add the `factorial` label. Only users listed in the triggers stack's `AllowedGitHubUserIds` parameter (default: the repository owner) can trigger work: both the issue author and whoever applies the label must be listed, otherwise the delivery returns `202` with an "untrusted user" reason and no WorkItem is created. The delivery for the `issues` event should show `202` with a `workItemId` in the response body, and the adapter's log group `/aws/lambda/factorial-github-issues-adapter` should contain a `WorkItem created` line.

Until the orchestration stack exists, nothing consumes the event. That is expected.

## Pull request events

Factorial reworks a pull request it opened when a trusted user (the triggers stack's `AllowedGitHubUserIds`) submits a review with **Request changes**, or writes a comment whose first word is `@<slug>` (for example `@factorial-jamiegeddes please add a test`), either in the conversation or inline on the diff; and, at most twice in a row without a person asking, when a workflow run fails on the pull request's head. `<slug>` is the App's slug, the triggers stack's `GitHubAppSlug` parameter. GitHub does not offer the App in mention autocompletion, so type it in full. Comments without the mention, from anyone else, or from bots do nothing. An inline comment is a review point; a comment in the conversation is a request of its own (`comment`), and no review is re-requested after it. Factorial reacts with eyes to a comment it has taken, and replies on the pull request when the rework finishes or cannot start. It acts only on pull requests its ledger records opening, so not on ones opened before this was deployed.

An App created before these events were added needs them subscribed. No permission changes, so the installation needs no re-approval.

1. Click your profile photo, then **Settings**, then **Developer settings** at the bottom of the left nav, then **GitHub Apps**, then **Edit** next to the Factorial App.
2. In the left nav click **Permissions & events**. Scroll to **Subscribe to events** and tick **Issue comment**, **Pull request review**, **Pull request review comment** and **Workflow run**. Leave **Issues** ticked.
3. Scroll down and click **Save changes**.
4. Check it: in the left nav click **Advanced**. Comment on a Factorial pull request without the mention; **Recent Deliveries** shows an `issue_comment` delivery answered `202` with "comment does not address Factorial".

## Adding a permission later

Changing the App's permissions does not change existing installations until the installation owner accepts the new permissions.

1. Click your profile photo, then **Settings**, then **Developer settings** at the bottom of the left nav, then **GitHub Apps**, then **Edit** next to the Factorial App.
2. In the left nav click **Permissions & events**. Under **Repository permissions**, set the permission (for example **Workflows** to **Read and write**), scroll down and click **Save changes**.
3. Accept it on the installation: profile photo, **Settings**, **Applications** in the left nav, the **Installed GitHub Apps** tab, **Configure** next to the Factorial App. A banner reads "This app has requested new permissions"; click **Review request**, then **Accept new permissions**.
