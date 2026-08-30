export const UTM_KEYS = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

/** utmSource → utm_source */
export function utmParam(key: UtmKey): string {
  return key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`);
}

export function generateId(): string {
  if (typeof crypto === 'undefined') {
    throw new Error('Web Crypto required');
  }

  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function serializeProperties(props: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (value === null) {
      result[key] = 'null';
    } else if (typeof value === 'object') {
      // Circular refs and nested BigInt throw on stringify — never propagate into track().
      try {
        result[key] = JSON.stringify(value) ?? '[unserializable]';
      } catch {
        result[key] = '[unserializable]';
      }
    } else {
      result[key] = String(value);
    }
  }
  return result;
}
