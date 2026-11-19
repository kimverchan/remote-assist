import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logger';

/** 持久化的设备凭据记录：只存 peppered 摘要，绝不落明文密码 */
interface StoredCredential {
  deviceId: string;
  permanent: string;
  /** 临时密码摘要，null = 未启用 */
  temporary: string | null;
  /** 临时密码到期时间戳（ms） */
  temporaryExpiresAt: number;
  updatedAt: number;
}

interface PersistedFile {
  version: 1;
  devices: StoredCredential[];
}

export interface VerificationResult {
  ok: boolean;
  /** 是否命中临时密码，仅用于区分限流策略 */
  viaTemporary: boolean;
}

/** 与真实摘要等长的占位值：设备不存在时也做一次常量时间比较，消除枚举差异 */
const DUMMY_DIGEST = '0'.repeat(64);

/**
 * 设备凭据仓储（App 全权管理 + 自动注册）。
 *
 * - 摘要 = HMAC-SHA256(pepper=JWT_SECRET, deviceId + ':' + 密码)。
 *   使用服务端 pepper，攻击者即使拿到 JSON 文件，没有 JWT_SECRET 也无法离线爆破
 *   6 位数字密码；deviceId 参与派生，避免跨设备彩虹表。
 * - 首次注册随建会话自动完成；改密码需提供旧密码防劫持。
 * - 临时密码带到期时间，过期自动失效；按设备累计失败次数，超限锁定。
 */
export class DeviceCredentialsRepository {
  private readonly devices = new Map<string, StoredCredential>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly filePath: string;

  constructor(
    dataDir: string,
    private readonly pepper: string,
    private readonly lockThreshold: number,
    private readonly lockDurationMs: number,
  ) {
    this.filePath = path.join(dataDir, 'device-credentials.json');
    this.load();
    const gc = setInterval(() => this.purgeExpired(), 60_000);
    gc.unref();
  }

  /** 计算 peppered 摘要。明文密码只在内存里短暂存在，绝不写日志或文件。 */
  digest(deviceId: string, password: string): string {
    return createHmac('sha256', this.pepper)
      .update(`${deviceId}:${password}`)
      .digest('hex');
  }

  private safeEqualHex(a: string, b: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
        throw new Error('unsupported format');
      }
      for (const item of parsed.devices) {
        if (typeof item.deviceId !== 'string' || !this.safeEqualHex(item.permanent, item.permanent)) {
          continue;
        }
        this.devices.set(item.deviceId, {
          deviceId: item.deviceId,
          permanent: item.permanent.toLowerCase(),
          temporary:
            typeof item.temporary === 'string' && this.safeEqualHex(item.temporary, item.temporary)
              ? item.temporary.toLowerCase()
              : null,
          temporaryExpiresAt: Number(item.temporaryExpiresAt) || 0,
          updatedAt: Number(item.updatedAt) || Date.now(),
        });
      }
      logger.info('device_credentials_loaded', { count: this.devices.size });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('device_credentials_load_failed', { error: (err as Error).message });
      }
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: PersistedFile = { version: 1, devices: [...this.devices.values()] };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  get(deviceId: string): StoredCredential | undefined {
    return this.devices.get(deviceId);
  }

  has(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /**
   * 注册或改密码。
   * - 设备不存在：直接注册（首次启动）。
   * - 设备已存在且提供 oldPassword：校验旧密码后更新，防他人劫持。
   * - 设备已存在且未提供 oldPassword：仅当新密码与现有一致时视为幂等成功，否则拒绝。
   */
  register(
    deviceId: string,
    newPassword: string,
    oldPassword?: string,
  ): 'registered' | 'updated' | 'unchanged' | 'rejected' {
    const newDigest = this.digest(deviceId, newPassword);
    const existing = this.devices.get(deviceId);
    if (!existing) {
      this.devices.set(deviceId, {
        deviceId,
        permanent: newDigest,
        temporary: null,
        temporaryExpiresAt: 0,
        updatedAt: Date.now(),
      });
      this.persist();
      return 'registered';
    }
    if (oldPassword !== undefined) {
      if (!this.safeEqualHex(this.digest(deviceId, oldPassword), existing.permanent)) {
        return 'rejected';
      }
      existing.permanent = newDigest;
      existing.updatedAt = Date.now();
      this.devices.set(deviceId, existing);
      this.persist();
      return 'updated';
    }
    // 无旧密码：只允许「重复注册同一密码」的幂等场景
    if (this.safeEqualHex(newDigest, existing.permanent)) return 'unchanged';
    return 'rejected';
  }

  /** 设置/清除临时密码；需校验长期密码 */
  setTemporary(
    deviceId: string,
    permanentPassword: string,
    temporaryPassword: string | null,
    expiresAt: number,
  ): boolean {
    const existing = this.devices.get(deviceId);
    if (!existing) return false;
    if (!this.safeEqualHex(this.digest(deviceId, permanentPassword), existing.permanent)) {
      return false;
    }
    existing.temporary = temporaryPassword ? this.digest(deviceId, temporaryPassword) : null;
    existing.temporaryExpiresAt = temporaryPassword ? expiresAt : 0;
    existing.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /** 校验密码：长期密码或有效期内临时密码任一命中即可 */
  verify(deviceId: string, password: string): VerificationResult {
    const record = this.devices.get(deviceId);
    const digest = this.digest(deviceId, password);
    const permanent = record?.permanent ?? DUMMY_DIGEST;
    const ok = this.safeEqualHex(digest, permanent);
    if (ok) return { ok: true, viaTemporary: false };

    if (record?.temporary && record.temporaryExpiresAt > Date.now()) {
      const viaTemporary = this.safeEqualHex(digest, record.temporary);
      if (viaTemporary) return { ok: true, viaTemporary: true };
    }
    return { ok: false, viaTemporary: false };
  }

  isLocked(deviceId: string): boolean {
    const rec = this.failures.get(deviceId);
    return Boolean(rec && rec.lockedUntil > Date.now());
  }

  lockRemainingMs(deviceId: string): number {
    const rec = this.failures.get(deviceId);
    return rec ? Math.max(0, rec.lockedUntil - Date.now()) : 0;
  }

  /** 记录一次失败；达到阈值时锁定并返回 true */
  recordFailure(deviceId: string): boolean {
    const now = Date.now();
    const rec = this.failures.get(deviceId) ?? { count: 0, lockedUntil: 0 };
    if (rec.lockedUntil > now) return true;
    rec.count += 1;
    if (rec.count >= this.lockThreshold) {
      rec.lockedUntil = now + this.lockDurationMs;
      rec.count = 0;
      this.failures.set(deviceId, rec);
      return true;
    }
    this.failures.set(deviceId, rec);
    return false;
  }

  clearFailures(deviceId: string): void {
    this.failures.delete(deviceId);
  }

  private purgeExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, rec] of this.devices) {
      if (rec.temporary && rec.temporaryExpiresAt <= now) {
        rec.temporary = null;
        rec.temporaryExpiresAt = 0;
        this.devices.set(id, rec);
        changed = true;
      }
    }
    if (changed) this.persist();
    for (const [id, rec] of this.failures) {
      if (rec.lockedUntil <= now && rec.count === 0) this.failures.delete(id);
    }
  }

  get size(): number {
    return this.devices.size;
  }
}
