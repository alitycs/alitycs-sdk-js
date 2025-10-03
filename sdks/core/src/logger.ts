const PREFIX = '[Alitycs]';

export interface Logger {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(debug: boolean): Logger {
  return {
    warn: debug ? (...args: unknown[]) => console.warn(PREFIX, ...args) : () => {},
    error: (...args: unknown[]) => console.error(PREFIX, ...args),
  };
}
