# Alitycs Analytics SDKs

**Multi-language analytics SDKs** for the Alitycs Analytics Platform. Production-ready event collection, processing, and ingestion with comprehensive privacy protection and enterprise-grade reliability.

## 🌐 Available SDKs

| Language | Status | Version | Documentation |
|----------|--------|---------|---------------|
| [TypeScript/JavaScript](./sdks/typescript) | ✅ **Stable** | 2.0.0 | [Docs](./sdks/typescript/README.md) |
| [Python](./sdks/python) | 🚧 Coming Soon | - | [Plan](./docs/language-guides/python.md) |
| [Java](./sdks/java) | 📋 Planned | - | [Plan](./docs/language-guides/java.md) |
| [Go](./sdks/go) | 📋 Planned | - | [Plan](./docs/language-guides/go.md) |

## 🚀 Quick Start

### TypeScript/JavaScript

```bash
cd sdks/typescript
bun install
bun test
```

```typescript
import { Analytics } from '@alitycs/sdk-typescript';

await Analytics.initialize({
  apiKey: 'your-api-key',
  apiEndpoint: 'https://your-endpoint.com'
});

Analytics.track('user_signup', { plan: 'premium' });
Analytics.identify('user-123', { name: 'John Doe' });
Analytics.page('dashboard');
```

## 📦 Repository Structure

```
alitycs-agents/
├── sdks/                       # Language-specific SDKs
│   ├── typescript/            # ✅ TypeScript/JavaScript SDK
│   ├── python/                # 🚧 Python SDK (coming soon)
│   ├── java/                  # 📋 Java SDK (planned)
│   └── go/                    # 📋 Go SDK (planned)
│
├── specs/                      # Shared API specifications
│   ├── event-schema.json      # Event structure schema
│   └── PROTOCOL.md            # Transport protocol docs
│
├── docs/                       # Shared documentation
│   ├── API.md                 # API reference
│   └── language-guides/       # Language-specific guides
│
├── examples/                   # Cross-language examples
│   ├── typescript/
│   ├── python/
│   └── java/
│
└── tools/                      # Shared tooling
    ├── scripts/               # Build & test scripts
    └── ci/                    # CI/CD configs
```

## ✨ Core Features (All SDKs)

- **🔒 PII Protection** - Automatic sensitive data redaction
- **🚚 Reliable Transport** - Circuit breaker with failover
- **⚡ High Performance** - Intelligent batching & compression
- **🎯 Auto-capture** - DOM events, page views, errors
- **💾 Offline Support** - Local storage with sync
- **🔄 Smart Retry** - Exponential backoff
- **🛡️ GDPR Compliant** - Built-in consent management

## 📚 Documentation

- [Architecture Overview](./docs/architecture.md)
- [API Reference](./docs/API.md)
- [Getting Started](./docs/GETTING_STARTED.md)
- [Shared Specifications](./specs/)

## 🤝 Contributing

Each SDK has its own contributing guidelines:

- [TypeScript Contributing](./sdks/typescript/CONTRIBUTING.md)
- [Python Contributing](./sdks/python/CONTRIBUTING.md) (coming soon)

## 📝 License

MIT License - see [LICENSE](./LICENSE) for details

## 🔗 Links

- [Official Documentation](https://docs.alitycs.com)
- [API Status](https://status.alitycs.com)
- [Support](https://support.alitycs.com)

---

**Choose your language above to get started** 🚀
