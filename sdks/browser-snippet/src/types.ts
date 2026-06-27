/**
 * Minimal type definitions for browser snippet
 * Keep this file minimal to reduce bundle size
 */

export interface SnippetConfig {
  apiKey: string;
  sdkUrl?: string;
  autoTrack?: boolean;
  autoCapture?: boolean;
  debug?: boolean;
  endpoint?: string;
}

export interface QueuedCall {
  method: string;
  args: any[];
  timestamp: number;
}

export interface AlitycsStub {
  (method: string, ...args: any[]): AlitycsStub;
  track: (event: string, properties?: Record<string, any>, options?: { dedupeKey?: string; dedupeWindowMs?: number }) => AlitycsStub;
  identify: (userId: string, traits?: Record<string, any>, options?: { dedupeKey?: string; dedupeWindowMs?: number }) => AlitycsStub;
  page: (name?: string, properties?: Record<string, any>, options?: { dedupeKey?: string; dedupeWindowMs?: number }) => AlitycsStub;
  setGlobalProperties: (properties: Record<string, any>) => AlitycsStub;
  removeGlobalProperties: (keys: string[]) => AlitycsStub;
  clearGlobalProperties: () => AlitycsStub;
  _queue: QueuedCall[];
  _config: SnippetConfig;
  loaded: boolean;
}

declare global {
  interface Window {
    alitycs: AlitycsStub;
  }
}
