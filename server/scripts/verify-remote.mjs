/**
 * 线上/远程链路冒烟：不会拉起本地服务，直接打真实域名。
 * 覆盖 REST 配对鉴权 + 双端 WebSocket 文本/二进制帧转发，用来确认反代是否透传 Upgrade。
 *
 * 用法（普通平台，推荐）：
 *   BASE_URL='https://relay.example.com' node scripts/verify-remote.mjs
 * 用法（WorkBuddy 临时发布链接，网关要求 sharecode）：
 *   BASE_URL='https://xxx.app.workbuddy.host/?sharecode=YYYY' node scripts/verify-remote.mjs
 *
 * 若链接里带 sharecode，脚本会把它附加到每个 REST 与 WebSocket 请求上。
 * 注意：WorkBuddy 发布网关不代理 WebSocket Upgrade，该场景下 WS 用例会失败，
 * 这是平台限制而非服务缺陷，详见 docs/DEPLOYMENT.md。
 */
import WebSocket from 'ws';

const raw = process.env.BASE_URL || '';
if (!/^https?:\/\//.test(raw)) {
  console.error('请设置 BASE_URL，例如：https://relay.example.com');
  process.exit(1);
}

const shareUrl = new URL(raw);
const origin = shareUrl.origin;
const shareCode = shareUrl.searchParams.get('sharecode');

const httpUrl = (path) => {
  const u = new URL(path, origin);
  if (shareCode) u.searchParams.set('sharecode', shareCode);
  return u.toString();
};
const wsUrl = () => {
  const u = new URL('/ws', origin);
  u.protocol = origin.startsWith('https://') ? 'wss:' : 'ws:';
  if (shareCode) u.searchParams.set('sharecode', shareCode);
  return u.toString();
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function json(method, path, { body, headers = {} } = {}) {
  const res = await fetch(httpUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空响应或非 JSON */ }
  return { status: res.status, data, headers: res.headers };
}

const device = (model) => ({
  model,
  osVersion: 'Android 14',
  appVersion: '1.0.0',
  screen: { width: 1080, height: 2400, density: 2.75, rotation: 0 },
});

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10000,
    });
    const messages = [];
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 12000);
    ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));
    ws.on('open', () => { clearTimeout(timer); resolve({ ws, messages }); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => { clearTimeout(timer); reject(new Error('连接提前关闭')); });
  });
}

function waitFor(list, predicate, timeoutMs = 5000) {
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

const parseText = (msg) => JSON.parse(msg.data.toString('utf8'));

let hostSock;
let controllerSock;
try {
  const health = await json('GET', '/health');
  check('线上 GET /health 返回 200', health.status === 200 && health.data?.status === 'ok', JSON.stringify(health.data));
  const ready = await json('GET', '/ready');
  check('线上 GET /ready 返回 200', ready.status === 200, JSON.stringify(ready.data));
  check('响应携带 X-Request-Id', Boolean(health.headers.get('x-request-id')));

  const noAuth = await json('GET', '/api/v1/admin/overview');
  check('无令牌访问被拒绝 401', noAuth.status === 401, JSON.stringify(noAuth.data?.error));

  // 设备号 + 6 位密码：首次自动注册（用随机设备号，避免和真实设备冲突）
  const testDeviceId = String(Date.now()).slice(-9).padStart(9, '0');
  const testPassword = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const deviceAuth = { deviceId: testDeviceId, password: testPassword };
  const created = await json('POST', '/api/v1/sessions', {
    body: { role: 'host', device: device('Pixel 8'), deviceAuth },
  });
  check('创建会话返回 201', created.status === 201, JSON.stringify(created.data?.error));
  const { accessToken: hostToken, refreshToken } = created.data ?? {};
  check('不再签发配对码', created.data?.pairingCode === undefined, String(created.data?.pairingCode));

  const badClaim = await json('POST', '/api/v1/sessions/claim-device', {
    body: {
      deviceId: testDeviceId,
      password: testPassword === '000000' ? '111111' : '000000',
      device: device('Galaxy'),
    },
  });
  check('错误密码被拒绝 401', badClaim.status === 401, String(badClaim.status));

  hostSock = await openSocket(hostToken);
  check('受控端 WS 握手成功', hostSock.ws.readyState === WebSocket.OPEN);
  await waitFor(hostSock.messages, (m) => !m.isBinary && parseText(m).type === 'session.ready');
  check('收到 session.ready', true);

  const claimed = await json('POST', '/api/v1/sessions/claim-device', {
    body: { deviceId: testDeviceId, password: testPassword, device: device('Galaxy S24') },
  });
  check('认领会话返回 200', claimed.status === 200, JSON.stringify(claimed.data?.error));
  const controllerToken = claimed.data?.accessToken;
  check('认领返回受控端屏幕信息', claimed.data?.host?.screen?.width === 1080);

  // 不存在的设备号应被拒绝（统一 401，防枚举）
  const ghost = await json('POST', '/api/v1/sessions/claim-device', {
    body: { deviceId: '999999999', password: '123456', device: device('Ghost') },
  });
  check('未知设备号被拒绝 401', ghost.status === 401, String(ghost.status));

  controllerSock = await openSocket(controllerToken);
  check('控制端 WS 握手成功', controllerSock.ws.readyState === WebSocket.OPEN);
  await waitFor(hostSock.messages, (m) => !m.isBinary && parseText(m).type === 'session.peer_joined');
  check('受控端收到 peer_joined', true);

  // v2：线上同样必须走会话级授权，授权前控制指令一律被服务端拦截
  await waitFor(hostSock.messages, (m) => !m.isBinary && parseText(m).type === 'session.authorize_request');
  check('线上：服务端发起会话授权请求', true);
  hostSock.ws.send(JSON.stringify({
    v: 2, type: 'session.authorize_grant', ts: Date.now(), seq: 2, payload: {},
  }));
  await waitFor(controllerSock.messages, (m) => !m.isBinary &&
    parseText(m).type === 'session.authorize_state' && parseText(m).payload.authorized === true);
  check('线上：授权后控制端收到放行回执', true);

  hostSock.ws.send(JSON.stringify({
    v: 2, type: 'stream.config', ts: Date.now(), seq: 1,
    payload: { width: 1080, height: 2400, codec: 'h264' },
  }));
  await waitFor(controllerSock.messages, (m) => !m.isBinary && parseText(m).type === 'stream.config');
  check('host → controller 文本帧转发', true);

  controllerSock.ws.send(JSON.stringify({
    v: 2, type: 'control.tap', ts: Date.now(), seq: 7,
    payload: { x: 0.42, y: 0.73 },
  }));
  const gotTap = await waitFor(hostSock.messages, (m) => !m.isBinary && parseText(m).type === 'control.tap');
  check('controller → host 触控指令转发', parseText(gotTap).payload.x === 0.42);

  const payload = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21]);
  const header = Buffer.alloc(12);
  header[0] = 0xa5; header[1] = 2; header[2] = 2; header[3] = 1;
  header.writeBigUInt64BE(BigInt(Date.now()), 4);
  const frame = Buffer.concat([header, payload]);
  hostSock.ws.send(frame, { binary: true });
  const gotFrame = await waitFor(controllerSock.messages, (m) => m.isBinary);
  check('host → controller 二进制视频帧转发', Buffer.from(gotFrame.data).equals(frame));

  const refreshed = await json('POST', '/api/v1/auth/refresh', { body: { refreshToken } });
  check('refresh token 轮换成功', refreshed.status === 200 && Boolean(refreshed.data?.accessToken));
  const reuseRefresh = await json('POST', '/api/v1/auth/refresh', { body: { refreshToken } });
  check('旧 refresh token 已失效', reuseRefresh.status === 401);

  // 越权测试会关闭会话，放在最后
  hostSock.ws.send(JSON.stringify({ v: 2, type: 'control.tap', ts: Date.now(), seq: 9, payload: {} }));
  const closeCode = await new Promise((resolve) => {
    if (hostSock.ws.readyState === WebSocket.CLOSED) return resolve(4000);
    hostSock.ws.once('close', (code) => resolve(code));
    setTimeout(() => resolve(-1), 3000);
  });
  check('角色越权指令被拒绝并关闭连接', closeCode === 4000, `close=${closeCode}`);

  const invalidWs = await openSocket('not-a-jwt').catch(() => null);
  check('非法令牌无法建立 WS', invalidWs === null);
} catch (err) {
  check('远程链路流程未抛异常', false, err instanceof Error ? err.message : String(err));
} finally {
  try { hostSock?.ws.close(); } catch { /* ignore */ }
  try { controllerSock?.ws.close(); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n远程冒烟结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
