export const STRICT_SEMVER_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;

const STRICT_SEMVER_PATTERN = new RegExp(`^(?:${STRICT_SEMVER_SOURCE})$`);

export function isStrictSemVer(version: string): boolean {
  return STRICT_SEMVER_PATTERN.test(version);
}
