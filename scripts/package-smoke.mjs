/* global process, console */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(tmpdir());
const scratch = await mkdtemp(join(tempRoot, 'super-productivity-mcp-pack-smoke-'));
const packDir = join(scratch, 'pack');
const installDir = join(scratch, 'install');
let client;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const runNpm = (args, options = {}) => {
  if (process.platform === 'win32' && existsSync(npmCli)) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
};

const reserveDiagnosticPort = async () => {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Could not reserve an ephemeral diagnostic port.');
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
};
try {
  const port = await reserveDiagnosticPort();
  await (await import('node:fs/promises')).mkdir(packDir);
  await (await import('node:fs/promises')).mkdir(installDir);
  const packed = JSON.parse(
    runNpm(['pack', '--json', '--pack-destination', packDir], { cwd: mcpDir }),
  )[0];
  const tarball = join(packDir, packed.filename);
  const entries = run('tar', ['-tzf', tarball])
    .trim()
    .split(/\r?\n/)
    .map((value) => value.replaceAll('\\', '/').replace(/^package\//, ''));
  for (const required of [
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'dist/index.js',
    'docs/FEATURES.md',
    'docs/architecture.md',
    'docs/RECURRENCE-AND-ATTACHMENTS.md',
    'examples/codex-config.toml',
    'examples/windows-codex-config.toml',
  ])
    assert(entries.includes(required), `Package omitted ${required}`);
  for (const forbidden of [
    'src/',
    'test/',
    'docs/STATE.md',
    'docs/RELEASE_RUNBOOK.md',
    '.env.example',
    'scripts/',
  ]) {
    assert(
      !entries.some((entry) => entry === forbidden || entry.startsWith(forbidden)),
      `Package unexpectedly contains ${forbidden}`,
    );
  }
  runNpm([
    'install',
    '--prefix',
    installDir,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    tarball,
  ]);

  const entry = join(
    installDir,
    'node_modules',
    'super-productivity-mcp-server',
    'dist',
    'index.js',
  );
  const env = { ...process.env, SP_API_URL: 'http://127.0.0.1:' + port, SP_LOG_LEVEL: 'error' };
  delete env.SP_API_TOKEN;
  delete env.SP_SEMANTIC_API_URL;
  delete env.SP_ALLOW_NON_LOOPBACK_URL;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env });
  client = new Client({ name: 'clean-package-smoke', version: '1.0.0' });
  await client.connect(transport);
  const listing = await client.listTools();
  assert.equal(listing.tools.length, 29);
  assert(listing.tools.some((tool) => tool.name === 'get_task'));
  assert(listing.tools.some((tool) => tool.name === 'add_task_link_attachment'));
  const response = await client.callTool({ name: 'check_connection', arguments: {} });
  assert(
    !response.isError,
    'No-app check_connection should return a diagnostic rather than crash the server.',
  );
  const text = response.content.find((item) => item.type === 'text')?.text;
  assert(text, 'No-app diagnostic response had no text content.');
  const diagnostic = JSON.parse(text);
  assert.equal(diagnostic.connected, false);
  assert.equal(diagnostic.reachable, false);
  assert.equal(diagnostic.error.code, 'SP_UNREACHABLE');
  assert.equal(diagnostic.semanticApi.available, false);
  console.log(
    JSON.stringify(
      {
        verified: true,
        packageVersion: packed.version,
        tarballFiles: entries.length,
        installedFromTarball: true,
        toolCount: listing.tools.length,
        noAppCode: diagnostic.error.code,
        enhancedApiAvailable: diagnostic.semanticApi.available,
      },
      null,
      2,
    ),
  );
} finally {
  if (client) await client.close().catch(() => {});
  if (
    dirname(scratch) !== tempRoot ||
    !scratch.startsWith(join(tempRoot, 'super-productivity-mcp-pack-smoke-'))
  ) {
    console.error(`Refusing to remove unexpected temporary path ${scratch}`);
    process.exitCode = 1;
  } else {
    await rm(scratch, { recursive: true, force: true });
  }
}
