import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Structural guards for the two failure modes that break at the CONSUMER'S
 * build, not in our tests:
 *
 * 1. The /server entry must never reach @alitycs/browser (or any other
 *    DOM-touching module) through any import path — a Server Component or
 *    middleware build would fail on `window`/`document`.
 * 2. The client entry must carry 'use client', and so must the module holding
 *    its hooks, or Next treats them as Server Components.
 */

const PACKAGE_ROOT = resolve(import.meta.dir, '..');

function readSource(relativePath: string): string {
  return readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8');
}

/** Extracts every static and dynamic module specifier from a source file. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /^import\s*['"]([^'"]+)['"]/gm,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]!);
    }
  }
  return [...found];
}

/** Resolves workspace-internal specifiers to source files; external ones to null. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let candidate: string;
  if (specifier.startsWith('.')) {
    candidate = resolve(dirname(fromFile), specifier);
  } else if (specifier === '@alitycs/core') {
    candidate = resolve(PACKAGE_ROOT, '../core/src/index.ts');
  } else if (specifier === '@alitycs/react') {
    // Source-level truth for the graph walk; at runtime the package resolves
    // through its dist, whose own react import lands on the same physical copy.
    candidate = resolve(PACKAGE_ROOT, '../react/src/index.ts');
  } else {
    // Bare dependency (next, react, node builtins) — external by construction.
    return null;
  }

  const absolute = candidate;
  try {
    return readFileSync(absolute, 'utf8') ? absolute : null;
  } catch {
    // Relative specifiers may carry or omit extensions.
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const withSuffix = `${absolute}${suffix}`;
      try {
        readFileSync(withSuffix, 'utf8');
        return withSuffix;
      } catch {
        continue;
      }
    }
    return null;
  }
}

/** Walks the import graph of an entry, returning every reached workspace file. */
function importGraph(entryRelative: string): string[] {
  const entry = join(PACKAGE_ROOT, entryRelative);
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    let source: string;
    try {
      source = readFileSync(current, 'utf8');
    } catch {
      continue;
    }

    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveSpecifier(specifier, current);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }

  return [...visited];
}

describe('server entry isolation', () => {
  const DOM_PACKAGES = ['/sdks/browser/', '/sdks/browser-snippet/', '/sdks/react/'];

  test('never reaches a DOM-touching module through any import path', () => {
    const graph = importGraph('src/server.ts');

    // The walk must be real: it has to have traversed the core sources this
    // entry is built on, otherwise these assertions are vacuous.
    const coreFiles = graph.filter(file => file.includes('/sdks/core/src/'));
    expect(coreFiles.length).toBeGreaterThan(0);
    expect(graph.some(file => file.endsWith('src/server.ts'))).toBe(true);

    const offenders = graph.filter(file => DOM_PACKAGES.some(marker => file.includes(marker)));
    expect(offenders).toEqual([]);

    // Belt and braces: no reached file may even import the browser package
    // (doc comments mentioning it are fine; imports are not).
    for (const file of graph) {
      const source = readFileSync(file, 'utf8');
      const browserImports = importSpecifiers(source).filter(specifier => specifier.startsWith('@alitycs/browser'));
      expect(browserImports, `${file} imports @alitycs/browser`).toEqual([]);
    }
  });

  test('is not marked as a client component', () => {
    const firstLine = readSource('src/server.ts').split('\n')[0]!;
    expect(firstLine.includes('use client')).toBe(false);
  });
});

describe('client entry wiring', () => {
  test("carries 'use client' on the boundary and on the hooks module", () => {
    for (const file of ['src/index.tsx', 'src/router-tracking.tsx']) {
      const firstLine = readSource(file).split('\n')[0]!.trim();
      expect(firstLine, `${file} must start with 'use client'`).toBe("'use client';");
    }
  });

  test('wraps @alitycs/react rather than reimplementing it', () => {
    const graph = importGraph('src/index.tsx');
    expect(graph.some(file => file.includes('/sdks/react/src/provider.'))).toBe(true);
    expect(graph.some(file => file.includes('/sdks/react/src/hooks.'))).toBe(true);
  });

  test('publishes both entries through the exports map', () => {
    const manifest = JSON.parse(readSource('package.json')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(manifest.exports['.']?.import).toBe('./dist/index.esm.js');
    expect(manifest.exports['./server']?.import).toBe('./dist/server.esm.js');
    expect(manifest.exports['./server']?.require).toBe('./dist/server.js');
  });
});
