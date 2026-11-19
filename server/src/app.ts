import type { Server as HttpServer } from 'node:http';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { config, dataDir } from './config/env';
import { authRouter } from './features/auth/auth.controller';
import { AuthService } from './features/auth/auth.service';
import { createAuthGuard } from './features/auth/auth.middleware';
import { TokenRepository } from './features/auth/token.repository';
import { devicesRouter } from './features/device/device.controller';
import { DeviceCredentialsRepository } from './features/device/device-credentials.repository';
import { healthRouter } from './features/health/health.controller';
import { adminRouter, sessionsRouter } from './features/session/session.controller';
import { RelayGateway } from './features/session/relay.gateway';
import { SessionRepository } from './features/session/session.repository';
import { SessionService } from './features/session/session.service';
import {
  clearRateBuckets,
  createRateLimiter,
  errorHandler,
  notFoundHandler,
  requestIdMiddleware,
  requestLogger,
  startBucketGc,
} from './shared/middleware';
import { WsCloseCode } from './shared/protocol';

export interface AppContext {
  sessionService: SessionService;
  gateway: RelayGateway;
  dispose: () => void;
}

/** composition root：在这里组装依赖并规定中间件顺序 */
export function buildApp(app: Express, server: HttpServer): AppContext {
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Admin-Key'],
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(requestIdMiddleware);
  app.use(requestLogger());

  // 依赖注入：仓储 → 服务 → 网关 / 控制器
  const sessionRepo = new SessionRepository();
  const tokenRepo = new TokenRepository();
  // 凭据摘要用 JWT_SECRET 作为 pepper，泄露 JSON 也无法离线爆破 6 位密码
  const deviceRepo = new DeviceCredentialsRepository(
    dataDir,
    config.jwtSecret,
    config.deviceLockThreshold,
    config.deviceLockDurationMs,
  );
  const authService = new AuthService(tokenRepo);
  const sessionService = new SessionService(sessionRepo, deviceRepo, authService);
  const guard = createAuthGuard(authService);
  const gateway = new RelayGateway(server, sessionService, authService);

  // 业务层关闭会话时，通知传输层关闭房间（业务层不依赖 ws）
  sessionService.setCloseHandler((id, reason) =>
    gateway.closeRoom(id, WsCloseCode.SessionClosed, reason),
  );

  app.use(
    healthRouter(() => ({
      ok: sessionRepo.size < config.maxSessions,
      reason: '会话数已达上限',
    })),
  );
  app.use('/api/v1/auth', createRateLimiter(), authRouter(authService));
  app.use('/api/v1/sessions', createRateLimiter(), sessionsRouter(sessionService, guard));
  app.use('/api/v1/devices', createRateLimiter(), devicesRouter(deviceRepo, guard));
  app.use('/api/v1/admin', createRateLimiter(), adminRouter(sessionService, guard));
  app.use(notFoundHandler);
  app.use(errorHandler);

  const purgeTimer = setInterval(() => {
    for (const id of sessionService.purgeExpired()) {
      gateway.closeRoom(id, WsCloseCode.SessionClosed, '会话已过期');
    }
  }, 5000);
  purgeTimer.unref();

  const bucketGc = startBucketGc();

  return {
    sessionService,
    gateway,
    dispose: () => {
      clearInterval(purgeTimer);
      clearInterval(bucketGc);
      clearRateBuckets();
      gateway.shutdown();
      sessionService.dispose();
    },
  };
}
