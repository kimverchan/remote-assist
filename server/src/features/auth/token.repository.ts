import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Role } from '../../shared/protocol';

export interface RefreshRecord {
  jti: string;
  subject: string;
  sessionId: string;
  role: Role;
  expiresAt: number;
}

/** refresh token 只以 SHA-256 摘要形式存服务端内存，明文永不落库、永不写日志 */
export class TokenRepository {
  private readonly records = new Map<string, RefreshRecord>();
  private readonly gcTimer: NodeJS.Timeout;

  constructor() {
    this.gcTimer = setInterval(() => this.purgeExpired(), 30_000);
    this.gcTimer.unref();
  }

  static hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  save(record: RefreshRecord): string {
    const raw = randomBytes(32).toString('base64url');
    this.records.set(TokenRepository.hash(raw), record);
    return raw;
  }

  /** 一次性消费：刷新后旧 token 立即失效（轮换） */
  consume(raw: string): RefreshRecord | undefined {
    const key = TokenRepository.hash(raw);
    const record = this.records.get(key);
    this.records.delete(key);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    return record;
  }

  revokeBySession(sessionId: string): number {
    let revoked = 0;
    for (const [key, record] of this.records) {
      if (record.sessionId === sessionId) {
        this.records.delete(key);
        revoked += 1;
      }
    }
    return revoked;
  }

  purgeExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.records.size;
  }

  dispose(): void {
    clearInterval(this.gcTimer);
    this.records.clear();
  }
}

/** 用定长 HMAC 摘要比较，避免字符串比较的时序侧信道 */
export function safeKeyEqual(provided: string, expected: string, secret: string): boolean {
  const a = createHmac('sha256', secret).update(provided).digest();
  const b = createHmac('sha256', secret).update(expected).digest();
  return timingSafeEqual(a, b);
}
