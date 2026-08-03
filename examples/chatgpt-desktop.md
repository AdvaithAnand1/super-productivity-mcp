# ChatGPT Desktop setup

Use the **desktop** version of Super Productivity 18.x or newer. If the local API setting is not
visible, update Super Productivity first from its [official releases](https://github.com/super-productivity/super-productivity/releases/latest).

1. In Super Productivity, open **Settings → Misc Settings**.
2. Enable **Enable local REST API**.
3. Open ChatGPT Desktop settings and choose **MCP servers → Add server**.
4. Select **STDIO**.
5. Use:

   - Command: `npx`
   - Arguments: `-y`, `super-productivity-mcp-server`
   - Environment: leave empty for Super Productivity 18.16.0

6. Save, restart ChatGPT Desktop if requested, and ask it to run `check_connection`.

Super Productivity 18.16.0 does not display or require an API token. If a future build displays an
Access Token, add it as the optional `SP_API_TOKEN` environment variable. Do not use an npm token.

If the check returns `ECONNREFUSED`, keep Super Productivity open and confirm the API toggle is
enabled. A `401` only applies to a future token-enabled build; set `SP_API_TOKEN` from that app and
restart the MCP server.

For a local checkout, use `node` as the command and the absolute path to `dist/index.js` as its
argument. If a token is required by your build, keep it in the MCP server environment rather than
in a committed configuration file.
