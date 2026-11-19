/**
 * 端到端冒烟：自动拉起服务 → REST → 配对码失败锁定 → 会话级授权 → 双端转发 → 错误路径 → 停机
 * 运行：npm run build && npm run smoke
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(serverDir, 'dist', 'index.js');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const PROTOCOL_VERSION = 2;

if (!existsSync(entry)) {
  console.error('缺少 dist/index.js，请先执行 npm run build');
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  cwd: serverDir,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    JWT_SECRET: 'smoke-test-secret-key-at-least-32-chars-long',
    ADMIN_API_KEY: 'smoke-admin-key-123456',
    CORS_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'error',
    HEARTBEAT_INTERVAL_MS: '3000',
    HEARTBEAT_TIMEOUT_MS: '9000',
    PEER_RECONNECT_GRACE_MS: '2000',
    DEVICE_LOCK_THRESHOLD: '3',
    DEVICE_LOCK_MINUTES: '1',
    TEMP_PASSWORD_MAX_MINUTES: '120',
    DEVICE_DATA_DIR: './data-smoke',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function waitHealthy() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* 尚未监听 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务启动超时');
}

async function json(method, url, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data, headers: res.headers };
}

const device = (model) => ({
  model,
  osVersion: 'Android 14',
  appVersion: '1.0.0',
  screen: { width: 1080, height: 2400, density: 2.75, rotation: 0 },
});

const envelope = (type, seq, payload = {}) => JSON.stringify({
  v: PROTOCOL_VERSION, type, ts: Date.now(), seq, payload,
});

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${token}` } });
    const messages = [];
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 4000);
    ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));
    ws.on('open', () => { clearTimeout(timer); resolve({ ws, messages }); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => { clearTimeout(timer); reject(new Error('连接提前关闭')); });
  });
}

function waitFor(list, predicate, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = list.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error('等待消息超时'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function parseText(msg) {
  return JSON.parse(msg.data.toString('utf8'));
}

const textOf = (type) => (m) => !m.isBinary && parseText(m).type === type;

let hostSock;
let controllerSock;
let hostSock2;
let controllerSock2;
try {
  await waitHealthy();

  const health = await json('GET', '/health');
  check('GET /health 返回 200', health.status === 200 && health.data.status === 'ok');
  const ready = await json('GET', '/ready');
  check('GET /ready 返回 200', ready.status === 200, JSON.stringify(ready.data));
  check('响应携带 X-Request-Id', Boolean(health.headers.get('x-request-id')));

  const noAuth = await json('GET', '/api/v1/admin/overview');
  check('无令牌访问被拒绝 401', noAuth.status === 401, JSON.stringify(noAuth.data?.error));

  // 设备号 + 6 位密码：首次自动注册
  const testDeviceId = '123456789';
  const testPassword = '654321';
  const deviceAuth = { deviceId: testDeviceId, password: testPassword };
  const created = await json('POST', '/api/v1/sessions', {
    body: { role: 'host', device: device('Pixel 8'), deviceAuth },
  });
  check('创建会话返回 201', created.status === 201, JSON.stringify(created.data?.error));
  const { sessionId, accessToken: hostToken, refreshToken } = created.data ?? {};
  check('不再签发配对码', created.data?.pairingCode === undefined, String(created.data?.pairingCode));

  // P0-1：按设备累计密码失败次数，第 3 次锁定设备（用独立设备，避免影响主流程）
  const lockDeviceId = '999888777';
  await json('POST', '/api/v1/sessions', {
    body: { role: 'host', device: device('Pixel Lock'), deviceAuth: { deviceId: lockDeviceId, password: '111111' } },
  });
  const attempts = [];
  for (let i = 0; i < 3; i += 1) {
    attempts.push(await json('POST', '/api/v1/sessions/claim-device', {
      body: { deviceId: lockDeviceId, password: '000000', device: device('Galaxy') },
    }));
  }
  check('错误密码被拒绝 401', attempts[0].status === 401, String(attempts[0].status));
  check(
    '密码错误 3 次后设备锁定 429',
    attempts.slice(0, 2).every((r) => r.status === 401) &&
      attempts[2].status === 429 &&
      attempts[2].data?.error?.code === 'DEVICE_LOCKED',
    attempts.map((r) => r.status).join(','),
  );
  // 锁定后即使正确密码也被拒绝
  const lockedCorrect = await json('POST', '/api/v1/sessions/claim-device', {
    body: { deviceId: lockDeviceId, password: '111111', device: device('Galaxy') },
  });
  check('锁定期内正确密码也被拒绝 429', lockedCorrect.status === 429, String(lockedCorrect.status));

  hostSock = await openSocket(hostToken);
  check('受控端 WS 握手成功', hostSock.ws.readyState === WebSocket.OPEN);
  const readyMsg = await waitFor(hostSock.messages, textOf('session.ready'));
  check('收到 session.ready', readyMsg !== undefined);

  const claimed = await json('POST', '/api/v1/sessions/claim-device', {
    body: { deviceId: testDeviceId, password: testPassword, device: device('Galaxy S24') },
  });
  check('认领会话返回 200', claimed.status === 200, JSON.stringify(claimed.data?.error));
  const controllerToken = claimed.data?.accessToken;
  check('认领返回受控端屏幕信息', claimed.data?.host?.screen?.width === 1080);

  // 未知设备号统一 401，防枚举
  const ghost = await json('POST', '/api/v1/sessions/claim-device', {
    body: { deviceId: '000000000', password: '123456', device: device('Ghost') },
  });
  check('未知设备号被拒绝 401', ghost.status === 401, String(ghost.status));

  controllerSock = await openSocket(controllerToken);
  check('控制端 WS 握手成功', controllerSock.ws.readyState === WebSocket.OPEN);
  const joined = await waitFor(hostSock.messages, textOf('session.peer_joined'));
  check('受控端收到 peer_joined', joined !== undefined);

  // P0-4：控制端入房不等于获得控制权，服务端必须向受控端请求确认
  const authRequest = await waitFor(hostSock.messages, textOf('session.authorize_request'));
  check(
    '服务端向受控端发起授权请求',
    authRequest !== undefined && Boolean(parseText(authRequest).payload.controller?.model),
  );
  const pending = await waitFor(controllerSock.messages, textOf('session.authorize_state'));
  check('控制端被告知尚未授权', parseText(pending).payload.authorized === false);

  const beforeTap = hostSock.messages.length;
  controllerSock.ws.send(envelope('control.tap', 5, { x: 0.1, y: 0.2 }));
  await new Promise((r) => setTimeout(r, 250));
  const blocked = controllerSock.messages.find(
    (m) => !m.isBinary && parseText(m).type === 'session.error' &&
      parseText(m).payload?.code === 'NOT_AUTHORIZED',
  );
  const leaked = hostSock.messages.slice(beforeTap).some(textOf('control.tap'));
  check('未授权时控制指令被服务端拦截', Boolean(blocked) && !leaked,
    `error=${Boolean(blocked)} leaked=${leaked}`);

  // 受控端同意后，服务端才放行控制指令
  hostSock.ws.send(envelope('session.authorize_grant', 2, {}));
  const granted = await waitFor(
    controllerSock.messages,
    (m) => !m.isBinary && parseText(m).type === 'session.authorize_state' &&
      parseText(m).payload.authorized === true,
  );
  check('受控端同意后控制端收到授权回执', granted !== undefined);

  const configText = envelope('stream.config', 1, { width: 1080, height: 2400, codec: 'h264' });
  hostSock.ws.send(configText);
  const gotConfig = await waitFor(controllerSock.messages, textOf('stream.config'));
  check('host → controller 文本帧转发', gotConfig !== undefined);

  const tapText = envelope('control.tap', 7, { x: 0.42, y: 0.73 });
  controllerSock.ws.send(tapText);
  const gotTap = await waitFor(hostSock.messages, textOf('control.tap'));
  check('授权后 controller → host 指令转发',
    gotTap !== undefined && parseText(gotTap).payload.x === 0.42);

  const payload = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21]);
  const header = Buffer.alloc(12);
  header[0] = 0xa5;
  header[1] = PROTOCOL_VERSION;
  header[2] = 2;
  header[3] = 1;
  header.writeBigUInt64BE(BigInt(Date.now()), 4);
  const frame = Buffer.concat([header, payload]);
  hostSock.ws.send(frame, { binary: true });
  const gotFrame = await waitFor(controllerSock.messages, (m) => m.isBinary);
  check('host → controller 二进制视频帧转发',
    gotFrame !== undefined && Buffer.from(gotFrame.data).equals(frame));

  const refreshed = await json('POST', '/api/v1/auth/refresh', { body: { refreshToken } });
  check('refresh token 轮换成功', refreshed.status === 200 && Boolean(refreshed.data?.accessToken));
  const reuseRefresh = await json('POST', '/api/v1/auth/refresh', { body: { refreshToken } });
  check('旧 refresh token 已失效', reuseRefresh.status === 401);

  const observer = await json('POST', '/api/v1/auth/observer', {
    headers: { 'X-Admin-Key': 'smoke-admin-key-123456' },
  });
  check('运维看板换取 observer token', observer.status === 200);
  const overview = await json('GET', '/api/v1/admin/overview', {
    headers: { Authorization: `Bearer ${observer.data?.accessToken}` },
  });
  check('GET /admin/overview 返回统计', overview.status === 200 && overview.data?.overview?.activeSessions >= 1,
    JSON.stringify(overview.data?.overview));
  check('统计含转发字节数', overview.data?.overview?.bytesRelayed > 0);
  check('统计含已授权会话数', overview.data?.overview?.authorizedSessions >= 1,
    String(overview.data?.overview?.authorizedSessions));

  // 越权测试会关闭会话，必须放在所有统计与令牌检查之后
  const forbidden = envelope('control.tap', 9, {});
  hostSock.ws.send(forbidden);
  const closeCode = await new Promise((resolve) => {
    if (hostSock.ws.readyState === WebSocket.CLOSED) return resolve(4000);
    hostSock.ws.once('close', (code) => resolve(code));
    setTimeout(() => resolve(-1), 2500);
  });
  check('角色越权指令被拒绝并关闭连接', closeCode === 4000, `close=${closeCode}`);

  // P0-4：受控端拒绝授权时立即关闭整个会话，不留可继续控制的窗口
  const device2 = { deviceId: '777888999', password: '123123' };
  const created2 = await json('POST', '/api/v1/sessions', {
    body: { role: 'host', device: device('Pixel 6'), deviceAuth: device2 },
  });
  const claimed2 = await json('POST', '/api/v1/sessions/claim-device', {
    body: { deviceId: device2.deviceId, password: device2.password, device: device('Galaxy S22') },
  });
  hostSock2 = await openSocket(created2.data?.accessToken);
  controllerSock2 = await openSocket(claimed2.data?.accessToken);
  await waitFor(hostSock2.messages, textOf('session.authorize_request'));
  hostSock2.ws.send(envelope('session.authorize_deny', 1, { reason: '冒烟测试：拒绝协助' }));
  const denied = await waitFor(controllerSock2.messages, textOf('session.closed'));
  check('受控端拒绝授权会关闭会话', denied !== undefined);

  const invalidWs = await openSocket('not-a-jwt').catch(() => null);
  check('非法令牌无法建立 WS', invalidWs === null);
} catch (err) {
  check('冒烟流程未抛异常', false, err instanceof Error ? err.message : String(err));
} finally {
  for (const sock of [hostSock, controllerSock, hostSock2, controllerSock2]) {
    try { sock?.ws.close(); } catch { /* ignore */ }
  }
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n冒烟结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
