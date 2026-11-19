import { Router, type RequestHandler } from 'express';
import { config } from '../../config/env';
import { PROTOCOL_VERSION } from '../../shared/protocol';

const startedAt = Date.now();

export interface ReadinessProbe {
  (): { ok: boolean; reason?: string };
}

export function healthRouter(readiness: ReadinessProbe): Router {
  const router = Router();

  const live: RequestHandler = (_req, res) => {
    res.status(200).json({
      status: 'ok',
      version: '1.0.0',
      protocol: PROTOCOL_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      env: config.nodeEnv,
    });
  };

  const ready: RequestHandler = (_req, res) => {
    const result = readiness();
    if (!result.ok) {
      res.status(503).json({ status: 'unavailable', reason: result.reason ?? 'not ready' });
      return;
    }
    res.status(200).json({ status: 'ready' });
  };

  router.get('/health', live);
  router.get('/ready', ready);
  return router;
}
