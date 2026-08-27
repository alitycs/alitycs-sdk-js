import type { AlitycsConfig, PersistenceOptions, ResolvedConfig } from './types';

/** Shared defaults used by core, browser, server, and framework adapters. */
export const DEFAULTS: Omit<ResolvedConfig, 'apiKey'> = {
  endpoint: 'https://api.alitycs.com/events',
  flushInterval: 10_000,
  flushSize: 25,
  maxQueueSize: 1000,
  maxRetries: 3,
  requestTimeout: 10_000,
  debug: false,
  sessionTimeout: 30 * 60 * 1000,
  batching: true,
  onDiagnostics: undefined,
  persistence: false,
  overflowPolicy: 'drop-newest',
};

/** Resolves one canonical configuration shape for every SDK adapter. */
export function resolveAlitycsConfig(
  config: AlitycsConfig,
  defaults: Partial<Omit<ResolvedConfig, 'apiKey'>> = {}
): ResolvedConfig {
  if (!config.apiKey || config.apiKey.trim() === '') throw new Error('apiKey is required');

  const merged = { ...DEFAULTS, ...defaults, ...config };
  const persistence = normalizePersistence(config.persistence);
  return {
    ...merged,
    apiKey: config.apiKey,
    persistence,
    overflowPolicy: config.overflowPolicy ?? merged.overflowPolicy,
  } as ResolvedConfig;
}

function normalizePersistence(value: boolean | PersistenceOptions | undefined): false | PersistenceOptions {
  if (!value) return false;
  if (value === true) return {};
  return { ...value };
}
