import { randomBytes } from 'node:crypto';
import { config } from '../../config/env';
import type { DeviceInfo, ScreenInfo } from '../../shared/protocol';

export type SessionStatus = 'waiting' | 'active' | 'closed';

export interface Session {
  id: string;
  hostId: string;
  hostDevice: DeviceInfo;
  controllerId?: string;
  controllerDevice?: DeviceInfo;
  /** v2：被协助者是否已在本会话内明确同意协助 */
  authorized: boolean;
  /** 授权绑定到具体控制端，换设备重连必须重新确认 */
  authorizedFor?: string;
  /** 无人值守直连会话：由固定 deviceId + 预共享密钥建立，不签发 6 位配对码 */
  unattended?: boolean;
  /** 无人值守会话绑定的白名单设备 ID（精确匹配） */
  deviceId?: string;
  status: SessionStatus;
  createdAt: number;
  expiresAt: number;
  hostOnline: boolean;
  controllerOnline: boolean;
  bytesRelayed: number;
  framesRelayed: number;
  commandsRelayed: number;
  createdIp: string;
}

export interface SessionView {
  sessionId: string;
  status: SessionStatus;
  host: { model: string; osVersion: string; screen: ScreenInfo };
  controller?: { model: string; osVersion: string };
  hostOnline: boolean;
  controllerOnline: boolean;
  authorized: boolean;
  createdAt: number;
  expiresAt: number;
  bytesRelayed: number;
  framesRelayed: number;
  commandsRelayed: number;
  /** 便于管理台识别无人值守会话及其绑定设备 */
  unattended?: boolean;
  deviceId?: string;
}

/** 会话实体内存仓储。所有状态易失，服务重启即全部失效。 */
export class SessionRepository {
  private readonly sessions = new Map<string, Session>();
  /** 无人值守索引：deviceId → sessionId，供直连认领按设备 ID 查找会话 */
  private readonly deviceIndex = new Map<string, string>();
  private readonly gcTimer: NodeJS.Timeout;

  constructor() {
    this.gcTimer = setInterval(() => this.purgeExpired(), 5000);
    this.gcTimer.unref();
  }

  create(hostDevice: DeviceInfo, ip: string, now = Date.now()): Session {
    const session: Session = {
      id: `s_${randomBytes(12).toString('hex')}`,
      hostId: `h_${randomBytes(6).toString('hex')}`,
      hostDevice,
      status: 'waiting',
      createdAt: now,
      expiresAt: now + config.sessionTtl * 1000,
      hostOnline: false,
      controllerOnline: false,
      authorized: false,
      bytesRelayed: 0,
      framesRelayed: 0,
      commandsRelayed: 0,
      createdIp: ip,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.status === 'closed' || session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      this.dropDeviceIndex(id);
      return undefined;
    }
    return session;
  }

  update(id: string, patch: Partial<Session>): Session | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    Object.assign(session, patch, { id: session.id });
    return session;
  }

  /** 把已建好的会话标记为无人值守并登记 deviceId → sessionId 索引 */
  registerUnattended(sessionId: string, deviceId: string): void {
    const session = this.update(sessionId, { unattended: true, deviceId });
    if (!session) return;
    this.deviceIndex.set(deviceId, sessionId);
  }

  /** 按 deviceId 查找无人值守会话；索引指向的会话已失效时顺手清理索引 */
  getByDeviceId(deviceId: string): Session | undefined {
    const sessionId = this.deviceIndex.get(deviceId);
    if (!sessionId) return undefined;
    const session = this.get(sessionId);
    if (!session || !session.unattended || session.deviceId !== deviceId) {
      this.deviceIndex.delete(deviceId);
      return undefined;
    }
    return session;
  }

  private dropDeviceIndex(sessionId: string): void {
    for (const [deviceId, id] of this.deviceIndex) {
      if (id === sessionId) this.deviceIndex.delete(deviceId);
    }
  }

  delete(id: string): boolean {
    this.dropDeviceIndex(id);
    return this.sessions.delete(id);
  }

  list(): Session[] {
    return [...this.sessions.values()].filter(
      (s) => s.status !== 'closed' && s.expiresAt > Date.now(),
    );
  }

  /** 返回被清理的会话 id，由上层关闭对应 WebSocket 房间 */
  purgeExpired(): string[] {
    const now = Date.now();
    const removed: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.status === 'closed' || session.expiresAt <= now) {
        this.sessions.delete(id);
        this.dropDeviceIndex(id);
        removed.push(id);
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }

  dispose(): void {
    clearInterval(this.gcTimer);
    this.sessions.clear();
    this.deviceIndex.clear();
  }
}

export function toView(session: Session): SessionView {
  return {
    sessionId: session.id,
    status: session.status,
    host: {
      model: session.hostDevice.model,
      osVersion: session.hostDevice.osVersion,
      screen: session.hostDevice.screen,
    },
    ...(session.controllerDevice
      ? {
          controller: {
            model: session.controllerDevice.model,
            osVersion: session.controllerDevice.osVersion,
          },
        }
      : {}),
    hostOnline: session.hostOnline,
    controllerOnline: session.controllerOnline,
    authorized: session.authorized,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    bytesRelayed: session.bytesRelayed,
    framesRelayed: session.framesRelayed,
    commandsRelayed: session.commandsRelayed,
    ...(session.unattended ? { unattended: true } : {}),
    ...(session.deviceId !== undefined ? { deviceId: session.deviceId } : {}),
  };
}
