/**
 * 类型化 API 客户端。令牌只保存在模块内存中，绝不写入 localStorage / URL。
 * 策略：401 自动刷新一次并重试；4xx 不重试；5xx 最多重试 3 次；网络失败显示离线提示。
 */
const BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://127.0.0.1:8080')
  .trim()
  .replace(/\/$/, '');

export const apiBase = BASE;

export interface ScreenInfo {
  width: number;
  height: number;
  density: number;
  rotation: number;
}

export interface SessionView {
  sessionId: string;
  status: 'waiting' | 'active' | 'closed';
  host: { model: string; osVersion: string; screen: ScreenInfo };
  controller?: { model: string; osVersion: string };
  hostOnline: boolean;
  controllerOnline: boolean;
  createdAt: number;
  expiresAt: number;
  bytesRelayed: number;
  framesRelayed: number;
  commandsRelayed: number;
}

export interface Overview {
  totalSessions: number;
  waitingSessions: number;
  activeSessions: number;
  onlineHosts: number;
  onlineControllers: number;
  authorizedSessions: number;
  pendingPairings: number;
  refreshTokens: number;
  bytesRelayed: number;
  framesRelayed: number;
  commandsRelayed: number;
  maxSessions: number;
}

export interface OverviewResponse {
  overview: Overview;
  sessions: SessionView[];
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

interface ErrorBody {
  error: { code: string; message: string; requestId?: string };
}

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

const FRIENDLY: Record<string, string> = {
  OFFLINE: '网络不可用：请检查中继服务器地址与服务状态',
  UNAUTHORIZED: '身份凭证无效或已过期，请重新登录',
  FORBIDDEN: '当前角色无权访问此数据',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  INTERNAL: '服务器暂时不可用，请稍后重试',
  SESSION_NOT_FOUND: '会话不存在或已结束',
};

let accessToken: string | null = null;
let refreshTokenValue: string | null = null;

export function clearTokens(): void {
  accessToken = null;
  refreshTokenValue = null;
}

export function hasSession(): boolean {
  return accessToken !== null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readError(status: number, body: ErrorBody | null): ApiError {
  const code = body?.error?.code ?? (status >= 500 ? 'INTERNAL' : 'INVALID_INPUT');
  return new ApiError(code, status, FRIENDLY[code] ?? body?.error?.message ?? `请求失败（HTTP ${status}）`);
}

async function tryRefresh(): Promise<boolean> {
  const token = refreshTokenValue;
  if (!token) return false;
  try {
    const response = await fetch(`${BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
    if (!response.ok) {
      clearTokens();
      return false;
    }
    const pair = (await response.json()) as TokenPair;
    accessToken = pair.accessToken;
    refreshTokenValue = pair.refreshToken;
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

async function request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('OFFLINE', 0, FRIENDLY.OFFLINE);
  }

  if (response.status === 401 && refreshTokenValue && !path.startsWith('/api/v1/auth/')) {
    if (await tryRefresh()) return request<T>(path, init, 0);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    const error = readError(response.status, body);
    if (response.status >= 500 && attempt < 2) {
      await delay(400 * (attempt + 1));
      return request<T>(path, init, attempt + 1);
    }
    throw error;
  }

  return (await response.json()) as T;
}

export async function login(adminKey: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/v1/auth/observer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    });
  } catch {
    throw new ApiError('OFFLINE', 0, FRIENDLY.OFFLINE);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    throw readError(response.status, body);
  }
  const pair = (await response.json()) as TokenPair;
  accessToken = pair.accessToken;
  refreshTokenValue = pair.refreshToken;
}

export async function getOverview(): Promise<OverviewResponse> {
  return request<OverviewResponse>('/api/v1/admin/overview');
}

export async function getHealth(): Promise<{ status: string; uptimeSeconds: number }> {
  return request<{ status: string; uptimeSeconds: number }>('/health');
}
