import { randomBytes } from 'node:crypto';
import { config } from '../../config/env';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { Role, type DeviceInfo } from '../../shared/protocol';
import type { AuthService, TokenPair } from '../auth/auth.service';
import type { DeviceCredentialsRepository } from '../device/device-credentials.repository';
import { SessionRepository, toView, type SessionView } from './session.repository';

/** 建会话时携带的设备凭据：deviceId + 6 位数字密码，首次自动注册 */
export interface DeviceAuth {
  deviceId: string;
  password: string;
  /** 改密码时提供旧密码，防他人劫持已注册设备 */
  oldPassword?: string;
}

export interface CreateSessionResult extends TokenPair {
  sessionId: string;
  expiresAt: number;
  expiresIn: number;
  role: Role;
}

export interface ClaimSessionResult extends TokenPair {
  sessionId: string;
  host: { model: string; osVersion: string; screen: DeviceInfo['screen'] };
  role: Role;
}

export interface Overview {
  totalSessions: number;
  waitingSessions: number;
  activeSessions: number;
  onlineHosts: number;
  onlineControllers: number;
  authorizedSessions: number;
  registeredDevices: number;
  refreshTokens: number;
  bytesRelayed: number;
  framesRelayed: number;
  commandsRelayed: number;
  maxSessions: number;
}

/** 会话编排：设备凭据 + 令牌签发 + 在线状态，供 REST 控制器与 WS 网关共同调用 */
export class SessionService {
  private closeHandler?: (id: string, reason: string) => void;

  constructor(
    private readonly sessions: SessionRepository,
    private readonly devices: DeviceCredentialsRepository,
    private readonly auth: AuthService,
  ) {}

  /** 传输层注册关闭钩子，使业务层保持对 ws 无依赖 */
  setCloseHandler(handler: (id: string, reason: string) => void): void {
    this.closeHandler = handler;
  }

  /**
   * 受控端建会话。必须携带设备凭据（deviceId + 6 位密码）。
   * - 首次：自动注册凭据；
   * - 已有设备：校验密码，错误时返回 401，绝不静默放行；
   * - 提供 oldPassword 且正确时可更新长期密码。
   */
  create(device: DeviceInfo, ip: string, authCredentials: DeviceAuth): CreateSessionResult {
    const { deviceId, password, oldPassword } = authCredentials;

    if (this.devices.isLocked(deviceId)) {
      throw new AppError('DEVICE_LOCKED', '密码错误次数过多，请稍后再试');
    }

    const registered = this.devices.has(deviceId);
    const registerResult = this.devices.register(deviceId, password, oldPassword);
    if (registerResult === 'rejected') {
      const locked = this.devices.recordFailure(deviceId);
      throw locked
        ? new AppError('DEVICE_LOCKED', '密码错误次数过多，请稍后再试')
        : new AppError('DEVICE_AUTH_FAILED');
    }
    if (!registered || registerResult === 'updated') {
      this.devices.clearFailures(deviceId);
    }

    // 同一 deviceId 已有会话：先关闭旧会话再建新的，便于受控端自动恢复
    const previous = this.sessions.getByDeviceId(deviceId);
    if (previous) this.close(previous.id, '同一设备重新建立会话');

    if (this.sessions.size >= config.maxSessions) {
      throw new AppError('SESSION_FULL', '服务器会话数已达上限，请稍后重试');
    }
    const session = this.sessions.create(device, ip);
    this.sessions.registerUnattended(session.id, deviceId);
    const tokens = this.auth.issueTokenPair(session.hostId, session.id, Role.Host);
    logger.info('session_created', {
      sessionId: session.id,
      role: Role.Host,
      deviceId,
      action: registerResult,
    });
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      expiresIn: config.sessionTtl,
      role: Role.Host,
      ...tokens,
    };
  }

  /**
   * 控制端直连认领：deviceId + 6 位密码。
   * 失败统一为「设备凭据无效或设备不在线」，不区分设备不存在与密码错误。
   * 仅 waiting 会话、或 active 且控制端已离线（重连）可认领。
   */
  claimDevice(
    deviceId: string,
    password: string,
    device: DeviceInfo,
    ip: string,
  ): ClaimSessionResult {
    if (this.devices.isLocked(deviceId)) {
      throw new AppError('DEVICE_LOCKED', '密码错误次数过多，请 15 分钟后重试');
    }

    const result = this.devices.verify(deviceId, password);
    if (!result.ok) {
      const locked = this.devices.recordFailure(deviceId);
      throw locked
        ? new AppError('DEVICE_LOCKED', '密码错误次数过多，请稍后再试')
        : new AppError('DEVICE_AUTH_FAILED');
    }

    const session = this.sessions.getByDeviceId(deviceId);
    if (
      !session ||
      !(
        session.status === 'waiting' ||
        (session.status === 'active' && session.controllerOnline === false)
      )
    ) {
      throw new AppError('DEVICE_NOT_ONLINE');
    }

    this.devices.clearFailures(deviceId);
    const controllerId = `c_${randomBytes(6).toString('hex')}`;
    this.sessions.update(session.id, {
      controllerId,
      controllerDevice: device,
      status: 'active',
    });
    const tokens = this.auth.issueTokenPair(controllerId, session.id, Role.Controller);
    logger.info('session_claimed', {
      sessionId: session.id,
      role: Role.Controller,
      ip,
      deviceId,
      viaTemporary: result.viaTemporary,
    });
    return {
      sessionId: session.id,
      host: {
        model: session.hostDevice.model,
        osVersion: session.hostDevice.osVersion,
        screen: session.hostDevice.screen,
      },
      role: Role.Controller,
      ...tokens,
    };
  }

  getById(id: string): SessionView {
    const session = this.sessions.get(id);
    if (!session) throw new AppError('SESSION_NOT_FOUND');
    return toView(session);
  }

  /** WebSocket 握手时调用，确保会话仍有效 */
  assertActive(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new AppError('SESSION_CLOSED');
  }

  setPeerOnline(id: string, role: Role, online: boolean): void {
    if (role === Role.Host) this.sessions.update(id, { hostOnline: online });
    else if (role === Role.Controller) this.sessions.update(id, { controllerOnline: online });
  }

  recordTraffic(id: string, bytes: number, isCommand: boolean): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.bytesRelayed += bytes;
    if (isCommand) session.commandsRelayed += 1;
    else session.framesRelayed += 1;
  }

  close(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.update(id, { status: 'closed', hostOnline: false, controllerOnline: false });
    this.auth.revokeSession(id);
    this.sessions.delete(id);
    logger.info('session_closed', { sessionId: id, reason });
    this.closeHandler?.(id, reason);
  }

  /** v2：查询本会话是否已由被协助者授权给指定控制端 */
  isAuthorized(id: string, controllerId?: string): boolean {
    const session = this.sessions.get(id);
    return Boolean(
      session?.authorized && (!controllerId || session.authorizedFor === controllerId),
    );
  }

  /** 授权只在本会话内有效，且绑定到当前控制端；换设备重连必须重新确认 */
  grant(id: string, controllerId: string): void {
    this.sessions.update(id, { authorized: true, authorizedFor: controllerId });
    logger.info('session_authorized', { sessionId: id });
  }

  revokeAuthorization(id: string): void {
    this.sessions.update(id, { authorized: false, authorizedFor: undefined });
  }

  controllerInfo(id: string): { model: string; osVersion: string } | undefined {
    const device = this.sessions.get(id)?.controllerDevice;
    return device ? { model: device.model, osVersion: device.osVersion } : undefined;
  }

  listViews(): SessionView[] {
    return this.sessions.list().map(toView);
  }

  overview(): Overview {
    const list = this.sessions.list();
    return {
      totalSessions: list.length,
      waitingSessions: list.filter((s) => s.status === 'waiting').length,
      activeSessions: list.filter((s) => s.status === 'active').length,
      onlineHosts: list.filter((s) => s.hostOnline).length,
      onlineControllers: list.filter((s) => s.controllerOnline).length,
      authorizedSessions: list.filter((s) => s.authorized).length,
      registeredDevices: this.devices.size,
      refreshTokens: this.auth.refreshTokenCount,
      bytesRelayed: list.reduce((sum, s) => sum + s.bytesRelayed, 0),
      framesRelayed: list.reduce((sum, s) => sum + s.framesRelayed, 0),
      commandsRelayed: list.reduce((sum, s) => sum + s.commandsRelayed, 0),
      maxSessions: config.maxSessions,
    };
  }

  purgeExpired(): string[] {
    return this.sessions.purgeExpired();
  }

  get size(): number {
    return this.sessions.size;
  }

  dispose(): void {
    this.sessions.dispose();
    this.auth.dispose();
  }
}
