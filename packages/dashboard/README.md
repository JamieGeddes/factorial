# @factorial/dashboard

The command centre (#57, #58): a local, read-only operations console for one reviewer, run with their own AWS credentials. `docs/dashboard.md` is the full description: how to run it, the access it needs, the localhost protections, the data source for every panel and the intended move to Fargate. `docs/mockups/command-centre.html` is the design specification.

```sh
AWS_PROFILE=<your profile> npm run dashboard     # from the repository root
```

It binds to `127.0.0.1:4757` (`DASHBOARD_PORT`) and prints a URL with a fresh token; nothing is served without it.

| Path | Contents |
|---|---|
| `scripts/start.ts` | The launcher: token, build if needed, `next start` on 127.0.0.1; on Ctrl-C it kills the server if it is still running 5 seconds later. |
| `scripts/shutdown.ts` | The launcher's stop timing (grace period, second signal), with injected timers so it is tested without Next.js. |
| `src/proxy.ts`, `src/server/guard.ts` | Host check, token-to-cookie exchange, CSP with nonces. |
| `src/server/` | Server-only modules, one per source, and the route handlers' logic (`handlers.ts`). The only code that touches an AWS SDK. |
| `src/lib/` | Pure modules shared with the browser: the status mapping, the Work items rows and filters, the Overview (`overview.ts`), the run view (`run-view.ts`), run events and the transcript (`transcript.ts`), stage durations, formats, links, sanitising. |
| `src/client/` | The tab's live stream, the status bar's data, the shared clock, a view's refresh, a run's events and the virtualised list. |
| `src/components/` | The shell, charts (inline SVG), tiles, pills, meters, chips, tables, and the Overview, Work items and Run & transcript views. |
| `src/app/` | Routes: `/`, `/work-items`, `/work-items/<id>`, `/runs`, `/runs/<id>/<stage>/<round>`, `/metrics`, `/health`, and `/api/*`. |

`npm test` runs the tests on the source (`test/register.ts` compiles `.tsx` with esbuild); `npm run build` is `next build`; both run in `npm run ci`.
