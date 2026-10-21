# Factorial

Factorial is a software factory: an agentic AI system that builds and refines software codebases, built on AWS AgentCore and associated AWS services. It builds itself incrementally.

`CLAUDE.md` is the authoritative description of requirements, target architecture, current stage and conventions. Start there.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Language-neutral, versioned contracts. `contracts/workitem/` is Factorial's API; `contracts/plan/` and `contracts/review/` are the planner's and reviewer's outputs, internal but versioned the same way. |
| `packages/` | TypeScript workspaces. `@factorial/workitem` validates the `WorkItem` contract; `@factorial/artefacts` holds the artefact store's key layout, redaction and upload; `@factorial/log` writes the structured log lines; `@factorial/plan` validates plans; `@factorial/review` validates reviews. |
| `templates/` | CloudFormation templates (`.yml`). |
| `scripts/` | Repository tooling, in TypeScript, run directly by Node. |
| `.github/workflows/` | CI and deployment. All deployments run through GitHub Actions. |
| `docs/` | Background material, including the original design conversation. |

## Running the checks locally

Requires Node 22 (the version in `.nvmrc`) and `cfn-lint` (`uv tool install cfn-lint` or `pipx install cfn-lint`). TypeScript runs directly under Node's type stripping, so there is no build step for tests or scripts.

Run `npm ci` once, then `npm run ci` before committing:

```sh
npm ci
npm run ci        # typecheck, build, tests, the .yml extension check, cfn-lint
```

Setting up a new AWS account for Factorial is described in `docs/bootstrap.md`. Finding everything a run produced, from its work item id, is described in `docs/finding-a-run.md`. The threat model and security design are in `docs/security.md`.
