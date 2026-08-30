type TrackFn = (eventName: string, properties: Record<string, unknown>) => void;
type PageFn = (properties: Record<string, unknown>, capturedAt?: number) => void;

interface Listener {
  target: EventTarget;
  event: string;
  handler: EventListener;
  capture: boolean;
}

export interface CapturedPage {
  capturedAt: number;
  properties: Record<string, unknown>;
}

/** Click hrefs are capped and scrubbed of obvious PII (mailto targets, email-bearing query params). */
const MAX_HREF_LENGTH = 500;
const EMAIL_PATTERN = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;

function redactHref(href: string): string | undefined {
  if (!href || href.startsWith('mailto:')) return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href.substring(0, MAX_HREF_LENGTH);
  }
  for (const key of [...url.searchParams.keys()]) {
    const value = url.searchParams.get(key) ?? '';
    if (/^email$/i.test(key) || EMAIL_PATTERN.test(value)) url.searchParams.delete(key);
  }
  // Credentials and fragments routinely carry passwords, OAuth tokens, or
  // router-local state. None of them belong in click telemetry.
  url.username = '';
  url.password = '';
  url.hash = '';
  const serialized = url.toString();
  return serialized.substring(0, MAX_HREF_LENGTH);
}

export class AutoCapture {
  private listeners: Listener[] = [];
  private running = false;
  private originalPushState: typeof history.pushState | null = null;
  private originalReplaceState: typeof history.replaceState | null = null;

  constructor(
    private track: TrackFn,
    private page: PageFn = properties => track('$pageview', properties)
  ) {}

  start(initialPage?: CapturedPage): void {
    if (this.running) return;
    if (typeof document === 'undefined') return;
    this.running = true;

    this.addListener(document, 'click', this.handleClick.bind(this), true);

    if (typeof window !== 'undefined') {
      this.addListener(window, 'popstate', this.handlePageView.bind(this));

      // Intercept pushState/replaceState to track SPA navigations
      if (typeof history !== 'undefined') {
        this.originalPushState = history.pushState;
        this.originalReplaceState = history.replaceState;

        history.pushState = (...args: Parameters<typeof history.pushState>) => {
          this.originalPushState!.apply(history, args);
          this.trackPageView();
        };
        history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
          this.originalReplaceState!.apply(history, args);
          this.trackPageView();
        };
      }
    }

    // Preserve the document snapshot captured by the lightweight snippet. If
    // navigation happened while the full SDK loaded, capture the current route
    // immediately after it so first-touch ordering remains truthful.
    this.trackPageView(initialPage);
    if (
      typeof initialPage?.properties.url === 'string' &&
      typeof window !== 'undefined' &&
      initialPage.properties.url !== window.location.href
    ) {
      this.trackPageView();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const { target, event, handler, capture } of this.listeners) {
      target.removeEventListener(event, handler, capture);
    }
    this.listeners = [];

    // Restore original history methods
    if (typeof history !== 'undefined') {
      if (this.originalPushState) {
        history.pushState = this.originalPushState;
        this.originalPushState = null;
      }
      if (this.originalReplaceState) {
        history.replaceState = this.originalReplaceState;
        this.originalReplaceState = null;
      }
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  private addListener(target: EventTarget, event: string, handler: EventListener, capture = false): void {
    target.addEventListener(event, handler, capture);
    this.listeners.push({ target, event, handler, capture });
  }

  private handleClick(event: Event): void {
    try {
      const target = event.target as Element;
      if (!target || !this.isInteractive(target)) return;

      this.track('$click', {
        tag: target.tagName,
        id: target.id || undefined,
        classes: (typeof target.className === 'string' && target.className) || undefined,
        text: target.textContent?.trim().substring(0, 100) || undefined,
        href: redactHref((target as HTMLAnchorElement).href || ''),
      });
    } catch {
      // Auto-capture should never break the page
    }
  }

  private handlePageView(): void {
    this.trackPageView();
  }

  private trackPageView(snapshot?: CapturedPage): void {
    try {
      if (snapshot) {
        this.page(snapshot.properties, snapshot.capturedAt);
        return;
      }
      const location = window.location;
      this.page({
        url: location.href,
        hostname: location.hostname || new URL(location.href).hostname,
        path: location.pathname,
        title: document.title || undefined,
        referrer: document.referrer || '',
      });
    } catch {
      // Auto-capture should never break the page
    }
  }

  private isInteractive(el: Element): boolean {
    const tags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
    if (tags.includes(el.tagName)) return true;
    const role = el.getAttribute?.('role');
    return role === 'button' || role === 'link' || role === 'menuitem';
  }
}
