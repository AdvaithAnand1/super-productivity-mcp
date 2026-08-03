import type { LogLevel } from './config.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const stripControlCharacters = (value: string): string =>
  [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');

export interface Logger {
  error(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  debug(message: string, details?: Record<string, unknown>): void;
}

const redact = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return stripControlCharacters(
      value
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]'),
    ).slice(0, 500);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        const lower = key.toLowerCase();
        return [
          key,
          /token|secret|password|authorization|api[_-]?key/.test(lower)
            ? '[redacted]'
            : redact(nested),
        ];
      }),
    );
  }
  return value;
};

export const createLogger = (level: LogLevel): Logger => {
  const write = (
    entryLevel: LogLevel,
    message: string,
    details?: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[entryLevel] > LEVEL_WEIGHT[level]) return;
    const suffix = details ? ` ${JSON.stringify(redact(details))}` : '';
    process.stderr.write(
      `[super-productivity-mcp] ${entryLevel.toUpperCase()} ${message}${suffix}\n`,
    );
  };

  return {
    error: (message, details) => write('error', message, details),
    warn: (message, details) => write('warn', message, details),
    info: (message, details) => write('info', message, details),
    debug: (message, details) => write('debug', message, details),
  };
};
