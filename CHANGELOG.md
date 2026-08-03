# Changelog

All notable changes to this project are documented here.

## [0.1.1] - 2026-08-03

### Changed

- Added a first-run onboarding path for the Super Productivity desktop API.
- Documented the supported desktop-version requirement and the missing-setting update path.
- Added local liveness verification, client restart guidance, token safety reminders, and
  troubleshooting for the most common connection errors.
- Updated the npm installation and release documentation now that the public package is available.
- Matched the released Super Productivity 18.16.0 behavior: no token is required, while optional
  Bearer-token support remains available for future authenticated builds.

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
