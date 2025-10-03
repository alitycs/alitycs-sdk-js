import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createLogger } from '../../src/logger';

describe('createLogger', () => {
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let warnSpy: ReturnType<typeof mock>;
  let errorSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    originalWarn = console.warn;
    originalError = console.error;
    warnSpy = mock(() => {});
    errorSpy = mock(() => {});
    console.warn = warnSpy;
    console.error = errorSpy;
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });

  test('debug: true — warn calls console.warn with prefix', () => {
    const logger = createLogger(true);
    logger.warn('test message', 42);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toEqual(['[Alitycs]', 'test message', 42]);
  });

  test('debug: true — error calls console.error with prefix', () => {
    const logger = createLogger(true);
    logger.error('something broke');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toEqual(['[Alitycs]', 'something broke']);
  });

  test('debug: false — warn is a no-op', () => {
    const logger = createLogger(false);
    logger.warn('should not appear');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('debug: false — error still calls console.error', () => {
    const logger = createLogger(false);
    logger.error('critical error');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toEqual(['[Alitycs]', 'critical error']);
  });
});
