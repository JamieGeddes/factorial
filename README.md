# Factorial

Factorial is a software factory: an agentic AI system that builds and refines software codebases, built on AWS AgentCore and associated AWS services. It builds itself incrementally.

`CLAUDE.md` is the authoritative description of requirements, target architecture, current stage and conventions. Start there.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Language-neutral, versioned contracts. `contracts/workitem/` is Factorial's API. |
| `packages/` | TypeScript workspaces. `@factorial/workitem` validates the `WorkItem` contract. |
| `templates/` | CloudFormation templates (`.yml`). |
| `scripts/` | Repository tooling, in TypeScript, run directly by Node. |
| `.github/workflows/` | CI and deployment. All deployments run through GitHub Actions. |
| `docs/` | Background material, including the original design conversation. |

## Development

Requires Node 22.18 or later (see `.nvmrc`). TypeScript runs directly under Node's type stripping, so there is no build step for tests or scripts.

```sh
npm ci
npm run ci        # typecheck, test, and the .yml extension check
```
