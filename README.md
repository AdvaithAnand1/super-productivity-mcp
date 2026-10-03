# Super Productivity MCP (Community Fork)

[![CI](https://github.com/AdvaithAnand1/super-productivity-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AdvaithAnand1/super-productivity-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

A local Model Context Protocol (MCP) server that lets MCP clients inspect and manage tasks in the Super Productivity desktop app. It communicates over STDIO and uses Super Productivity’s loopback REST API. Normal task management works with an unmodified released desktop app; a separately modified app build adds a capability-discovered semantic API for operations the stock API does not expose.

This community-maintained fork expands [Amorem’s original Super Productivity MCP](https://github.com/Amorem/super-productivity-mcp) with richer task context, safer metadata updates, bounded bulk operations, and optional enhanced semantic API tools. The MIT license and upstream attribution are retained. This repository is distributed on GitHub; this fork has not been published to npm.

## Features

- Search and read tasks with project, tag, parent, subtask, and attachment context.
- Create tasks and apply sparse metadata updates: omitted fields are preserved.
- Plan Today, manage timers and task lifecycle, and query overdue/upcoming/unscheduled queues.
- Resolve projects and tags by exact unique names; preview and apply bounded bulk updates.
- Associate a GitHub issue with one local task when explicitly asked. The server does not call GitHub.
- With the enhanced app API: set priority, change hierarchy and ordering, adjust historical time, manage projects/tags, and safely edit web-link attachment metadata.

## Stock and enhanced modes

| Stock mode: unmodified desktop app                                                            | Enhanced mode: compatible local source build                                                            | Read-only or intentionally unsupported                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Search and full task/context reads; project and tag lists                                     | Priority set/clear; task parent assign, reparent, and promote                                           | Recurrence configuration and behavior writes                                       |
| Create tasks; sparse updates to supported metadata, schedule, deadlines, completion, and tags | Ordered moves in projects, backlog, tags/Today, and subtasks                                            | Local file/image attachment writes and binary transfer                             |
| Today planning, timer control, complete/archive/restore/delete                                | Add/remove historical time by date in integer milliseconds                                              | Provider-specific issue metadata edits; board/section membership writes            |
| Date-based task queues, bulk sparse updates, explicit GitHub issue association                | Create/rename/delete-empty projects and tags; add HTTP(S) links, rename or detach attachment references | Full recurrence configuration is not currently returned as normalized task context |

Enhanced tools check the app’s advertised capabilities and report unavailable features when those routes are absent. See [the detailed capability matrix](docs/FEATURES.md) for the status and evidence of each operation, and [the architecture note](docs/architecture.md) for the request flow. The enhanced routes are not in released stock Super Productivity builds unless and until the app maintainers adopt them.

## Requirements and installation

- Super Productivity **desktop** 18.16.0 or newer, with **Settings → Misc Settings → Enable local REST API** enabled. Web and mobile versions do not expose this local API.
- Node.js 20 or newer.
- One MCP host, such as ChatGPT Desktop or Codex Desktop/CLI.

To use this fork, clone and build it locally:

```bash
git clone https://github.com/AdvaithAnand1/super-productivity-mcp.git
cd super-productivity-mcp
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Then point your MCP host at the local `dist/index.js` entry point. The existing npm package name belongs to the original published distribution; running `npx -y super-productivity-mcp-server` installs that published release, not this GitHub fork. See [ChatGPT Desktop setup](examples/chatgpt-desktop.md) and the [Codex configuration example](examples/codex-config.toml) for host-specific configuration.

After enabling the local REST API and restarting the MCP host, call `check_connection`. A healthy result reports the app API and renderer ready. You can also check local liveness with:

```bash
curl --noproxy 127.0.0.1 http://127.0.0.1:3876/health
```

## Tool overview

The server exposes explicit tools for connection checks, task search/queues/context, project and tag lookup, task creation and sparse updates, tag membership, Today planning, timers, completion, archive/restore/delete, bounded bulk changes, and GitHub issue association. Enhanced-only tools provide priority, hierarchy, ordering, historical time, project/tag administration, and limited attachment metadata operations.

Important behavior:

- Mutations target explicit task/project/tag IDs. Exact unique names may be used where offered; ambiguity is an error.
- `update_task` changes only supplied fields. Empty notes clear notes; `null` clears supported nullable date/time fields.
- `bulk_update_tasks` previews by default, accepts at most 25 task IDs, and stops after an uncertain write.
- `adjust_task_time` takes a positive integer number of milliseconds and a `YYYY-MM-DD` date. It edits historical totals, not timer sessions.
- `delete_task` permanently deletes the selected task and its subtasks. Use `archive_task` to hide a task reversibly.
- Project and tag deletion are limited to empty objects; the virtual Today tag is protected.
- Link attachments accept HTTP(S) URLs only. Creating one does not fetch its URL. Detaching removes the reference and does not delete the target.

## Enhanced API setup

The semantic API extension lives in the Super Productivity source checkout. Build and run that modified desktop app with its local REST API enabled. The MCP discovers support at `GET /bridge/capabilities` before enhanced operations. The `/bridge/` path is the current route prefix retained by this implementation; user-facing documentation calls it the enhanced semantic API.

The enhanced API remains on loopback and uses the app’s Bearer-token authorization for protected routes. The released app does not include these routes, so enhanced tools remain unavailable on stock releases. For a development build, set `SP_API_TOKEN` to the access token provided by the app. Do not put tokens in chat, source control, or logs. The app patch and a proposal for upstream review are tracked separately from this MCP package.

## MCP client configuration

ChatGPT Desktop’s MCP settings can add a STDIO server. To use this fork, set command `node` and point it to the local `dist/index.js` built from the checkout. The `npx -y super-productivity-mcp-server` command runs the original published npm distribution.

Codex Desktop and CLI use the shared `config.toml` configuration. For a local fork checkout, add this block and replace the example path:

```toml
[mcp_servers.super_productivity]
command = "node"
args = ["/path/to/super-productivity-mcp/dist/index.js"]
env = { SP_API_URL = "http://127.0.0.1:3876", SP_LOG_LEVEL = "warn" }
```

Restart the MCP host and use `check_connection`. The server accepts these environment variables:

| Variable                    | Default                         | Purpose                                                     |
| --------------------------- | ------------------------------- | ----------------------------------------------------------- |
| `SP_API_URL`                | `http://127.0.0.1:3876`         | Stock local REST API base URL; loopback required by default |
| `SP_API_TOKEN`              | unset                           | Optional Bearer token for authenticated app builds          |
| `SP_SEMANTIC_API_URL`       | `http://127.0.0.1:3876/bridge/` | Enhanced semantic API base URL                              |
| `SP_API_TIMEOUT_MS`         | `15000`                         | Request timeout, integer from 1000 to 60000                 |
| `SP_ALLOW_NON_LOOPBACK_URL` | `false`                         | Allows a trusted local proxy when explicitly enabled        |
| `SP_LOG_LEVEL`              | `warn`                          | `error`, `warn`, `info`, or `debug`                         |

## Security and privacy

- MCP uses STDIO; stdout is reserved for protocol messages and diagnostics go to stderr.
- Both configured API URLs must be loopback unless `SP_ALLOW_NON_LOOPBACK_URL=true` is deliberately set for a trusted local proxy.
- `/health` is unauthenticated. Protected routes use the optional app token when required by that build. The stock 18.16.0 app API does not require a token; keep it on loopback because local apps under the same user can access it.
- Tokens are not logged, and token-like values are redacted from diagnostics.
- The app extension exposes explicit, validated operations. It does not provide a generic state setter or arbitrary service invocation.
- No local file attachment path can be added or read through the MCP. Image attachments may cause renderer network access, so remote image mutation is not offered.
- The server makes no background requests to GitHub. `ensure_github_issue_task` only parses a supplied issue reference and searches/updates local tasks.

## Compatibility and limitations

Stock behavior follows the versioned local REST API exposed by the installed desktop app. The no-token setup matches the released 18.16.0 handler. Enhanced behavior was built and live-tested against Super Productivity 19.1.0 source at commit `54a3793`; it requires a compatible app build with the enhanced route set. Capability discovery allows the package to run against stock builds without pretending those writes are available.

Recurrence writes are intentionally unsupported because recurrence configuration drives generated task lifecycle, exceptions, schedule cursors, completion gates, and templates. Local file/image attachment writes and attachment binary transfer are unavailable. Provider-specific issue metadata and board/section membership are not writable through these tools. Details and verification status are in [docs/FEATURES.md](docs/FEATURES.md).

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:3876`:** open the Super Productivity desktop app, enable its local REST API, and wait for the renderer to finish starting.
- **`401 Unauthorized`:** only set `SP_API_TOKEN` to the token from an app build that requires one. The stock 18.16.0 API does not require a token.
- **Enhanced capability unavailable:** expected on a released stock app. Use the compatible modified app build for that operation; ordinary stock-mode tools remain available.
- **Ambiguous project/tag name:** use the exact ID returned by the corresponding list tool.

## Windows native setup

The app source and MCP server use different Node targets. Super Productivity pins Node 22.18.0 in its .nvmrc; the MCP supports Node 20 and newer and was verified here on Node 24 with pnpm 10.12.4. Keep those runtimes local to their checkouts when needed instead of replacing a working system Node installation.

For an app build, place a portable Node 22.18.0 distribution first on the current PowerShell process PATH, then build from the native app checkout:

```powershell
$node22Root = 'C:\Users\YOURNAME\Documents\Dev\.tools\node-v22.18.0-win-x64'
$env:PATH = "$node22Root;$env:PATH"
node --version
npm ci
npm run dist:win
```

The Windows artifacts are written under .tmp/app-builds. The configured Windows targets include x64 and ARM64. The unpacked x64 app can be started directly for isolated testing; installing the generated installer is not required for an MCP development check.

From the MCP checkout, install and verify the server with:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
corepack pnpm smoke:package
```

The package smoke test installs the packed tarball in a fresh temporary directory, checks the STDIO handshake and all 29 tools, and uses an ephemeral diagnostic port. It does not need the desktop app or port 3876.

For a local Codex setup, copy the template in [examples/windows-codex-config.toml](examples/windows-codex-config.toml) and replace the checkout path. It contains no token. Keep SP_API_URL and SP_SEMANTIC_API_URL on loopback, and pass SP_API_TOKEN through the host environment only when the app build requires one. Enable the app local REST API in its settings before connecting. Only one API-enabled app instance can use port 3876 at a time.

The checked-in live smoke script currently runs on Linux/WSL. The Windows live API check for this release candidate used the unpacked x64 build and a disposable user-data directory; the exact setup and outcomes are recorded in [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md).

## Development and verification

Use Node.js 24 and pnpm 10.12.4 for the verified development setup:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:check
```

`pnpm verify` runs lint, formatting, typecheck, tests, and build. `pnpm pack:check` builds and inspects the npm package contents. Unit and in-memory integration tests do not require the desktop app. Live enhanced checks require a deliberately disposable app profile. The guarded `pnpm smoke:live` script refuses to run without explicit destructive-test opt-in and a free API port; see `docs/RELEASE_RUNBOOK.md` in the repository.

## License and credits

This MCP project is distributed under the MIT License; see [LICENSE](LICENSE). It is an independent integration for Super Productivity and is not an official project endorsement. The separately proposed app changes are based on the Super Productivity source repository, also MIT licensed, and retain its existing copyright and license notice in that repository. See [the provenance note](docs/UPSTREAM_PROPOSAL.md).
