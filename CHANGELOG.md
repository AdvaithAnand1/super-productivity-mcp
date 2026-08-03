# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-08-03

### Added

- STDIO MCP server for Super Productivity's official local REST API.
- Connection health checks, task search, Today listing, task planning, timer control, completion,
  and current-task lookup.
- Explicit GitHub issue association with URL and `owner/repo#number` parsing.
- Marker-based idempotency and ambiguity errors to avoid silent duplicate selection.
- Strict Zod input/output validation, bounded requests, timeouts, loopback URL enforcement, and
  stderr-only redacted logs.
- Unit tests and mocked MCP/REST integration tests.
- Adoption documentation for ChatGPT Desktop and Codex.
- MIT license, contribution/security guidance, issue templates, CI, and tag-driven npm/GitHub
  releases.
