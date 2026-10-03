# Recurrence and attachment capability review

Source review: Super Productivity 19.1.0, commit `54a3793`. This review follows the application services, reducers, effects, task models, renderer, and Electron bridge. It distinguishes task fields that happen to be readable from lifecycle operations that are safe to mutate.

## Recurrence

A task stores a `repeatCfgId`; the recurrence configuration is a separate entity. The configuration carries more than a schedule: it includes the current generation cursor, start date, repeat cycle and interval, weekday/month anchors, pause state, deleted occurrence dates, overdue behavior, completion-based anchoring, completion gates, and inheritance flags for generated instances. Notes, tags, estimates, reminders, and subtask templates can also flow into each generated occurrence.

The native app does not treat a repeat rule as an isolated task field. Due-day effects lazily generate instances and advance the stored cursor. They account for duplicate occurrence IDs and deleted-date exceptions, can skip overdue dates, and can wait for earlier instances to complete across active and archived tasks. Completion can shift a future anchor. Schedule edits can reschedule tasks; other effects may offer updates to existing instances. Templates create child tasks during generation, and deletion has archive cleanup behavior.

Therefore, recurrence configuration writes remain unsupported. A correct MCP lifecycle must first be designed around the native recurrence service and effect sequence, with clear behavior for existing instances, archived instances, exceptions, cursor advancement, and generated subtasks. The stock task read exposes the association ID, but the MCP does not yet normalize and return the complete recurrence configuration.

## Attachments

Task attachments are metadata references (`title`, `type`, `path`, and optional image metadata), not uploaded binary files. The `FILE`, `LINK`, `IMG`, `COMMAND`, and `NOTE` types have materially different behavior. A generic attachment write would blur those security boundaries.

The MCP now supports three narrow operations through the app's native attachment service:

- Add an HTTP(S) `LINK` reference. URLs with embedded credentials and non-HTTP(S) schemes are rejected. Creating the reference does not fetch the URL; opening it is still a user action.
- Rename one attachment's display title. The app preserves its path, type, and all other attachment entries.
- Detach one exact attachment metadata entry. The referenced file or URL is not opened or deleted.

Local `FILE` and `IMG` writes remain unavailable. File paths can refer to private local data, and image sources can be resolved or fetched while rendering. Remote `IMG` URLs can therefore cause renderer network requests. Binary upload and download also remain unsupported: attachment content may live in local files or IndexedDB, and no general synchronized binary transport exists in the task model.

## Verification and limits

The three safe attachment operations passed a live MCP client against a rebuilt Super Productivity instance using a disposable profile, project, and task. The link was created, renamed, read back, detached, and read back as absent. Task title and notes remained unchanged, and the temporary task and project were deleted and confirmed absent.

MCP verification passed lint, formatting, type checking, all 63 tests, and build. The package dry-run passed and included the updated server. The app frontend development build and Electron build passed; the focused local API security suite passed 28 tests. Focused app bridge/route tests passed 145 tests. No change was made to the existing FAST or CS423 directories, and nothing was pushed or published.
