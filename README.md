# Factorial

Factorial is a software factory: an agentic AI system that builds and refines software codebases, built on AWS AgentCore and associated AWS services. It builds itself incrementally.

`CLAUDE.md` holds what is agreed and binding: the requirements, the target architecture, what is fixed from day one, the shape of the current stage and the conventions. `docs/current-stage.md` describes how the deployed system works, stage by stage. Start with the first, read the second for detail.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Language-neutral, versioned contracts. `contracts/workitem/` is Factorial's API; `contracts/plan/` and `contracts/review/` are the builder's plan and the reviewer's output, internal but versioned the same way. |
| `packages/` | TypeScript workspaces. `@factorial/workitem` validates the `WorkItem` contract; `@factorial/artefacts` holds the artefact store's key layout, redaction and upload; `@factorial/log` writes the structured log lines; `@factorial/plan` validates plans; `@factorial/review` validates reviews; `@factorial/roles` holds the role manifests. |
| `templates/` | CloudFormation templates (`.yml`). |
| `scripts/` | Repository tooling, in TypeScript, run directly by Node. |
| `.factorial/` | How Factorial treats this repository as a target, like any other: `sensitive-paths.json` lists the changes its reviews flag for care. |
| `.github/workflows/` | CI and deployment. All deployments run through GitHub Actions. |
| `docs/` | `current-stage.md` (how the deployed system works), `finding-a-run.md`, `security.md`, `architecture-principles.md`, the bootstrap and GitHub App guides, `harness-vs-runtime.md` (the Harness-or-Runtime evaluation, since superseded), `agent-sdk-plan.md` (how the agents moved to the Claude Agent SDK on Runtime), the design proposals (`design-plan.md`, `design-extension-points.md`) and the original design conversation. |

## Running the checks locally

Requires Node 22 (the version in `.nvmrc`) and `cfn-lint` (`uv tool install cfn-lint` or `pipx install cfn-lint`). TypeScript runs directly under Node's type stripping, so there is no build step for tests or scripts.

Run `npm ci` once, then `npm run ci` before committing:

```sh
npm ci
npm run ci        # typecheck, build, tests, the .yml extension check, cfn-lint
```

Setting up a new AWS account for Factorial is described in `docs/bootstrap.md`. Finding everything a run produced, from its work item id, is described in `docs/finding-a-run.md`. The threat model and security design are in `docs/security.md`.
