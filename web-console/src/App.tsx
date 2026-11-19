import { useCallback, useState, type FormEvent } from 'react';
import {
  apiBase,
  clearTokens,
  getHealth,
  login,
  type Overview,
  type SessionView,
} from './api/client';
import { useOverview } from './hooks/useOverview';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

function StatusPill({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className={`pill ${ok ? 'pill-ok' : 'pill-warn'}`}>
      <span className="dot" />
      {text}
    </span>
  );
}

function SessionTable({ sessions }: { sessions: SessionView[] }) {
  if (sessions.length === 0) {
    return <div className="empty">当前没有进行中的会话。受控端点击「开始协助」后会显示在这里。</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>会话 ID</th>
            <th>状态</th>
            <th>受控设备</th>
            <th>分辨率</th>
            <th>控制端</th>
            <th>已运行</th>
            <th>流量</th>
            <th>视频帧 / 指令</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.sessionId}>
              <td className="mono">{s.sessionId.slice(0, 12)}…</td>
              <td><StatusPill ok={s.status === 'active'} text={s.status === 'active' ? '进行中' : '等待配对'} /></td>
              <td>
                <div>{s.host.model}</div>
                <div className="sub">{s.host.osVersion}</div>
              </td>
              <td className="mono">{s.host.screen.width}×{s.host.screen.height}</td>
              <td>{s.controller?.model ?? '—'}</td>
              <td>{formatDuration(Date.now() - s.createdAt)}</td>
              <td className="mono">{formatBytes(s.bytesRelayed)}</td>
              <td className="mono">{s.framesRelayed} / {s.commandsRelayed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function overviewCards(o: Overview) {
  return [
    { label: '总会话', value: String(o.totalSessions), hint: `上限 ${o.maxSessions}` },
    { label: '进行中', value: String(o.activeSessions), hint: `其中 ${o.authorizedSessions} 个已获授权` },
    { label: '等待配对', value: String(o.waitingSessions), hint: `${o.pendingPairings} 个有效配对码` },
    { label: '在线受控端', value: String(o.onlineHosts), hint: '正在共享屏幕' },
    { label: '在线控制端', value: String(o.onlineControllers), hint: '正在操作' },
    { label: '累计转发流量', value: formatBytes(o.bytesRelayed), hint: `${o.framesRelayed} 帧 / ${o.commandsRelayed} 条指令` },
  ];
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [adminKey, setAdminKey] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [health, setHealth] = useState<string>('未知');

  const handleAuthLost = useCallback(() => {
    clearTokens();
    setLoggedIn(false);
    setLoginError('登录已过期，请重新输入运维密钥');
  }, []);

  const { data, error, loading, lastUpdated, offline } = useOverview(loggedIn, handleAuthLost);

  const doLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (!adminKey.trim()) return;
    setLoggingIn(true);
    setLoginError(null);
    try {
      await login(adminKey.trim());
      setLoggedIn(true);
      setAdminKey('');
      void getHealth()
        .then((h) => setHealth(`运行中 · 已启动 ${formatDuration(h.uptimeSeconds * 1000)}`))
        .catch(() => setHealth('不可达'));
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoggingIn(false);
    }
  };

  const doLogout = () => {
    clearTokens();
    setLoggedIn(false);
    setLoginError(null);
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>远程协助 · 运维看板</h1>
          <p className="subtitle">只读监控 · 协议 v1 · 2 秒轮询</p>
        </div>
        <div className="header-right">
          <StatusPill ok={loggedIn && !error} text={offline ? '离线' : loggedIn ? '已连接' : '未登录'} />
          {loggedIn ? (
            <button className="ghost" onClick={doLogout}>退出</button>
          ) : null}
        </div>
      </header>

      {!loggedIn ? (
        <main className="login-wrap">
          <form className="login-card" onSubmit={doLogin}>
            <h2>连接中继服务器</h2>
            <p className="sub">输入部署时配置的 <code>ADMIN_API_KEY</code>，换取只读 observer 令牌。令牌仅存内存，刷新页面需重新登录。</p>
            <label htmlFor="adminKey">运维密钥</label>
            <input
              id="adminKey"
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="ADMIN_API_KEY"
              autoComplete="off"
            />
            <div className="endpoint">目标：<code>{apiBase}</code></div>
            {loginError ? <div className="alert">{loginError}</div> : null}
            <button className="primary" type="submit" disabled={loggingIn || !adminKey.trim()}>
              {loggingIn ? '连接中…' : '进入看板'}
            </button>
          </form>
          <p className="footnote">此页面只读，不能查看屏幕内容，也不能下发控制指令。控制请使用安卓控制端 App。</p>
        </main>
      ) : (
        <main>
          {error ? <div className="alert">{error}</div> : null}

          {loading && !data ? (
            <div className="empty">正在加载会话数据…</div>
          ) : data ? (
            <>
              <section className="stats">
                {overviewCards(data.overview).map((card) => (
                  <StatCard key={card.label} {...card} />
                ))}
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>会话列表</h2>
                  <span className="sub">
                    {lastUpdated ? `最后更新 ${formatTime(lastUpdated)}` : '等待首次同步'}
                    {' · '}服务器 {health}
                  </span>
                </div>
                <SessionTable sessions={data.sessions} />
              </section>
            </>
          ) : (
            <div className="empty">暂无数据，等待下一次轮询…</div>
          )}
        </main>
      )}

      <footer className="footer">
        <span>中继协议 v1 · 二进制视频帧 / JSON 控制指令</span>
        <span>客户端错误码已映射为中文提示 · 4xx 不重试 · 5xx 最多重试 3 次</span>
      </footer>
    </div>
  );
}
