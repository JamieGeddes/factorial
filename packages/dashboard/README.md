# @factorial/dashboard

The command centre (#57): a local, read-only operations console for one reviewer, run with their own AWS credentials. `docs/dashboard.md` is the full description: how to run it, the access it needs, the localhost protections, the data source for every panel and the intended move to Fargate. `docs/mockups/command-centre.html` is the design specification.

```sh
AWS_PROFILE=<your profile> npm run dashboard     # from the repository root
```

It binds to `127.0.0.1:4757` (`DASHBOARD_PORT`) and prints a URL with a fresh token; nothing is served without it.

| Path | Contents |
|---|---|
| `scripts/start.ts` | The launcher: token, build if needed, `next start` on 127.0.0.1. |
| `src/proxy.ts`, `src/server/guard.ts` | Host check, token-to-cookie exchange, CSP with nonces. |
| `src/server/` | Server-only modules, one per source, and the route handlers' logic (`handlers.ts`). The only code that touches an AWS SDK. |
| `src/lib/` | Pure modules shared with the browser: the status mapping, the Work items rows and filters, formats, links, sanitising. |
| `src/client/` | The tab's live stream, the status bar's data, the shared clock. |
| `src/components/` | The shell, charts (inline SVG), tiles, pills, meters, chips, tables, and the Work items view. |
| `src/app/` | Routes: `/`, `/work-items`, `/work-items/<id>`, `/runs`, `/runs/<id>/<stage>/<round>`, `/metrics`, `/health`, and `/api/*`. |

`npm test` runs the tests on the source (`test/register.ts` compiles `.tsx` with esbuild); `npm run build` is `next build`; both run in `npm run ci`.
