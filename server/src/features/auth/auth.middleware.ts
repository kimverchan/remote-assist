import type { RequestHandler } from 'express';
import { AppError } from '../../shared/errors';
import type { Role } from '../../shared/protocol';
import type { AuthService } from './auth.service';

export function createAuthGuard(auth: AuthService) {
  return (...allowed: Role[]): RequestHandler => (req, res, next) => {
    try {
      const claims = auth.verifyAccessToken(req.header('authorization'));
      if (allowed.length > 0 && !allowed.includes(claims.role)) {
        throw new AppError('FORBIDDEN');
      }
      res.locals.claims = claims;
      next();
    } catch (err) {
      next(err);
    }
  };
}
