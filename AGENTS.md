# Contributor guidance

- Preserve existing uncommitted work; inspect the working tree before changing files.
- Use `docs/FEATURES.md`, `docs/STATE.md`, and `docs/PLAN.md` for implementation status and capability boundaries.
- Task updates must be sparse patches: omitted fields stay unchanged, and explicit `null` clears only supported nullable fields. Never write back an incomplete task object.
- Verify mutations by reading saved state and checking that unrelated fields remain intact.
- Use clearly disposable test entities for live experiments and verify cleanup.
- The MCP supports Node.js 20 and newer; the verified development setup uses Node 24 with Corepack pnpm 10.12.4.
- Run lint, formatting, type checking, tests, and build before proposing changes. Run package and live smoke checks when their respective behavior changes.
- Do not publish releases, create tags, or upload credentials without explicit maintainer authorization.
