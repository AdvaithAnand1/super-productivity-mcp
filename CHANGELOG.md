# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Full task context reads, task queues, general task creation, sparse metadata updates, safe bounded bulk updates, and explicit lifecycle operations.
- Exact project/tag resolution and tools for project/tag lookup, task tag membership, Today planning, timers, and GitHub issue association.
- Capability discovery for the optional enhanced Super Productivity semantic API.
- Enhanced tools for priority, hierarchy, ordered task contexts, historical time, guarded project/tag administration, and HTTP(S) attachment links with title rename and exact detach.
- Source-backed feature matrix, architecture overview, recurrence/attachment security review, upstream proposal, and a manual release authorization runbook.

### Security

- Keep task writes sparse and verify persisted values after mutations; stop bulk writes when a prior outcome is uncertain.
- Constrain semantic writes to explicit operations on the loopback app API; no arbitrary state setter or service invocation is exposed.
- Reject non-HTTP(S) link attachment URLs and embedded credentials. Local file/image writes and binary transfer remain unavailable.
- Preserve explicit IDs and empty-only project/tag deletion safeguards.

### Limitations

- Recurrence configuration and lifecycle writes remain unsupported.
- Enhanced semantic operations require a compatible modified Super Productivity source build; released stock builds do not advertise them.
- Provider-specific issue metadata, board/section membership, local file/image writes, and attachment binary transfer are not supported.

## [0.1.5] - 2026-08-03

### Fixed

- Corrected `check_connection` so a healthy Super Productivity 18.16.0 API is reported as configured even when no optional API token is present.
- Added an explicit `tokenConfigured` field to distinguish optional authentication from API readiness.

## [0.1.4] - 2026-08-03

### Changed

- Removed private, context-specific references from the public onboarding documentation.
- Reworded Codex Desktop instructions so they stand alone for every reader.

## [0.1.3] - 2026-08-03

### Changed

- Split Desktop onboarding into the ChatGPT Desktop graphical path and the Codex Desktop `config.toml` path.
- Made the CLI procedure a separate, exact case with the prerequisite, registration command, verification commands, and `codex`-missing fallback.
- Documented that the **MCP servers** menu may not exist in some Codex Desktop settings panels.

## [0.1.2] - 2026-08-03

### Changed

- Split Codex onboarding into explicit Desktop application and CLI procedures.
- Documented the Desktop settings path and shared `config.toml` fallback without requiring the `codex` command.
- Added troubleshooting for `zsh: command not found: codex` and corrected the Codex example env configuration.

## [0.1.1] - 2026-08-03

### Changed

- Added a first-run onboarding path for the Super Productivity desktop API.
- Documented the supported desktop-version requirement and the missing-setting update path.
- Added local liveness verification, client restart guidance, token safety reminders, and troubleshooting for the most common connection errors.
- Updated the npm installation and release documentation now that the public package is available.
- Matched the released Super Productivity 18.16.0 behavior: no token is required, while optional Bearer-token support remains available for future authenticated builds.

## [0.1.0] - 2026-08-03

### Added

- STDIO MCP server for Super Productivity's official local REST API.
- Connection health checks, task search, Today listing, task planning, timer control, completion, and current-task lookup.
- Explicit GitHub issue association with URL and `owner/repo#number` parsing.
- Marker-based idempotency and ambiguity errors to avoid silent duplicate selection.
- Strict Zod input/output validation, bounded requests, timeouts, loopback URL enforcement, and stderr-only redacted logs.
- Unit tests and mocked MCP/REST integration tests.
- Adoption documentation for ChatGPT Desktop and Codex.
- MIT license, contribution/security guidance, issue templates, CI, and tag-driven npm/GitHub releases.
