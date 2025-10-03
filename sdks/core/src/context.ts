import type { EventContext } from './types';

const SDK_VERSION = '1.0.0';

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
  if (utm.utmSource) ctx.utmSource = utm.utmSource;
  if (utm.utmMedium) ctx.utmMedium = utm.utmMedium;
  if (utm.utmCampaign) ctx.utmCampaign = utm.utmCampaign;

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

function getUtmParams(): { utmSource?: string; utmMedium?: string; utmCampaign?: string } {
  if (typeof window === 'undefined' || !window.location?.search) return {};
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      utmSource: params.get('utm_source') ?? undefined,
      utmMedium: params.get('utm_medium') ?? undefined,
      utmCampaign: params.get('utm_campaign') ?? undefined,
    };
  } catch {
    return {};
  }
}
