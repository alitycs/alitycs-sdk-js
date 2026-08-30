import type { EventContext } from './types';
import { UTM_KEYS, utmParam, type UtmKey } from './utils';

const SDK_VERSION = '1.0.3';

export function collectContext(): EventContext {
  const ctx: EventContext = {
    sdkVersion: SDK_VERSION,
    sdkLanguage: 'typescript',
  };

  ctx.timezone = getTimezone();
  ctx.locale = getLocale();
  ctx.userAgent = getUserAgent();
  ctx.url = getUrl();
  ctx.referrer = getReferrer();
  ctx.screen = getScreen();

  const utm = getUtmParams();
  for (const key of UTM_KEYS) {
    const value = utm[key];
    if (value) ctx[key] = value;
  }

  return ctx;
}

function getTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function getLocale(): string | undefined {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

function getUserAgent(): string | undefined {
  if (typeof navigator !== 'undefined') {
    return navigator.userAgent;
  }
  return undefined;
}

function getUrl(): string | undefined {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.href;
  }
  return undefined;
}

function getReferrer(): string | undefined {
  if (typeof document !== 'undefined' && document.referrer) {
    return document.referrer;
  }
  return undefined;
}

function getScreen(): Record<string, string> | undefined {
  if (typeof window !== 'undefined' && window.screen) {
    return {
      width: String(window.screen.width),
      height: String(window.screen.height),
    };
  }
  return undefined;
}

function getUtmParams(): Partial<Record<UtmKey, string>> {
  if (typeof window === 'undefined' || !window.location?.search) return {};
  try {
    const params = new URLSearchParams(window.location.search);
    const utm: Partial<Record<UtmKey, string>> = {};
    for (const key of UTM_KEYS) {
      utm[key] = params.get(utmParam(key)) ?? undefined;
    }
    return utm;
  } catch {
    return {};
  }
}
