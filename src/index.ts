#!/usr/bin/env node

import { loadConfig } from './config.js';
import { toPublicError } from './errors.js';
import { createLogger } from './logger.js';
import { SuperProductivityClient } from './sp-client.js';
import { startStdioServer } from './server.js';

const main = (): void => {
  try {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const client = new SuperProductivityClient(config, logger);
    const semanticApiClient = new SuperProductivityClient(config, logger);
    startStdioServer({ config, client, semanticApiClient, logger });
    logger.info('MCP server started on stdio', {
      apiUrl: config.apiUrl.toString(),
      tokenConfigured: Boolean(config.apiToken),
    });
  } catch (error) {
    const publicError = toPublicError(error);
    process.stderr.write(
      `[super-productivity-mcp] ERROR ${publicError.code}: ${publicError.message}\n`,
    );
    process.exitCode = 1;
  }
};

main();
