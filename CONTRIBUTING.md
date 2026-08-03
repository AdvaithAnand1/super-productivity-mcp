# Contributing

Thanks for helping make the explicit Super Productivity workflow useful.

## Local setup

Requirements: Node.js 20+ and pnpm 11.

```bash
pnpm install
pnpm verify
```

The test suite is fully mocked. You do not need Super Productivity, a GitHub token, or network
access to run it.

## Guidelines

- Keep mutations explicit and task-ID based.
- Do not add background polling, implicit imports, or broad task selection.
- Never send logs to stdout; MCP STDIO protocol traffic owns stdout.
- Do not put access tokens, issue tokens, or raw API response bodies in logs or fixtures.
- Update the README, changelog, and tests when a tool or API behavior changes.
- Prefer small, focused tools over a general-purpose automation language.

## Pull requests

1. Create a focused branch.
2. Add or update tests for behavior changes.
3. Run `pnpm verify`.
4. Explain the user-visible workflow and any compatibility impact in the pull request.

The CI workflow runs on Node.js 20 and 22. Releases are tag-driven and publish through the
repository's protected npm workflow.
