import { afterEach, describe, test, expect } from 'bun:test';
import { collectContext } from '../../src/context';

const originalDescriptors = new Map(
  ['window', 'document', 'navigator', 'URLSearchParams'].map(key => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
);
const originalDateTimeFormat = Intl.DateTimeFormat;
const corePackage = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
  version: string;
};

afterEach(() => {
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  Intl.DateTimeFormat = originalDateTimeFormat;
});

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

describe('collectContext', () => {
  test('returns sdkVersion and sdkLanguage', () => {
    const ctx = collectContext();
    expect(ctx.sdkVersion).toBe(corePackage.version);
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

  test('collects all five UTM values while retaining the full URL for click IDs', () => {
    setGlobal('window', {
      location: {
        href: 'https://example.test/pricing?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_content=hero&utm_term=analytics&gclid=paid-123',
        search:
          '?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_content=hero&utm_term=analytics&gclid=paid-123',
      },
    });

    expect(collectContext()).toMatchObject({
      url: 'https://example.test/pricing?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_content=hero&utm_term=analytics&gclid=paid-123',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'spring',
      utmContent: 'hero',
      utmTerm: 'analytics',
    });
  });

  test('omits missing and empty UTM parameters', () => {
    setGlobal('window', {
      location: {
        href: 'https://example.test/?utm_source=&utm_campaign=spring',
        search: '?utm_source=&utm_campaign=spring',
      },
    });

    const context = collectContext();
    expect(context.utmSource).toBeUndefined();
    expect(context.utmMedium).toBeUndefined();
    expect(context.utmCampaign).toBe('spring');
    expect(context.utmContent).toBeUndefined();
    expect(context.utmTerm).toBeUndefined();
  });

  test('collects browser locale, user agent, referrer, and screen dimensions', () => {
    setGlobal('navigator', { language: 'fr-FR', userAgent: 'Context Test Browser' });
    setGlobal('document', { referrer: 'https://referrer.example.test/' });
    setGlobal('window', {
      location: { href: 'https://example.test/', search: '' },
      screen: { width: 1440, height: 900 },
    });

    expect(collectContext()).toMatchObject({
      locale: 'fr-FR',
      userAgent: 'Context Test Browser',
      referrer: 'https://referrer.example.test/',
      screen: { width: '1440', height: '900' },
    });
  });

  test('degrades gracefully when Intl context resolution fails', () => {
    Intl.DateTimeFormat = (() => {
      throw new Error('Intl unavailable');
    }) as unknown as typeof Intl.DateTimeFormat;

    const context = collectContext();
    expect(context.timezone).toBeUndefined();
    expect(context.locale).toBeUndefined();
  });

  test('ignores malformed UTM input when URLSearchParams rejects it', () => {
    setGlobal('window', {
      location: { href: 'https://example.test/?utm_source=broken', search: '?utm_source=broken' },
    });
    setGlobal(
      'URLSearchParams',
      class {
        constructor() {
          throw new Error('Malformed search');
        }
      }
    );

    expect(collectContext().utmSource).toBeUndefined();
  });
});
