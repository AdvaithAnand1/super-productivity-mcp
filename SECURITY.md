# Security policy

## Scope

Super Productivity MCP is a local STDIO process that sends authenticated requests to the local
Super Productivity REST API. It does not provide a public HTTP server and does not need a GitHub
credential.

## Reporting a vulnerability

Please do not open a public issue for a suspected credential leak, token exposure, command
injection, or authentication bypass. Use GitHub's private security advisory flow for the repository
or contact the maintainer privately through the address listed on the GitHub profile.

Include:

- affected version or commit;
- a minimal reproduction;
- impact and suggested mitigation, if known.

Do not include live Super Productivity access tokens or personal data.

## Defensive defaults

- Loopback API URLs are enforced by default.
- The access token is accepted through an environment variable and redacted from logs.
- STDIO protocol output is kept separate from diagnostics.
- Timeouts, strict input schemas, bounded strings, and explicit task IDs limit accidental scope.
