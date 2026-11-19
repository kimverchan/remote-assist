import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import type { JwtClaims, Role } from '../../shared/protocol';
import { TokenRepository, safeKeyEqual } from './token.repository';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

export class AuthService {
  constructor(private readonly tokens: TokenRepository) {}

  issueTokenPair(subject: string, sessionId: string, role: Role): TokenPair {
    const jti = randomUUID();
    const accessToken = jwt.sign({ sub: subject, sid: sessionId, role, jti }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: config.accessTtl,
    });
    const refreshToken = this.tokens.save({
      jti,
      subject,
      sessionId,
      role,
      expiresAt: Date.now() + config.refreshTtl * 1000,
    });
    return { accessToken, refreshToken, accessTokenExpiresIn: config.accessTtl };
  }

  verifyAccessToken(header?: string): JwtClaims {
    if (!header) throw new AppError('UNAUTHORIZED');
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
    if (!raw) throw new AppError('UNAUTHORIZED');
    try {
      const claims = jwt.verify(raw, config.jwtSecret, { algorithms: ['HS256'] }) as JwtClaims;
      if (!claims.sid || !claims.role || !claims.jti || !claims.sub) {
        throw new Error('incomplete claims');
      }
      return claims;
    } catch {
      throw new AppError('UNAUTHORIZED', '访问令牌无效或已过期');
    }
  }

  refresh(refreshToken: string): TokenPair & { sessionId: string; role: Role } {
    const record = this.tokens.consume(refreshToken);
    if (!record) throw new AppError('UNAUTHORIZED', '刷新令牌无效或已过期');
    const pair = this.issueTokenPair(record.subject, record.sessionId, record.role);
    logger.info('token_refreshed', { sessionId: record.sessionId, role: record.role });
    return { ...pair, sessionId: record.sessionId, role: record.role };
  }

  verifyAdminKey(provided?: string): void {
    if (!provided || !safeKeyEqual(provided, config.adminApiKey, config.jwtSecret)) {
      throw new AppError('UNAUTHORIZED', '运维密钥无效');
    }
  }

  revokeSession(sessionId: string): void {
    this.tokens.revokeBySession(sessionId);
  }

  get refreshTokenCount(): number {
    return this.tokens.size;
  }

  dispose(): void {
    this.tokens.dispose();
  }
}
