import { Router } from 'express';
import { z } from 'zod';
import { AppError, ValidationError } from '../../shared/errors';
import { asyncHandler, createRateLimiter } from '../../shared/middleware';
import { Role, type DeviceInfo, type JwtClaims } from '../../shared/protocol';
import type { createAuthGuard } from '../auth/auth.middleware';
import type { SessionService } from './session.service';

const screenSchema = z.object({
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
  density: z.number().min(0.1).max(10),
  rotation: z.number().int().min(0).max(3),
});

const deviceSchema = z.object({
  model: z.string().trim().min(1).max(120),
  osVersion: z.string().trim().min(1).max(80),
  appVersion: z.string().trim().min(1).max(40),
  screen: screenSchema,
});

/** 6 位纯数字密码 */
const passwordSchema = z.string().regex(/^\d{6}$/, '密码必须是 6 位数字');

/** 受控端建会话：必须携带设备凭据，首次自动注册 */
const deviceAuthSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  password: passwordSchema,
  oldPassword: passwordSchema.optional(),
});

const createSchema = z.object({
  role: z.literal('host'),
  device: deviceSchema,
  deviceAuth: deviceAuthSchema,
});

const claimDeviceSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  password: passwordSchema,
  device: deviceSchema,
});

function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function sessionsRouter(
  service: SessionService,
  guard: ReturnType<typeof createAuthGuard>,
): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const result = service.create(
        parsed.data.device as DeviceInfo,
        clientIp(req),
        parsed.data.deviceAuth,
      );
      res.status(201).json(result);
    }),
  );

  // 设备直连认领：6 位数字密码可被枚举，两道专用限流叠加在 /sessions 通用限流之上：
  // 1) 按真实来源 IP 每分钟 8 次（未启用 trust proxy 时不可被 XFF 伪造）
  // 2) 按 deviceId 每分钟 10 次，跨 IP 生效；再加上 SessionService 内的失败锁定，
  //    构成针对单个设备密码爆破的三层防护。
  router.post(
    '/claim-device',
    createRateLimiter(8, 60_000),
    createRateLimiter(10, 60_000, (req) => {
      const raw = req.body?.deviceId;
      const id = typeof raw === 'string' ? raw.trim().slice(0, 128) : '';
      return id ? `device:${id}` : `ip:${req.socket.remoteAddress ?? 'unknown'}:invalid`;
    }),
    asyncHandler(async (req, res) => {
      const parsed = claimDeviceSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const result = service.claimDevice(
        parsed.data.deviceId,
        parsed.data.password,
        parsed.data.device as DeviceInfo,
        clientIp(req),
      );
      res.status(200).json(result);
    }),
  );

  router.get(
    '/:id',
    guard(Role.Host, Role.Controller, Role.Observer),
    asyncHandler(async (req, res) => {
      const claims = res.locals.claims as JwtClaims;
      if (claims.role !== Role.Observer && claims.sid !== req.params.id) {
        throw new AppError('FORBIDDEN', '只能查询自己所属的会话');
      }
      res.status(200).json(service.getById(req.params.id));
    }),
  );

  router.delete(
    '/:id',
    guard(Role.Host, Role.Controller),
    asyncHandler(async (req, res) => {
      const claims = res.locals.claims as JwtClaims;
      if (claims.sid !== req.params.id) throw new AppError('FORBIDDEN');
      service.close(req.params.id, '由客户端主动结束');
      res.status(200).json({ sessionId: req.params.id, status: 'closed' });
    }),
  );

  return router;
}

export function adminRouter(
  service: SessionService,
  guard: ReturnType<typeof createAuthGuard>,
): Router {
  const router = Router();

  router.get(
    '/overview',
    guard(Role.Observer),
    asyncHandler(async (_req, res) => {
      res.status(200).json({ overview: service.overview(), sessions: service.listViews() });
    }),
  );

  return router;
}
