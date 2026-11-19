import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config/env';
import { AppError, ValidationError } from '../../shared/errors';
import { asyncHandler, createRateLimiter } from '../../shared/middleware';
import { Role } from '../../shared/protocol';
import type { createAuthGuard } from '../auth/auth.middleware';
import type { DeviceCredentialsRepository } from './device-credentials.repository';

const passwordSchema = z.string().regex(/^\d{6}$/, '密码必须是 6 位数字');
const deviceIdSchema = z.string().trim().min(1).max(128);

/** 重置长期密码：需 host token + 旧密码（防他人劫持已注册设备） */
const changePasswordSchema = z.object({
  deviceId: deviceIdSchema,
  oldPassword: passwordSchema,
  newPassword: passwordSchema,
});

/**
 * 设置/清除临时密码。
 * 需 host token（受控端已建会话）+ 长期密码校验，防止中间人篡改。
 * 明文密码只在请求体里短暂存在，写日志时由 logger 的 SENSITIVE 规则脱敏。
 */
const temporarySchema = z.object({
  deviceId: deviceIdSchema,
  permanentPassword: passwordSchema,
  temporaryPassword: passwordSchema.nullable(),
  /** 绝对时间戳（ms）；0 表示清除临时密码 */
  expiresAt: z.number().int().nonnegative().optional().default(0),
});

function normalizeExpiry(expiresAt: number): number {
  const now = Date.now();
  const max = config.temporaryPasswordMaxMinutes * 60_000;
  if (expiresAt <= 0) return 0;
  if (expiresAt <= now) throw new AppError('INVALID_INPUT', '临时密码有效期已过');
  if (expiresAt > now + max) {
    throw new AppError('INVALID_INPUT', `临时密码有效期最多 ${config.temporaryPasswordMaxMinutes} 分钟`);
  }
  return expiresAt;
}

export function devicesRouter(
  repo: DeviceCredentialsRepository,
  guard: ReturnType<typeof createAuthGuard>,
): Router {
  const router = Router();

  router.post(
    '/password',
    createRateLimiter(10, 60_000),
    guard(Role.Host),
    asyncHandler(async (req, res) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const { deviceId, oldPassword, newPassword } = parsed.data;
      const result = repo.register(deviceId, newPassword, oldPassword);
      if (result === 'rejected') {
        throw new AppError('DEVICE_AUTH_FAILED', '旧密码不正确，拒绝更改设备密码');
      }
      res.status(200).json({ deviceId, status: result });
    }),
  );

  router.post(
    '/temporary',
    createRateLimiter(10, 60_000),
    guard(Role.Host),
    asyncHandler(async (req, res) => {
      const parsed = temporarySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const { deviceId, permanentPassword, temporaryPassword, expiresAt } = parsed.data;
      const normalized = temporaryPassword ? normalizeExpiry(expiresAt) : 0;
      const ok = repo.setTemporary(
        deviceId,
        permanentPassword,
        temporaryPassword,
        normalized,
      );
      if (!ok) throw new AppError('DEVICE_AUTH_FAILED', '长期密码不正确');
      res.status(200).json({
        deviceId,
        enabled: Boolean(temporaryPassword),
        expiresAt: normalized || undefined,
      });
    }),
  );

  return router;
}
