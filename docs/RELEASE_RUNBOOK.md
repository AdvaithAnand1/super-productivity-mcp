# Local verification and release boundaries

This fork is distributed through GitHub. Publishing an npm version, creating a release tag, configuring publication secrets, or opening an upstream Super Productivity PR requires separate maintainer authorization.

## Verification

The checked-in `scripts/live-enhanced-smoke.mjs` runs only on Linux/WSL. It requires explicit destructive-test opt-in and an app source checkout. It builds the app and MCP, launches the app with a generated token and an isolated profile, checks MCP STDIO and advertised capabilities, exercises link attachment operations, verifies readback, removes its disposable entities, and deletes the profile after success. On failure, it preserves the isolated profile for diagnosis. It refuses to run while the API port is occupied and does not accept a user profile path or API URL override.

Run it from a Linux/WSL shell after reviewing the script and confirming that port 3876 is available:

```bash
MCP_REPO=/path/to/super-productivity-mcp
APP_REPO=/path/to/super-productivity
cd "$MCP_REPO"
SP_MCP_LIVE_E2E=DELETE_ONLY_THE_DISPOSABLE_PROFILE_CREATED_BY_THIS_SCRIPT \
SP_SOURCE_DIR="$APP_REPO" \
pnpm smoke:live
```

The opt-in string is a safety switch, not a credential. The script creates its own test token and isolated profile.

## Windows-native verification

The verified Windows setup used the app's pinned portable Node 22.18.0 runtime and the MCP's Node 24 runtime. App lint and the Windows distribution build passed, producing x64 and ARM64 packages. Live testing used the unpacked x64 build with a dedicated user-data directory and a locally built frontend; the installer was not installed. The authenticated loopback API reported app version 19.1.0 and all 16 capabilities. A native MCP client connected over STDIO, enumerated all 29 tools, wrote and read task metadata, added/renamed/detached a web link, and removed its disposable task and project.

The package smoke passes on Windows and Linux/WSL. It installs the packed tarball into a fresh directory, checks all 29 tools and the absent-app diagnostic, and uses an ephemeral local port. It does not require the desktop app. The Windows Codex template contains no token or personal path; replace its example checkout path locally.

Testing used isolated app profiles. The pre-existing Store app profile was not accessed or changed. Local-only profile locations and identifiers are intentionally omitted from this public runbook.

## GitHub source repository

The public repository is `https://github.com/AdvaithAnand1/super-productivity-mcp`. Its `origin` points to this fork and `upstream` points to `https://github.com/Amorem/super-productivity-mcp`. Preserve that relationship when updating either remote. Keep the original project attribution in README and package metadata.

## Future npm release

The npm package name currently belongs to the original published distribution. Confirm ownership and registry availability before proposing a fork package release. Do not publish this fork under the shared package name without the original owner's authorization; if a separate package name is chosen, update package metadata, URLs, badges, README install instructions, and release workflow together.

Any later npm release requires a separately reviewed version and explicit authorization. Before release, run `pnpm verify`, `pnpm pack:check`, and `pnpm smoke:package`, inspect the exact tarball, and use the account owner's approved credential flow. Never put publication tokens in source, MCP config, logs, or chat. This repository publication does not create a release, tag, registry secret, or upstream app PR.
