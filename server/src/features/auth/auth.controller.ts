import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../shared/errors';
import { asyncHandler } from '../../shared/middleware';
import { Role } from '../../shared/protocol';
import type { AuthService } from './auth.service';

const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(512),
});

export function authRouter(auth: AuthService): Router {
  const router = Router();

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const parsed = refreshSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const result = auth.refresh(parsed.data.refreshToken);
      res.status(200).json({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessTokenExpiresIn: result.accessTokenExpiresIn,
        sessionId: result.sessionId,
      });
    }),
  );

  router.post(
    '/observer',
    asyncHandler(async (req, res) => {
      auth.verifyAdminKey(req.header('x-admin-key'));
      const pair = auth.issueTokenPair('ops-console', 'ops', Role.Observer);
      res.status(200).json({
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        accessTokenExpiresIn: pair.accessTokenExpiresIn,
        role: Role.Observer,
      });
    }),
  );

  return router;
}
