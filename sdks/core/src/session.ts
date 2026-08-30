import type { SessionData } from './types';
import { generateId } from './utils';

const STORAGE_KEY = 'alitycs_session';

export class SessionManager {
  private session: SessionData;
  private sessionTimeout: number;
  private storage: SimpleStorage | null;

  constructor(
    sessionTimeout: number,
    private onRotate?: (session: SessionData) => void
  ) {
    this.sessionTimeout = sessionTimeout;
    this.storage = selectStorage();
    this.session = this.restore() ?? this.create();
  }

  getSession(): SessionData {
    return this.session;
  }

  touch(): void {
    if (this.isExpired()) {
      this.session = this.create(this.session.anonymousId);
      this.persist();
      this.onRotate?.(this.session);
    } else {
      this.session.lastActivity = Date.now();
      this.persist();
    }
  }

  setUserId(userId: string): void {
    this.session.userId = userId;
    this.session.lastActivity = Date.now();
    this.persist();
  }

  reset(): SessionData {
    this.session = this.create();
    return this.session;
  }

  private isExpired(): boolean {
    return Date.now() - this.session.lastActivity > this.sessionTimeout;
  }

  private create(anonymousId?: string): SessionData {
    const session: SessionData = {
      id: `sess_${generateId()}`,
      anonymousId: anonymousId ?? `anon_${generateId()}`,
      startTime: Date.now(),
      lastActivity: Date.now(),
    };
    this.persist(session);
    return session;
  }

  private restore(): SessionData | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as SessionData;
      if (!data.id || !data.anonymousId || !data.lastActivity) return null;

      // Expired session — new session, preserve anonymousId, clear userId
      if (Date.now() - data.lastActivity > this.sessionTimeout) {
        const rotated = this.create(data.anonymousId);
        this.onRotate?.(rotated);
        return rotated;
      }
      return data;
    } catch {
      return null;
    }
  }

  private persist(session?: SessionData): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(session ?? this.session));
    } catch {
      // localStorage may be full or disabled — ignore
    }
  }
}

interface SimpleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function selectStorage(): SimpleStorage | null {
  if (typeof localStorage !== 'undefined') {
    try {
      // Test that localStorage actually works
      localStorage.setItem('__alitycs_test', '1');
      localStorage.removeItem('__alitycs_test');
      return localStorage;
    } catch {
      // localStorage exists but is disabled (e.g., Safari private mode)
    }
  }
  return null;
}
