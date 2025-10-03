# @alitycs/browser-snippet

> Ultra-lightweight analytics snippet for instant drop-in integration

[![Bundle Size](https://img.shields.io/badge/gzipped-1.73KB-brightgreen)](./dist/snippet.min.js)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 🚀 Quick Start (30 seconds)

Add this to your HTML `<head>`:

```html
<script src="https://cdn.alitycs.com/snippet.min.js"
        data-api-key="YOUR_API_KEY"
        async></script>
```

Start tracking:

```html
<script>
  alitycs('track', 'button_clicked', { button: 'signup' });
</script>
```

Done! 🎉

## 📦 What is this?

The Alitycs browser snippet is a **tiny (~1.7KB gzipped)** JavaScript loader that provides instant analytics tracking with zero configuration. Similar to Google Analytics or Segment, just add one script tag and start tracking.

### Key Features

- **🪶 Ultra-lightweight** - Only 1.73KB gzipped
- **⚡ Zero blocking** - Async loading, no render blocking
- **🎯 Simple API** - Familiar syntax: `alitycs('track', 'event')`
- **🔄 Auto-queuing** - Captures events before SDK loads
- **🚫 Zero dependencies** - Completely self-contained
- **🔧 Highly configurable** - Custom endpoints, SDK URLs, debug mode

## 📖 Installation

### CDN (Recommended)

```html
<!-- Latest version -->
<script src="https://cdn.alitycs.com/snippet.min.js"
        data-api-key="YOUR_KEY"
        async></script>

<!-- Specific version -->
<script src="https://cdn.alitycs.com/snippet@1.0.0/snippet.min.js"
        data-api-key="YOUR_KEY"
        async></script>
```

### Self-Hosted

```bash
npm install @alitycs/browser-snippet
```

Copy `dist/snippet.min.js` to your static assets:

```html
<script src="/js/snippet.min.js" data-api-key="YOUR_KEY" async></script>
```

## 🎯 Usage

### Basic Tracking

```javascript
// Track an event
alitycs('track', 'button_clicked', {
  button: 'signup',
  page: 'homepage'
});

// Identify a user
alitycs('identify', 'user_123', {
  email: 'user@example.com',
  plan: 'premium'
});

// Track page view
alitycs('page', 'Homepage', {
  path: window.location.pathname
});
```

### Helper Methods

```javascript
// These are equivalent:
alitycs('track', 'event', { foo: 'bar' });
alitycs.track('event', { foo: 'bar' });

// Chainable:
alitycs.track('event1')
      .identify('user_id')
      .page('Home');
```

### Available Methods

| Method | Description | Example |
|--------|-------------|---------|
| `track(event, properties)` | Track custom event | `alitycs.track('signup', { plan: 'pro' })` |
| `identify(userId, traits)` | Identify user | `alitycs.identify('user_123', { email: '...' })` |
| `page(name, properties)` | Track page view | `alitycs.page('Home', { path: '/' })` |

## ⚙️ Configuration

### Script Tag Attributes

Configure the snippet using `data-*` attributes:

```html
<script src="https://cdn.alitycs.com/snippet.min.js"
        data-api-key="YOUR_KEY"              <!-- Required: Your API key -->
        data-sdk-url="https://..."           <!-- Optional: Custom SDK URL -->
        data-endpoint="https://..."          <!-- Optional: Custom API endpoint -->
        data-auto-track="false"              <!-- Optional: Disable auto page tracking -->
        data-debug="true"                    <!-- Optional: Enable debug logging -->
        async></script>
```

### Configuration Options

| Attribute | Description | Default | Required |
|-----------|-------------|---------|----------|
| `data-api-key` | Your Alitycs API key | - | ✅ Yes |
| `data-sdk-url` | Custom SDK URL (for self-hosting) | `cdn.alitycs.com/sdk@2/browser.min.js` | No |
| `data-endpoint` | Custom API endpoint | `api.alitycs.com/v1/events` | No |
| `data-auto-track` | Auto-track initial page view | `true` | No |
| `data-debug` | Enable console logging | `false` | No |

### Examples

#### Production (Minimal)

```html
<script src="https://cdn.alitycs.com/snippet.min.js"
        data-api-key="prod_key_abc123"
        async></script>
```

#### Development (Debug Mode)

```html
<script src="https://cdn.alitycs.com/snippet.min.js"
        data-api-key="dev_key_xyz789"
        data-debug="true"
        async></script>
```

#### Self-Hosted (Full Control)

```html
<script src="https://your-domain.com/snippet.min.js"
        data-api-key="your_key"
        data-sdk-url="https://your-domain.com/alitycs-sdk.min.js"
        data-endpoint="https://your-api.com/events"
        async></script>
```

#### SPA (Manual Page Tracking)

```html
<script src="https://cdn.alitycs.com/snippet.min.js"
        data-api-key="your_key"
        data-auto-track="false"  <!-- Disable auto tracking -->
        async></script>

<script>
  // Manually track page changes
  window.addEventListener('routechange', (e) => {
    alitycs('page', e.detail.pageName, { path: e.detail.path });
  });
</script>
```

## 🔄 How It Works

1. **Snippet loads** (~1.7KB) - Creates global `window.alitycs` object
2. **Stub methods queue calls** - All events are stored in memory
3. **Full SDK loads async** - Triggered by user interaction or idle time
4. **Queue replays** - All queued events are sent to API
5. **Real SDK takes over** - Direct tracking from this point

```
User loads page
       ↓
Snippet creates stub (instant)
       ↓
User calls alitycs('track', ...) → Queued ✓
       ↓
User interacts with page
       ↓
Full SDK loads in background
       ↓
Queue replays → Events sent ✓
       ↓
Future calls go direct to SDK
```

## 🎨 Use Cases

### Static Sites

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.alitycs.com/snippet.min.js"
          data-api-key="YOUR_KEY" async></script>
</head>
<body>
  <button onclick="alitycs('track', 'cta_clicked')">
    Sign Up
  </button>
</body>
</html>
```

### Single Page Applications (React, Vue, etc.)

```jsx
// Track route changes
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

function Analytics() {
  const location = useLocation();

  useEffect(() => {
    window.alitycs('page', document.title, {
      path: location.pathname
    });
  }, [location]);

  return null;
}
```

### E-commerce

```javascript
// Track product views
alitycs('track', 'product_viewed', {
  product_id: '123',
  name: 'Premium Widget',
  price: 99.99,
  category: 'Widgets'
});

// Track purchases
alitycs('track', 'order_completed', {
  order_id: 'ORD-456',
  total: 299.97,
  items: 3
});
```

## 🧪 Testing

The snippet includes comprehensive tests:

```bash
# Run all tests
bun test

# Test bundle size (must be < 5KB gzipped)
bun test tests/size.test.ts

# Run tests in watch mode
bun test --watch
```

## 🔨 Development

```bash
# Build snippet
bun run build

# Watch mode (auto-rebuild on changes)
bun run dev

# Clean build artifacts
bun run clean

# Type check
bun run type-check
```

## 📊 Bundle Size

- **Minified**: 4.3 KB
- **Gzipped**: 1.73 KB
- **Brotli**: ~1.5 KB

Size is enforced by automated tests to ensure the snippet stays lightweight.

## 🔐 Privacy & Security

- **No cookies** - Doesn't set any cookies by default
- **No tracking without consent** - You control when tracking starts
- **CSP compatible** - Works with Content Security Policy
- **No third-party domains** (when self-hosted)

## 🆚 Comparison

| Feature | Alitycs Snippet | Google Analytics | Segment |
|---------|----------------|------------------|---------|
| Bundle Size (gzipped) | 1.73 KB | ~45 KB | ~50 KB |
| Async Loading | ✅ | ✅ | ✅ |
| Self-hostable | ✅ | ❌ | ❌ |
| Open Source | ✅ | ❌ | ❌ |
| Zero Config | ✅ | ✅ | ✅ |

## 🤝 Integration with TypeScript SDK

For programmatic control, use the full TypeScript SDK:

```bash
npm install @alitycs/sdk-typescript
```

```typescript
import { AnalyticsSDK } from '@alitycs/sdk-typescript';

const analytics = new AnalyticsSDK({
  apiKey: 'YOUR_KEY',
  // Advanced configuration...
});

analytics.track('event', { foo: 'bar' });
```

See [@alitycs/sdk-typescript](../typescript/README.md) for full documentation.

## 📚 Examples

See the [examples](./examples) directory:

- [basic.html](./examples/basic.html) - Simple integration
- [spa.html](./examples/spa.html) - Single Page Application
- [custom-config.html](./examples/custom-config.html) - Advanced configuration

## 🐛 Debugging

Enable debug mode to see console logs:

```html
<script src="snippet.min.js"
        data-api-key="YOUR_KEY"
        data-debug="true"></script>
```

Check snippet status:

```javascript
console.log('SDK loaded:', window.alitycs.loaded);
console.log('Queue size:', window.alitycs._queue.length);
console.log('Config:', window.alitycs._config);
```

## 📝 License

MIT © Alitycs Team

## 🔗 Links

- [Main Repository](https://github.com/alitycs/alitycs-agents)
- [TypeScript SDK](../typescript/README.md)
- [Documentation](https://docs.alitycs.com)
- [API Reference](https://docs.alitycs.com/api)

---

**Need help?** [Open an issue](https://github.com/alitycs/alitycs-agents/issues)
