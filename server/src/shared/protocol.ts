/**
 * 协议常量与类型 —— 对应 docs/PROTOCOL.md v1
 * Android 端同步实现：两个安卓工程的 protocol/Protocol.kt
 */

export const PROTOCOL_VERSION = 2;

export const BINARY_MAGIC = 0xa5;
export const BINARY_HEADER_BYTES = 12;

export const FrameType = {
  Config: 1,
  Keyframe: 2,
  Delta: 3,
  JpegPreview: 4,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const Role = {
  Host: 'host',
  Controller: 'controller',
  Observer: 'observer',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const MessageType = {
  Ping: 'ping',
  Pong: 'pong',
  SessionReady: 'session.ready',
  PeerJoined: 'session.peer_joined',
  PeerLeft: 'session.peer_left',
  SessionClosed: 'session.closed',
  SessionError: 'session.error',
  // v2：被协助者必须在会话内明确同意，控制指令才会被转发
  AuthorizeRequest: 'session.authorize_request',
  AuthorizeGrant: 'session.authorize_grant',
  AuthorizeDeny: 'session.authorize_deny',
  AuthorizeState: 'session.authorize_state',
  StreamConfig: 'stream.config',
  StreamStart: 'stream.start',
  StreamStop: 'stream.stop',
  KeyframeRequest: 'stream.keyframe_request',
  DeviceState: 'device.state',
  Tap: 'control.tap',
  LongPress: 'control.long_press',
  Swipe: 'control.swipe',
  Scroll: 'control.scroll',
  Key: 'control.key',
  Text: 'control.text',
  Home: 'control.home',
  Back: 'control.back',
  Recents: 'control.recents',
  Ack: 'control.ack',
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** 只允许 controller → host 的指令类型 */
export const CONTROL_TYPES: ReadonlySet<string> = new Set([
  MessageType.Tap,
  MessageType.LongPress,
  MessageType.Swipe,
  MessageType.Scroll,
  MessageType.Key,
  MessageType.Text,
  MessageType.Home,
  MessageType.Back,
  MessageType.Recents,
  MessageType.KeyframeRequest,
]);

/** 只允许 host → controller 的类型（授权决定由服务端本地消费，不转发） */
export const HOST_TYPES: ReadonlySet<string> = new Set([
  MessageType.StreamConfig,
  MessageType.StreamStart,
  MessageType.StreamStop,
  MessageType.DeviceState,
  MessageType.Ack,
  MessageType.AuthorizeGrant,
  MessageType.AuthorizeDeny,
]);

/** session.error 的应用层错误码（区别于 HTTP 错误码） */
export const SessionErrorCode = {
  NotAuthorized: 'NOT_AUTHORIZED',
  AuthorizationDenied: 'AUTHORIZATION_DENIED',
} as const;

export const WsCloseCode = {
  ProtocolError: 4000,
  SessionClosed: 4001,
  HeartbeatTimeout: 4002,
  AuthFailed: 4003,
  FrameTooLarge: 4009,
} as const;

export const ERROR_CODES = {
  INVALID_INPUT: { http: 400, message: '请求参数不合法' },
  UNAUTHORIZED: { http: 401, message: '身份凭证缺失或无效' },
  FORBIDDEN: { http: 403, message: '当前角色无权执行此操作' },
  NOT_FOUND: { http: 404, message: '接口不存在' },
  SESSION_NOT_FOUND: { http: 404, message: '会话不存在或已结束' },
  SESSION_FULL: { http: 409, message: '会话已达控制端上限' },
  SESSION_CLOSED: { http: 410, message: '会话已关闭' },
  // 设备号 + 6 位数字密码：401 同时覆盖「设备不存在」与「密码错误」，响应完全一致以防枚举；
  // 404 表示凭据正确但当前没有可认领的在线会话。两者共用文案，避免泄露设备状态。
  DEVICE_AUTH_FAILED: { http: 401, message: '设备号或密码错误' },
  DEVICE_NOT_ONLINE: { http: 404, message: '设备号或密码错误，或设备当前不在线' },
  DEVICE_LOCKED: { http: 429, message: '密码错误次数过多，设备已临时锁定' },
  RATE_LIMITED: { http: 429, message: '请求过于频繁，请稍后重试' },
  INTERNAL: { http: 500, message: '服务内部错误' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface Envelope<T = Record<string, unknown>> {
  v: number;
  type: string;
  ts: number;
  seq: number;
  payload: T;
}

export interface ScreenInfo {
  width: number;
  height: number;
  density: number;
  rotation: number;
}

export interface DeviceInfo {
  model: string;
  osVersion: string;
  appVersion: string;
  screen: ScreenInfo;
}

export interface JwtClaims {
  sub: string;
  sid: string;
  role: Role;
  jti: string;
  iat: number;
  exp: number;
}

/** 校验二进制帧头，返回 frameType 与 timestampMs；不合法返回 null */
export function parseBinaryHeader(buf: Buffer): { frameType: number; timestampMs: number } | null {
  if (buf.length < BINARY_HEADER_BYTES) return null;
  if (buf[0] !== BINARY_MAGIC || buf[1] !== PROTOCOL_VERSION) return null;
  const frameType = buf[2];
  if (frameType < 1 || frameType > 4) return null;
  const timestampMs = Number(buf.readBigUInt64BE(4));
  return { frameType, timestampMs };
}
