import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// 只加载进程工作目录下的 .env；真实密钥永不进入代码库
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const boolFromString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const intFromString = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 部署沙箱只暴露一个公网端口且默认探测 3000；未注入 PORT 时必须与之对齐，
  // 否则服务会跑到 8080 而被判定为启动失败。本地开发由 .env 覆盖为 8080。
  PORT: intFromString(1, 65535, 3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET 必须至少 32 字符'),
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY 必须至少 16 字符'),

  JWT_ACCESS_TTL: intFromString(60, 3600, 900),
  REFRESH_TTL: intFromString(3600, 604800, 86400),
  SESSION_TTL: intFromString(300, 86400, 3600),
  MAX_SESSIONS: intFromString(1, 10000, 200),

  HEARTBEAT_INTERVAL_MS: intFromString(3000, 120000, 15000),
  HEARTBEAT_TIMEOUT_MS: intFromString(5000, 180000, 30000),
  PEER_RECONNECT_GRACE_MS: intFromString(0, 300000, 30000),

  MAX_FRAME_BYTES: intFromString(1024, 8 * 1024 * 1024, 524288),
  MAX_TEXT_BYTES: intFromString(256, 1024 * 1024, 16384),
  MAX_FRAMES_PER_SECOND: intFromString(1, 240, 60),

  RATE_LIMIT_WINDOW_MS: intFromString(1000, 3600000, 60000),
  RATE_LIMIT_MAX: intFromString(1, 100000, 60),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean)),
  // 仅在「容器端口不对外暴露 + 边缘反代会覆盖 X-Forwarded-For」时开启。
  // 开启后 app.set('trust proxy', 跳数)，限流才使用反代解析出的客户端 IP。
  TRUST_PROXY: boolFromString.default('false'),
  TRUST_PROXY_HOPS: intFromString(0, 10, 1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // 设备凭据（App 自动生成设备号 + 6 位数字密码，自动注册到服务端）
  // 凭据摘要持久化目录（容器内应为挂载卷，重启不丢）
  DEVICE_DATA_DIR: z.string().min(1).default('./data'),
  // 连续密码错误达到该次数后锁定设备
  DEVICE_LOCK_THRESHOLD: intFromString(1, 20, 5),
  // 锁定时长（分钟）
  DEVICE_LOCK_MINUTES: intFromString(1, 1440, 15),
  // 临时密码最长有效期（分钟）
  TEMP_PASSWORD_MAX_MINUTES: intFromString(1, 1440, 120),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // 启动即失败：不允许带病运行
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`[config] 环境变量校验失败，服务拒绝启动：\n${issues}`);
  process.exit(1);
}

const v = parsed.data;

if (v.HEARTBEAT_TIMEOUT_MS <= v.HEARTBEAT_INTERVAL_MS) {
  console.error('[config] HEARTBEAT_TIMEOUT_MS 必须大于 HEARTBEAT_INTERVAL_MS');
  process.exit(1);
}

/// 静态数据目录统一放到工作目录下的 data/，便于 Docker 挂载卷持久化。
export const dataDir = path.resolve(process.cwd(), v.DEVICE_DATA_DIR);

export const config = Object.freeze({
  nodeEnv: v.NODE_ENV,
  isProduction: v.NODE_ENV === 'production',
  port: v.PORT,
  host: v.HOST,
  jwtSecret: v.JWT_SECRET,
  adminApiKey: v.ADMIN_API_KEY,
  accessTtl: v.JWT_ACCESS_TTL,
  refreshTtl: v.REFRESH_TTL,
  sessionTtl: v.SESSION_TTL,
  maxSessions: v.MAX_SESSIONS,
  heartbeatIntervalMs: v.HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: v.HEARTBEAT_TIMEOUT_MS,
  reconnectGraceMs: v.PEER_RECONNECT_GRACE_MS,
  maxFrameBytes: v.MAX_FRAME_BYTES,
  maxTextBytes: v.MAX_TEXT_BYTES,
  maxFramesPerSecond: v.MAX_FRAMES_PER_SECOND,
  rateLimitWindowMs: v.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: v.RATE_LIMIT_MAX,
  corsOrigins: v.CORS_ORIGINS,
  trustProxy: v.TRUST_PROXY ? v.TRUST_PROXY_HOPS : false,
  trustProxyHops: v.TRUST_PROXY_HOPS,
  logLevel: v.LOG_LEVEL,
  deviceLockThreshold: v.DEVICE_LOCK_THRESHOLD,
  deviceLockDurationMs: v.DEVICE_LOCK_MINUTES * 60_000,
  temporaryPasswordMaxMinutes: v.TEMP_PASSWORD_MAX_MINUTES,
});

export type Config = typeof config;
