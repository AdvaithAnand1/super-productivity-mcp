export class AppError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly details: unknown;

  constructor(code: string, message: string, options?: { status?: number; details?: unknown }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

const stripControlCharacters = (value: string): string =>
  [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');

export const sanitizeErrorMessage = (message: string): string =>
  stripControlCharacters(
    message
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]'),
  ).slice(0, 500);

export const toPublicError = (value: unknown): AppError => {
  if (isAppError(value)) {
    return new AppError(value.code, sanitizeErrorMessage(value.message), {
      ...(value.status === undefined ? {} : { status: value.status }),
      ...(value.details === undefined ? {} : { details: value.details }),
    });
  }

  if (value instanceof Error) {
    return new AppError('INTERNAL_ERROR', sanitizeErrorMessage(value.message));
  }

  return new AppError('INTERNAL_ERROR', 'Unexpected error');
};
