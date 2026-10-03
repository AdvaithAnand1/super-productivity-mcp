/* global process, URL, fetch, AbortSignal, console */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const OPT_IN = 'DELETE_ONLY_THE_DISPOSABLE_PROFILE_CREATED_BY_THIS_SCRIPT';
if (process.platform !== 'linux') throw new Error('Run this script inside Linux/WSL.');
if (process.env.SP_MCP_LIVE_E2E !== OPT_IN) {
  throw new Error(
    `Set SP_MCP_LIVE_E2E=${OPT_IN} only when you intend to create and delete an isolated test profile.`,
  );
}
if (!process.env.SP_SOURCE_DIR)
  throw new Error('Set SP_SOURCE_DIR to the Super Productivity source checkout.');
const sourceDir = resolve(process.env.SP_SOURCE_DIR);
await stat(join(sourceDir, 'package.json'));
const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 3876;
const token = `sp-mcp-live-test-${randomUUID().replaceAll('-', '')}`;
const tempProfile = await mkdtemp(join(tmpdir(), 'super-productivity-mcp-e2e-'));
const userDataDir = join(tempProfile, 'user-data');
const configDir = join(tempProfile, 'config');
let app;
let mcp;
let taskId;
let projectId;
let success = false;

const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
};
const assertPortFree = async () => {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolveListen);
  });
  await new Promise((resolveClose, reject) =>
    probe.close((error) => (error ? reject(error) : resolveClose())),
  );
};
const tool = async (name, args) => {
  const response = await mcp.callTool({ name, arguments: args });
  if (response.isError)
    throw new Error(`${name} failed: ${response.content.map((item) => item.text ?? '').join(' ')}`);
  const text = response.content.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error(`${name} returned no text result`);
  return JSON.parse(text);
};
const stopProcessGroup = async (child) => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(8000)]);
  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already stopped */
  }
};

try {
  await assertPortFree();
  run('npm', ['run', 'buildFrontend:dev'], sourceDir);
  run('npm', ['run', 'electron:build'], sourceDir);
  run('npm', ['run', 'build'], mcpDir);
  await assertPortFree();

  const electronPath = join(sourceDir, 'node_modules', '.bin', 'electron');
  const mainPath = join(sourceDir, 'electron', 'main.js');
  const pageUrl = pathToFileURL(
    join(sourceDir, '.tmp', 'angular-dist', 'browser', 'index.html'),
  ).href;
  app = spawn(
    electronPath,
    [
      mainPath,
      `--user-data-dir=${userDataDir}`,
      `--custom-url=${pageUrl}`,
      '--disable-gpu',
      '--no-sandbox',
    ],
    {
      cwd: sourceDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        NODE_ENV: 'DEV',
        SP_FORCE_LOCAL_REST_API: '1',
        SP_FORCE_LOCAL_REST_API_TOKEN: token,
        XDG_CONFIG_HOME: configDir,
      },
    },
  );
  const api = new URL(`http://127.0.0.1:${port}/`);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (app.exitCode !== null)
      throw new Error(`Isolated app exited early with status ${app.exitCode}`);
    try {
      const response = await fetch(new URL('health', api), { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).data?.rendererReady === true) {
        ready = true;
        break;
      }
    } catch {
      /* app has not finished booting */
    }
    await delay(1000);
  }
  assert(ready, 'Isolated Super Productivity did not become ready within 90 seconds.');

  const capabilityResponse = await fetch(new URL('bridge/capabilities', api), {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(capabilityResponse.ok, 'The isolated app did not accept its test-only API token.');
  const capabilities = (await capabilityResponse.json()).data;
  assert.equal(capabilities.protocolVersion, '1');
  for (const feature of [
    'project.create',
    'project.delete_empty',
    'task.attachments.add_link',
    'task.attachments.rename',
    'task.attachments.detach',
  ]) {
    assert(capabilities.features.includes(feature), `Missing expected capability ${feature}`);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(mcpDir, 'dist', 'index.js')],
    env: {
      ...process.env,
      SP_API_URL: api.toString(),
      SP_SEMANTIC_API_URL: new URL('bridge/', api).toString(),
      SP_API_TOKEN: token,
      SP_LOG_LEVEL: 'error',
    },
  });
  mcp = new Client({ name: 'super-productivity-release-smoke', version: '1.0.0' });
  await mcp.connect(transport);
  const listed = await mcp.listTools();
  for (const name of [
    'add_task_link_attachment',
    'rename_task_attachment',
    'detach_task_attachment',
  ]) {
    assert(
      listed.tools.some((item) => item.name === name),
      `MCP server did not expose ${name}`,
    );
  }
  const connection = await tool('check_connection', {});
  assert.equal(connection.connected, true);
  assert.equal(connection.semanticApi.available, true);

  const project = await tool('manage_project', {
    operation: 'create',
    title: `[MCP-TEST-${randomUUID()}]`,
  });
  projectId = project.project.id;
  const task = await tool('create_task', {
    title: '[MCP-TEST] disposable attachment verification',
    notes: 'release smoke metadata must remain intact',
    projectId,
  });
  taskId = task.task.id;
  const added = await tool('add_task_link_attachment', {
    taskId,
    url: 'https://example.invalid/reference',
    title: 'Reference',
  });
  const attachmentId = added.attachment.id;
  await tool('rename_task_attachment', { taskId, attachmentId, title: 'Updated reference' });
  const read = await tool('get_task', { taskId });
  const savedTask = read.task ?? read;
  assert.equal(savedTask.title, '[MCP-TEST] disposable attachment verification');
  assert.equal(savedTask.notes, 'release smoke metadata must remain intact');
  assert(
    savedTask.attachments.some(
      (item) => item.id === attachmentId && item.title === 'Updated reference',
    ),
  );
  await tool('detach_task_attachment', { taskId, attachmentId });
  const detachedRead = await tool('get_task', { taskId });
  assert(!(detachedRead.task ?? detachedRead).attachments.some((item) => item.id === attachmentId));

  await tool('delete_task', { taskId });
  taskId = undefined;
  await tool('manage_project', { operation: 'delete_empty', projectId });
  const deletedProjectId = projectId;
  projectId = undefined;
  const remainingProjects = await tool('list_projects', {});
  assert(!remainingProjects.projects.some((item) => item.id === deletedProjectId));
  success = true;
  console.log(
    JSON.stringify(
      {
        verified: true,
        toolCount: listed.tools.length,
        appVersion: capabilities.superProductivityVersion,
        features: ['add_task_link_attachment', 'rename_task_attachment', 'detach_task_attachment'],
        disposableRecordsCleaned: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (mcp) await mcp.close().catch(() => {});
  await stopProcessGroup(app);
  if (success) {
    const root = resolve(tmpdir());
    if (
      dirname(tempProfile) !== root ||
      !tempProfile.startsWith(join(root, 'super-productivity-mcp-e2e-'))
    ) {
      console.error(`Refusing to remove unexpected temporary path ${tempProfile}`);
      process.exitCode = 1;
    } else {
      await rm(tempProfile, { recursive: true, force: true });
    }
  } else {
    console.error(`The disposable profile was preserved for inspection: ${tempProfile}`);
  }
}
