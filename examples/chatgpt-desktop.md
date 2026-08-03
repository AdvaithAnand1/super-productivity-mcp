# ChatGPT Desktop setup

1. Enable Super Productivity's local REST API in **Settings → Misc**.
2. Copy the local access token.
3. Open ChatGPT Desktop settings and choose **MCP servers → Add server**.
4. Select **STDIO**.
5. Use:

   - Command: `npx`
   - Arguments: `-y`, `super-productivity-mcp-server`
   - Environment: `SP_API_TOKEN=<your-local-token>`

6. Save, restart the desktop app if requested, and ask it to run `check_connection`.

For a local checkout, use `node` as the command and the absolute path to `dist/index.js` as its
argument. Keep the token in the MCP server environment rather than in a committed configuration
file.
