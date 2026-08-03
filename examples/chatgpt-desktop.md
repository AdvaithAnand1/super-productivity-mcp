# ChatGPT Desktop setup

Use the **desktop** version of Super Productivity 18.x or newer. If the local API setting is not
visible, update Super Productivity first from its [official releases](https://github.com/super-productivity/super-productivity/releases/latest).

1. In Super Productivity, open **Settings → Misc Settings**.
2. Enable **Enable local REST API**.
3. Copy the **Access Token**. This is not an npm token.
4. Open ChatGPT Desktop settings and choose **MCP servers → Add server**.
5. Select **STDIO**.
6. Use:

   - Command: `npx`
   - Arguments: `-y`, `super-productivity-mcp-server`
   - Environment: `SP_API_TOKEN=<your-local-token>`

7. Save, restart ChatGPT Desktop if requested, and ask it to run `check_connection`.

If the check returns `ECONNREFUSED`, keep Super Productivity open and confirm the API toggle is
enabled. If it returns `401`, copy the current Access Token again and restart the MCP server.

For a local checkout, use `node` as the command and the absolute path to `dist/index.js` as its
argument. Keep the token in the MCP server environment rather than in a committed configuration
file.
