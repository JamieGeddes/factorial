# Session boundaries

Inside each AgentCore session, the host process runs as root, and everything the model makes happen runs as the unprivileged `agent` user (uid 1000). This page shows where pi draws that line. The threat model and the decisions behind each layer are in `docs/security.md` (sections 8 and 9). `docs/session-boundaries.html` is the same page for a browser.

Colours in the diagram: orange is root, green is the `agent` user, and blue marks the model's loop.

## pi host

![pi host: the model's loop runs inside the root host with the policy as an in-process extension and calls Bedrock itself; each tool call that runs a command or touches a file starts a process as the agent user.](session-boundaries/pi-host.svg)

pi runs the model's loop inside the root host, with the policy as an in-process extension. The loop never acts directly: it can only ask for tool calls. Each call that runs a command or touches a file starts a short-lived process as `agent`, through a `setpriv` drop with no capabilities.

## Compared with the Claude Agent SDK host (until 2026-10-30)

On the SDK the root host started Claude Code once as `agent`, through a `setpriv` wrapper; the model's loop, its subagents and every tool then ran as `agent`, and Claude Code asked the host's policy on each tool call and before ending, over the SDK's control channel.

| | Claude Agent SDK host | pi host |
|---|---|---|
| Where the model's loop runs | As `agent`, in the Claude Code subprocess | As root, inside the host process |
| Where privileges drop | Once, when the host starts Claude Code | On every tool call that runs a command or touches a file |
| How the policy is reached | Hook calls from the subprocess to the host | An in-process extension; no boundary is crossed |
| Who calls Bedrock | The subprocess, with the role's credentials in its environment | The host |
| Credentials in the model's shell | The execution role's, in its environment | None in its environment; the role stays reachable from the shell |
| A harness bug the model can trigger | Runs as `agent` | **Runs as root: pi's own code joins the trusted base** |

## The layers outside the session

The user split protects the host, its record and its code. The model's real reach is set by the layers outside the session, which no harness changes.

- **IAM: the execution role and the permissions boundary.** Only the named Bedrock profiles and the web search gateway. The boundary denies deploying or promoting Factorial.
- **The orchestrator: what leaves the session.** Only named, capped and validated files. Commits leave as a git bundle and are pushed from a clean-room clone. No GitHub credentials enter the session.
- **The in-session policy: a guard rail, not the gate.** Denying `git push` or writes outside `/workspace` narrows what a prompt injection can drive. The gates are the two layers above.

## Keeping this page current

The diagram is drawn by hand in `docs/session-boundaries.html`. The SVG in `docs/session-boundaries/` is a copy of that page's `<svg class="dia">` drawing, with a `<style>` block and a background rectangle added so it renders on GitHub in light and dark themes. Change the page first, then copy the changed drawing into the SVG file, keeping that file's `<style>` block and background.
