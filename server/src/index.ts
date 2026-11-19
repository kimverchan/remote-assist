import http from 'node:http';
import express from 'express';
import { buildApp } from './app';
import { config } from './config/env';
import { logger } from './shared/logger';
import { PROTOCOL_VERSION } from './shared/protocol';

const app = express();
const server = http.createServer(app);
const ctx = buildApp(app, server);

server.on('error', (err) => {
  logger.error('server_error', { message: err.message });
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  logger.info('server_started', {
    port: config.port,
    host: config.host,
    env: config.nodeEnv,
    protocol: PROTOCOL_VERSION,
    corsOrigins: config.corsOrigins.join(','),
  });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  const force = setTimeout(() => {
    logger.warn('shutdown_timeout', { timeoutMs: 8000 });
    process.exit(1);
  }, 8000);
  force.unref();

  // 1. 停止接受新连接  2. 关闭 WS 房间  3. 释放仓储定时器  4. 退出
  server.close(() => {
    clearTimeout(force);
    logger.info('shutdown_complete');
    process.exit(0);
  });
  ctx.gateway.shutdown();
  server.closeAllConnections?.();
  ctx.dispose();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});
