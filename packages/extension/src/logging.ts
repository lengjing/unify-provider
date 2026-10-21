import { CompletionStreamError, ConversionError } from './convert.js';

type Logger = { warn(message: string): void; debug(message: string): void };
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};

/** Trust local conversion errors and the core's explicit redaction boundary, not transport messages. */
export function logError(logger: Logger, error: unknown): void {
  const source = record(error);
  const event = record(source.event);
  const trusted = error instanceof ConversionError || error instanceof CompletionStreamError || source.redacted === true;
  const details: Record<string, unknown> = { name: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'UnknownError' };
  if (trusted && error instanceof Error) {
    details.message = error.message;
    if (error instanceof ConversionError || error instanceof CompletionStreamError) details.code = error.code;
    const diagnostics = record(source.diagnostics ?? event.diagnostics);
    for (const key of ['stage', 'status', 'code', 'type', 'param', 'summary']) {
      if (typeof diagnostics[key] === 'string' || typeof diagnostics[key] === 'number') details[key] = diagnostics[key];
    }
  }
  logger.warn(`Unify Provider failure ${JSON.stringify(details)}`);
  // Error.stack includes its message. Unknown host/transport stacks can echo credentials.
  if (error instanceof Error && error.stack) logger.debug(trusted ? error.stack : `${details.name}: [untrusted stack redacted]`);
}

export function logIdentifier(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,96}$/.test(value) ? value : '[redacted]';
}
