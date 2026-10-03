# Upstream proposal: explicit semantic operations for the local REST API

## Motivation

The local REST API already supports useful task reads, creation, updates, planning, timer control, and lifecycle operations. Some app features are intentionally absent from its generic task PATCH allowlist. Priority, hierarchy, ordered contexts, historical time, project/tag administration, and attachment metadata each have app invariants that a generic JSON write would bypass.

This MCP project has implemented a small local extension to close those gaps. The proposal is to review the app-side operations independently for possible inclusion in Super Productivity. They are useful to integrations beyond this MCP because each operation has explicit validation and dispatches through native app services/actions.

## Current limitation

A plain task PATCH cannot safely express every operation. For example, hierarchy stores both a child’s `parentId` and its parent’s ordered `subTaskIds`; changing only one corrupts the relationship. Task order lives in context-specific arrays. Historical time updates must preserve per-day totals and rollups. Project removal can cascade through tasks and notes, and tag deletion changes task membership. Attachment paths have different security behavior by type.

## Proposed API shape

The implementation adds an enhanced semantic API under the local REST handler’s `/bridge/` prefix and advertises `protocolVersion: "1"` plus an explicit feature list from `GET /bridge/capabilities`. A future upstream API may choose a more descriptive route prefix; the MCP currently retains `/bridge/` for compatibility with this patch.

Advertised operations in this patch:

- `task.priority.set`
- `task.hierarchy.set_parent`
- `task.order.subtasks`, `task.order.project`, `task.order.backlog`, `task.order.tag`
- `task.time.adjust`
- `task.attachments.add_link`, `task.attachments.rename`, `task.attachments.detach`
- `project.create`, `project.rename`, `project.delete_empty`
- `tag.create`, `tag.update`, `tag.delete_empty`

Each route maps to a named operation. Inputs are shape-validated, IDs are exact, and destructive operations are constrained. No generic store mutation or arbitrary service call is exposed. Attachment creation accepts HTTP(S) links only; rename changes the title; detach removes metadata without deleting the referenced item. Local file/image references and binary transfer are excluded.

## Security and compatibility

The server binds to loopback and uses the local API’s authorization behavior for protected routes. It reuses the app’s local API token mechanism, keeps `/health` liveness behavior separate, and rechecks authorization after request-body receipt. Capability discovery lets integrations continue using stock routes when the extension is absent and prevents unsupported semantic writes from being attempted.

Existing local REST routes and payloads remain unchanged. The enhanced routes are additive. A stock released app that lacks these capabilities continues to work for operations it already supports; the MCP reports enhanced features unavailable. No released stock build currently contains this patch.

## Native implementation and tests

Routes are organized as an explicit semantic route registry in the Electron local REST API handler and a feature-layer dispatcher in the task feature area. Task services, conversion/move/order actions, time actions, `ProjectService`, `TagService`, and `TaskAttachmentService` perform the state changes. Readback checks validate requested state and preserve unrelated fields.

The patch includes request validation, capability/route tests, feature bridge tests, store reducer tests, Electron API security tests, and live MCP-to-app checks using disposable profiles and data. The compatible source build used for verification is Super Productivity 19.1.0 at commit `54a3793`. No upstream request has been submitted.

## License and provenance facts

The MCP repository’s checked-in `LICENSE` identifies the project as MIT and carries the existing `AMOREM` 2026 notice. The Super Productivity checkout’s `LICENSE` is also MIT and carries its own copyright notice. This app patch is a derivative modification of that repository and should be reviewed and redistributed under its existing MIT terms; preserve the upstream copyright/license text and include any notice required by the maintainers. The MCP package does not copy Super Productivity implementation source; it is an independent client of the local API. These are repository facts, not legal advice.
