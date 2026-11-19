import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  sessionId?: string;
  role?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withContext<T>(ctx: Partial<LogContext>, fn: () => T): T {
  return storage.run({ ...(storage.getStore() ?? {}), ...ctx }, fn);
}

export function getContext(): LogContext {
  return storage.getStore() ?? {};
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

const SENSITIVE = /token|secret|password|authorization|apikey|api_key|pairingcode|credential/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE.test(key)) {
      out[key] = '[redacted]';
    } else if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...getContext(),
    ...redact(fields),
  });
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
