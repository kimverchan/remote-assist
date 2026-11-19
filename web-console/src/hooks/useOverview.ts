import { useEffect, useState } from 'react';
import { ApiError, getOverview, type OverviewResponse } from '../api/client';

export interface OverviewState {
  data: OverviewResponse | null;
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
  offline: boolean;
}

/** 2 秒 REST 轮询。浏览器 WebSocket 无法自定义 Authorization 头，而协议禁止令牌进 URL */
export function useOverview(enabled: boolean, onAuthLost: () => void): OverviewState {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let active = true;
    let timer: number | undefined;

    const load = async () => {
      try {
        const result = await getOverview();
        if (!active) return;
        setData(result);
        setError(null);
        setOffline(false);
        setLastUpdated(Date.now());
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : '未知错误');
        setOffline(err instanceof ApiError && (err.code === 'OFFLINE' || err.status === 0));
        if (err instanceof ApiError && err.code === 'UNAUTHORIZED') onAuthLost();
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    timer = window.setInterval(load, 2000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled, onAuthLost]);

  return { data, error, loading, lastUpdated, offline };
}
