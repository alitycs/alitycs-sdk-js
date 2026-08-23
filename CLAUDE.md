# CLAUDE.md — alitycs-sdk-js

## Project Overview

Bun-based monorepo containing JavaScript/TypeScript analytics SDKs for the Alitycs Platform. Three packages live under `sdks/`:

- **`@alitycs/core`** (v1.0.1) — Universal analytics SDK: event tracking, batching, sessions, HTTP transport with retry. Works in Node/Bun/Deno/Edge/Workers.
- **`@alitycs/browser`** (v1.0.1) — Browser analytics SDK extending `@alitycs/core` with auto-capture, beforeunload handling, and snippet integration.
- **`@alitycs/browser-snippet`** (v1.0.1) — Ultra-lightweight (~1KB) drop-in `<script>` loader that queues calls and async-loads the full SDK.

## Commands

### Root (from repo root)

```bash
bun run build:all          # Build all SDKs (core → browser → snippet)
bun run test:all           # Run all SDK tests
bun run lint:all           # Lint all SDKs
```

### Core SDK (`sdks/core/`)

```bash
bun test                   # All tests
bun test tests/unit        # Unit tests only
bun test tests/integration # Integration tests only
bun test --coverage        # With coverage
bun run build              # ESM build (Node target)
bun run build:all          # ESM + CJS + types
bun run type-check         # tsc --noEmit
bun run lint               # ESLint
bun run lint:fix           # ESLint with auto-fix
bun run format             # Prettier write
bun run format:check       # Prettier check
```

### Browser SDK (`sdks/browser/`)

```bash
bun test                   # All tests
bun test tests/unit        # Unit tests only
bun run build              # ESM build (externals @alitycs/core)
bun run build:all          # ESM + browser ESM + IIFE + CJS + types
bun run type-check         # tsc --noEmit
bun run lint               # ESLint
bun run lint:fix           # ESLint with auto-fix
bun run format             # Prettier write
bun run format:check       # Prettier check
```

### Browser Snippet (`sdks/browser-snippet/`)

```bash
bun test                   # All tests (uses happy-dom)
bun test tests/size.test.ts # Bundle size check
bun run build              # Dev + prod IIFE builds
bun run type-check         # tsc --noEmit
```

## Architecture

### Monorepo Layout

```
sdks/
├── core/                    # @alitycs/core (universal)
│   ├── src/
│   │   ├── index.ts          # Alitycs class (protected constructor) + module-level convenience fns
│   │   ├── transport.ts      # HttpTransport — HTTP send with retry
│   │   ├── batch-manager.ts  # BatchManager — queue, flush-on-size, flush-on-timer
│   │   ├── session.ts        # SessionManager — session ID + anonymous ID + timeout rotation
│   │   ├── context.ts        # collectContext() — SDK version, browser/OS metadata (typeof guards)
│   │   ├── types.ts          # Shared types/interfaces (no autoCapture)
│   │   └── utils.ts          # generateId(), serializeProperties()
│   └── tests/
│       ├── unit/             # One test file per module
│       └── integration/      # End-to-end SDK + transport tests
├── browser/                 # @alitycs/browser (extends core)
│   ├── src/
│   │   ├── index.ts          # BrowserAlitycs extends Alitycs + convenience fns
│   │   ├── auto-capture.ts   # AutoCapture — DOM event listeners (clicks, page views, SPA nav)
│   │   ├── browser.ts        # initializeFromSnippet() — snippet integration entry point
│   │   └── types.ts          # BrowserConfig extends AlitycsConfig (adds autoCapture)
│   └── tests/unit/
└── browser-snippet/         # @alitycs/browser-snippet
    ├── src/
    │   ├── snippet.ts        # IIFE entry — auto-runs on load
    │   ├── config.ts         # parseScriptConfig() from data-* attributes
    │   ├── queue.ts          # CallQueue — buffers calls before SDK loads
    │   ├── stub.ts           # createStub() — window.alitycs proxy
    │   ├── loader.ts         # SDKLoader — async script injection
    │   └── types.ts
    └── tests/
```

### Inheritance Model

`BrowserAlitycs extends Alitycs` via protected constructor. Core fields (`config`, `transport`, `batchManager`, `sessionManager`) are `protected` so browser can extend. `DEFAULTS` is exported from core so browser can spread and add `autoCapture`.

### Event Processing Pipeline (Core SDK)

1. `track()`/`identify()`/`page()` → `enqueue()`
2. `enqueue()` builds an `AnalyticsEvent` (with IDs, session, context, timestamp)
3. If batching enabled: `BatchManager.add()` queues the event, auto-flushes at `flushSize` or `flushInterval`
4. `BatchManager.flush()` wraps events in a `BatchPayload` and calls `HttpTransport.send()`
5. If batching disabled: immediately wraps in `BatchPayload` and sends

### Browser SDK Additions

- `autoCapture` option — DOM click tracking, SPA page view tracking (pushState/replaceState interception)
- `beforeunload` handler — auto-flushes on page unload
- `initializeFromSnippet()` — bridges the browser-snippet queue to the real SDK

### Browser Snippet Design

The snippet is a self-executing IIFE that:
1. Parses `data-api-key` (and other `data-*` config) from its own `<script>` tag
2. Creates a `CallQueue` to buffer method calls
3. Attaches a stub `window.alitycs()` function that pushes calls to the queue
4. `SDKLoader` async-loads the full SDK, then replays queued calls

### Build Strategy

- **Core**: ESM + CJS (Node target). No browser builds.
- **Browser**: ESM/CJS externalize `@alitycs/core`. Browser ESM + IIFE inline core for CDN/script-tag use.
- **Browser Snippet**: IIFE only.

## Code Conventions

### Formatting (Prettier — `sdks/core/.prettierrc`)

- Single quotes, semicolons, trailing commas (es5)
- 120 char print width, 2-space indent, LF line endings
- Arrow parens: `avoid`

### Linting (ESLint — `sdks/core/eslint.config.mjs`)

- `no-console` is **warn** (allow `console.warn`/`console.error`)
- Strict equality required (`eqeqeq: always`)
- `prefer-const`, `prefer-template`, `object-shorthand` enforced
- Ignores `dist/`, `*.js`, `*.d.ts`

### TypeScript

- `strict: true`, target ES2022, module ESNext, bundler resolution
- Types from `bun-types`
- Browser SDK adds `"lib": ["ES2022", "DOM", "DOM.Iterable"]`
- No emit (build is via `bun build`, not `tsc`)

### Testing Patterns

- Test runner: `bun:test` (imports: `describe`, `test`, `expect`, `mock`, `beforeEach`, `afterEach`)
- Unit tests mirror source: `src/foo.ts` → `tests/unit/foo.test.ts`
- Integration tests use `*.integration.test.ts` suffix
- Helper factories (`makeConfig()`, `makeEvent()`, `makeMockTransport()`) at top of test files
- Browser SDK tests mock `window`/`document`/`history` globals in beforeEach/afterEach
- Browser snippet tests use `happy-dom` for DOM APIs

### Workspace Dependencies

- `@alitycs/browser` depends on `@alitycs/core` via `"workspace:*"`
- Browser tsconfig uses `paths` to resolve `@alitycs/core` for type-checking
