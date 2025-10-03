# @alitycs/sdk-typescript

TypeScript analytics SDK for the Alitycs Platform.

## Installation

```bash
npm install @alitycs/sdk-typescript
# or
bun add @alitycs/sdk-typescript
```

## Quick Start

```typescript
import { Alitycs } from '@alitycs/sdk-typescript';

const sdk = Alitycs.init({ apiKey: 'your-api-key' });

sdk.track('button_clicked', { label: 'Sign Up' });
sdk.identify('user-123', { plan: 'premium' });
sdk.page('Home');
```

## API Reference

### Class API

```typescript
const sdk = Alitycs.init(config); // Create an instance

sdk.track(eventName, properties?);  // Track a custom event
sdk.identify(userId, traits?);      // Identify a user
sdk.page(name?, properties?);       // Track a page view
await sdk.flush();                  // Flush pending events
await sdk.shutdown();               // Stop SDK and flush remaining events
sdk.pending;                        // Number of events in the queue
```

### Module-level Convenience Functions

These use a shared default instance:

```typescript
import { init, track, identify, page, flush, shutdown } from '@alitycs/sdk-typescript';

init({ apiKey: 'your-api-key' });

track('button_clicked', { label: 'Sign Up' });
identify('user-123', { plan: 'premium' });
page('Home');
await flush();
await shutdown();
```

## Configuration

```typescript
interface AlitycsConfig {
  apiKey: string;              // Required. Your API key.
  endpoint?: string;           // Default: 'https://api.alitycs.com/events'
  flushInterval?: number;      // Default: 10000 (ms)
  flushSize?: number;          // Default: 25
  maxQueueSize?: number;       // Default: 1000
  maxRetries?: number;         // Default: 3
  autoCapture?: boolean;       // Default: false
  debug?: boolean;             // Default: false
  sessionTimeout?: number;     // Default: 1800000 (30 min)
  batching?: boolean;          // Default: true
}
```

## Features

- Batching with configurable flush size and interval
- Fire-and-forget mode (`batching: false`) for immediate sends
- Exponential backoff retry
- Session management with automatic rotation on timeout
- Auto-capture for clicks and page views
- Browser context collection (locale, timezone, user agent, screen, UTM params)
- Zero dependencies

## Testing

```bash
bun test                   # Run all tests
bun test --coverage        # Run with coverage
bun run type-check         # TypeScript type checking
```

## License

MIT
