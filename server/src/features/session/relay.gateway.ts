import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { config } from '../../config/env';
import { logger, withContext } from '../../shared/logger';
import {
  CONTROL_TYPES,
  HOST_TYPES,
  MessageType,
  PROTOCOL_VERSION,
  Role,
  SessionErrorCode,
  WsCloseCode,
  parseBinaryHeader,
  type Envelope,
  type JwtClaims,
} from '../../shared/protocol';
import type { AuthService } from '../auth/auth.service';
import type { SessionService } from './session.service';

type PeerRole = typeof Role.Host | typeof Role.Controller;

interface Client {
  ws: WebSocket;
  sessionId: string;
  role: PeerRole;
  deviceId: string;
  lastPong: number;
  windowStart: number;
  windowFrames: number;
}

interface Room {
  host?: Client;
  controller?: Client;
}

/**
 * WebSocket 传输适配器：只负责鉴权、房间、心跳与转发。
 * 业务状态一律交给 SessionService，本类不读取仓储。
 */
export class RelayGateway {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly heartbeat: NodeJS.Timeout;
  private serverSeq = 0;
  private shuttingDown = false;

  constructor(
    private readonly server: HttpServer,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes });
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.tick(), config.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private reject(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      this.reject(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/ws') {
      this.reject(socket, 404, 'Not Found');
      return;
    }
    // 规范：令牌禁止出现在 URL 查询参数中
    if (url.searchParams.has('token') || url.searchParams.has('access_token')) {
      this.reject(socket, 400, 'Token In Query Is Forbidden');
      return;
    }

    let claims: JwtClaims;
    try {
      claims = this.auth.verifyAccessToken(req.headers.authorization);
      if (claims.role !== Role.Host && claims.role !== Role.Controller) {
        throw new Error('observer cannot open relay socket');
      }
      this.sessions.assertActive(claims.sid);
      const existing = this.rooms.get(claims.sid);
      if (existing?.[claims.role]) throw new Error('role slot occupied');
    } catch (err) {
      logger.warn('ws_upgrade_rejected', { err: err instanceof Error ? err.message : String(err) });
      this.reject(socket, 401, 'Unauthorized');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, claims));
  }

  private onConnection(ws: WebSocket, claims: JwtClaims): void {
    const role = claims.role as PeerRole;
    const sessionId = claims.sid;
    const client: Client = {
      ws,
      sessionId,
      role,
      deviceId: claims.sub,
      lastPong: Date.now(),
      windowStart: Date.now(),
      windowFrames: 0,
    };

    const room = this.rooms.get(sessionId) ?? {};
    room[role] = client;
    this.rooms.set(sessionId, room);
    this.clearGrace(sessionId);
    this.sessions.setPeerOnline(sessionId, role, true);

    withContext({ sessionId, role }, () => {
      const peer = this.peerOf(client);
      this.send(ws, MessageType.SessionReady, {
        sessionId,
        role,
        peerOnline: Boolean(peer),
      });
      if (peer) {
        this.send(peer.ws, MessageType.PeerJoined, { role, deviceId: client.deviceId });
      }
      logger.info('ws_connected', { peerOnline: Boolean(peer) });

      // v2 会话级授权：控制端入房不等于获得控制权，必须由受控端在会话内明确同意。
      // 授权绑定控制器 deviceId，换设备重连一律重新确认。
      if (role === Role.Controller) {
        if (this.sessions.isAuthorized(sessionId, client.deviceId)) {
          this.send(ws, MessageType.AuthorizeState, { authorized: true });
        } else {
          this.sessions.revokeAuthorization(sessionId);
          this.requestAuthorization(room, room.host?.ws);
        }
      } else if (room.controller) {
        // 受控端断线重连：已授权则恢复推流，未授权则重新发起确认
        if (this.sessions.isAuthorized(sessionId, room.controller.deviceId)) {
          this.send(ws, MessageType.AuthorizeState, { authorized: true });
        } else {
          this.requestAuthorization(room, ws);
        }
      }

      ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
      ws.on('pong', () => {
        client.lastPong = Date.now();
      });
      ws.on('close', (code, reason) => {
        withContext({ sessionId, role }, () => {
          logger.info('ws_disconnected', { code, reason: reason.toString() });
          this.onClose(client);
        });
      });
      ws.on('error', (err) => logger.warn('ws_error', { message: err.message }));
    });
  }

  /** 请受控端确认本次协助，并同步告知控制端当前尚未获授权 */
  private requestAuthorization(room: Room, hostWs?: WebSocket): void {
    const controller = room.controller;
    if (!controller) return;
    const info = this.sessions.controllerInfo(controller.sessionId);
    if (hostWs) {
      this.send(hostWs, MessageType.AuthorizeRequest, {
        sessionId: controller.sessionId,
        controller: info ?? { model: '协助设备', osVersion: '未知' },
      });
    }
    this.send(controller.ws, MessageType.AuthorizeState, {
      authorized: false,
      reason: '等待对方确认协助请求',
    });
  }

  /** 授权决定只在服务端本地消费，绝不转发给对端 */
  private handleAuthorization(client: Client, envelope: Envelope): void {
    if (envelope.type === MessageType.AuthorizeDeny) {
      const reason =
        typeof envelope.payload.reason === 'string'
          ? envelope.payload.reason
          : '受控端拒绝了本次协助';
      this.sessions.close(client.sessionId, reason);
      return;
    }
    const room = this.rooms.get(client.sessionId);
    const controller = room?.controller;
    this.sessions.grant(client.sessionId, controller?.deviceId ?? client.deviceId);
    this.send(client.ws, MessageType.AuthorizeState, { authorized: true });
    if (controller) {
      this.send(controller.ws, MessageType.AuthorizeState, { authorized: true });
    }
  }

  private peerOf(client: Client): Client | undefined {
    const room = this.rooms.get(client.sessionId);
    if (!room) return undefined;
    return client.role === Role.Host ? room.controller : room.host;
  }

  private send(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
    if (this.shuttingDown || ws.readyState !== WebSocket.OPEN) return;
    const envelope: Envelope = { v: 1, type, ts: Date.now(), seq: ++this.serverSeq, payload };
    try {
      ws.send(JSON.stringify(envelope));
    } catch (err) {
      logger.warn('ws_send_failed', { type, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private forward(target: Client | undefined, data: Buffer | string, isBinary: boolean): void {
    if (!target || target.ws.readyState !== WebSocket.OPEN) return;
    try {
      target.ws.send(data, { binary: isBinary });
    } catch (err) {
      logger.warn('ws_forward_failed', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
  }

  /** 视频帧按每秒窗口限流；控制指令永不丢弃，只记录超频告警 */
  private checkFrameRate(client: Client, isBinary: boolean): boolean {
    if (!isBinary) return true;
    const now = Date.now();
    if (now - client.windowStart >= 1000) {
      client.windowStart = now;
      client.windowFrames = 0;
    }
    client.windowFrames += 1;
    if (client.windowFrames > config.maxFramesPerSecond) {
      logger.warn('frame_rate_exceeded', { frames: client.windowFrames });
      return false;
    }
    return true;
  }

  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (!this.checkFrameRate(client, isBinary)) return;
    const room = this.rooms.get(client.sessionId);
    if (!room) return;

    if (isBinary) {
      if (client.role !== Role.Host) {
        client.ws.close(WsCloseCode.ProtocolError, 'controller cannot send video');
        return;
      }
      const buf = this.toBuffer(data);
      if (buf.length > config.maxFrameBytes) {
        client.ws.close(WsCloseCode.FrameTooLarge, 'frame too large');
        return;
      }
      if (!parseBinaryHeader(buf)) {
        client.ws.close(WsCloseCode.ProtocolError, 'invalid binary header');
        return;
      }
      this.sessions.recordTraffic(client.sessionId, buf.length, false);
      this.forward(room.controller, buf, true);
      return;
    }

    const raw = typeof data === 'string' ? data : this.toBuffer(data).toString('utf8');
    if (Buffer.byteLength(raw) > config.maxTextBytes) {
      client.ws.close(WsCloseCode.FrameTooLarge, 'text frame too large');
      return;
    }

    let envelope: Envelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not object');
      envelope = parsed as Envelope;
      if (
        envelope.v !== PROTOCOL_VERSION ||
        typeof envelope.type !== 'string' ||
        typeof envelope.seq !== 'number' ||
        !Number.isFinite(envelope.seq)
      ) {
        throw new Error('invalid envelope');
      }
    } catch {
      client.ws.close(WsCloseCode.ProtocolError, 'invalid text frame');
      return;
    }

    if (envelope.type === MessageType.Ping) {
      this.send(client.ws, MessageType.Pong, {});
      return;
    }
    if (envelope.type === MessageType.Pong) {
      client.lastPong = Date.now();
      return;
    }

    const allowed = client.role === Role.Host ? HOST_TYPES : CONTROL_TYPES;
    if (!allowed.has(envelope.type)) {
      client.ws.close(WsCloseCode.ProtocolError, 'message type not allowed for role');
      return;
    }

    // 受控端的授权决定由服务端消费，不进入转发通道
    if (
      client.role === Role.Host &&
      (envelope.type === MessageType.AuthorizeGrant ||
        envelope.type === MessageType.AuthorizeDeny)
    ) {
      this.handleAuthorization(client, envelope);
      return;
    }

    // 硬门禁：未获受控端明确授权前，任何控制指令都不得下发。
    // 即使 JWT 有效、配对码正确，也必须等被协助者在会话内点「允许」。
    if (
      client.role === Role.Controller &&
      CONTROL_TYPES.has(envelope.type) &&
      !this.sessions.isAuthorized(client.sessionId, client.deviceId)
    ) {
      this.send(client.ws, MessageType.SessionError, {
        code: SessionErrorCode.NotAuthorized,
        message: '对方尚未确认本次协助，操作未下发',
      });
      logger.warn('control_blocked_unauthorized', {
        sessionId: client.sessionId,
        type: envelope.type,
      });
      return;
    }

    this.sessions.recordTraffic(client.sessionId, Buffer.byteLength(raw), true);
    const target = client.role === Role.Host ? room.controller : room.host;
    this.forward(target, raw, false);
  }

  private tick(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const client of [room.host, room.controller]) {
        if (!client) continue;
        if (now - client.lastPong > config.heartbeatTimeoutMs) {
          logger.warn('heartbeat_timeout', { sessionId: client.sessionId, role: client.role });
          client.ws.terminate();
          continue;
        }
        if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
      }
    }
  }

  private onClose(client: Client): void {
    const room = this.rooms.get(client.sessionId);
    if (!room || room[client.role] !== client) return;
    delete room[client.role];
    this.sessions.setPeerOnline(client.sessionId, client.role, false);

    const peer = this.peerOf(client);
    if (client.role === Role.Host) {
      // 受控端一断，会话立即结束，不保留任何可重连的控制能力
      this.sessions.close(client.sessionId, '受控端已断开');
      return;
    }

    if (peer) {
      this.send(peer.ws, MessageType.PeerLeft, {
        role: client.role,
        graceMs: config.reconnectGraceMs,
      });
    }
    this.scheduleGrace(client.sessionId);
  }

  private scheduleGrace(sessionId: string): void {
    this.clearGrace(sessionId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(sessionId);
      const room = this.rooms.get(sessionId);
      if (room && !room.controller) {
        this.sessions.close(sessionId, '控制端重连超时');
      }
    }, config.reconnectGraceMs);
    timer.unref();
    this.graceTimers.set(sessionId, timer);
  }

  private clearGrace(sessionId: string): void {
    const timer = this.graceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(sessionId);
    }
  }

  /** 纯传输层：关闭房间内所有连接，不修改业务状态（避免与 close 回调递归） */
  closeRoom(sessionId: string, code: number, reason: string): void {
    const room = this.rooms.get(sessionId);
    this.rooms.delete(sessionId);
    this.clearGrace(sessionId);
    if (!room) return;
    for (const client of [room.host, room.controller]) {
      if (!client) continue;
      const ws = client.ws;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        this.send(ws, MessageType.SessionClosed, { code, reason });
        try {
          ws.close(code, reason);
        } catch {
          ws.terminate();
        }
      }
    }
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.heartbeat);
    for (const sessionId of [...this.rooms.keys()]) {
      this.closeRoom(sessionId, 1001, '服务器停机');
    }
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.wss.close();
  }
}
