import { describe, test, expect } from 'bun:test';
import { collectContext } from '../../src/context';

describe('collectContext', () => {
  test('returns sdkVersion and sdkLanguage', () => {
    const ctx = collectContext();
    expect(ctx.sdkVersion).toBe('1.0.0');
    expect(ctx.sdkLanguage).toBe('typescript');
  });

  test('collects timezone', () => {
    const ctx = collectContext();
    // In test environment (Bun/Node), Intl should work
    expect(typeof ctx.timezone).toBe('string');
    expect(ctx.timezone!.length).toBeGreaterThan(0);
  });

  test('collects locale', () => {
    const ctx = collectContext();
    // In Node/Bun, locale comes from Intl
    if (ctx.locale) {
      expect(ctx.locale.length).toBeGreaterThan(0);
    }
  });

  test('returns undefined for browser-only fields in Node/Bun', () => {
    const ctx = collectContext();
    // In non-browser environment, these should be undefined
    expect(ctx.url).toBeUndefined();
    expect(ctx.screen).toBeUndefined();
    expect(ctx.utmSource).toBeUndefined();
    expect(ctx.utmMedium).toBeUndefined();
    expect(ctx.utmCampaign).toBeUndefined();
  });
});
