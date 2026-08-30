const PREFIX = '[Alitycs]';

export interface Logger {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Warnings always surface: they report delayed or dropped events that host pages must see.
 * The `debug` flag is retained for API compatibility.
 */
export function createLogger(_debug = false): Logger {
  return {
    warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
    error: (...args: unknown[]) => console.error(PREFIX, ...args),
  };
}
