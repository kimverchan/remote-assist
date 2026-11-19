import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config/env';
import { AppError, normalizeErrorBody } from './errors';
import { logger, withContext } from './logger';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = (incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID());
  res.setHeader('X-Request-Id', requestId);
  withContext({ requestId }, () => next());
}

export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('http_request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });
    next();
  };
}

/** Express 4 不会自动捕获 async handler 的 rejection */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: '接口不存在', requestId: res.getHeader('X-Request-Id') },
  });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const requestId = res.getHeader('X-Request-Id') as string | undefined;
  if (err instanceof SyntaxError && 'body' in err) {
    err = new AppError('INVALID_INPUT', '请求体不是合法 JSON');
  }
  const { status, body } = normalizeErrorBody(err, requestId);
  if (status >= 500) {
    logger.error('unhandled_error', { err: err instanceof Error ? err : String(err) });
  } else {
    logger.warn('request_rejected', { code: body.error.code, status });
  }
  if (res.headersSent) return;
  res.status(status).json(body);
};

interface RateBucket { count: number; resetAt: number }
const buckets = new Map<string, RateBucket>();
let limiterScope = 0;

/**
 * 单进程固定窗口限流；多实例部署时需在网关层再做一次。
 * keyFn 可完全自定义限流键（用于按配对码计数，不受 X-Forwarded-For 伪造影响）。
 * 未启用 trust proxy 时限流键一律使用真实 TCP 对端地址，杜绝请求头伪造绕过。
 */
export function createRateLimiter(
  maxRequests?: number,
  windowMs?: number,
  keyFn?: (req: Request) => string,
): RequestHandler {
  const max = maxRequests ?? config.rateLimitMax;
  const window = windowMs ?? config.rateLimitWindowMs;
  // 每个限流器实例独立计数：避免「路由通用限流」与「claim 专用限流」误共享同一个桶
  const scope = `limiter-${++limiterScope}`;
  return (req, res, next) => {
    const socketIp = req.socket.remoteAddress ?? 'unknown';
    const ip = config.trustProxy ? (req.ip ?? socketIp) : socketIp;
    const suffix = keyFn ? keyFn(req) : `${ip}:${req.method}:${req.path}`;
    const key = `${scope}:${suffix}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + window };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      next(new AppError('RATE_LIMITED'));
      return;
    }
    next();
  };
}

export function clearRateBuckets(): void {
  buckets.clear();
}

export function startBucketGc(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, config.rateLimitWindowMs);
  timer.unref();
  return timer;
}
