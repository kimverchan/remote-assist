#!/usr/bin/env node
/**
 * 重启/修复 Docker Desktop 之后的一键验收：
 *   守护进程 -> 镜像构建 -> compose 启动 -> 健康检查 -> REST + 双端 WS 全链路
 *
 * 用法（在 server/ 目录下）：
 *   node scripts/verify-docker.mjs
 *
 * 也可用环境变量覆盖：RELAY_PORT、SKIP_BUILD=1、KEEP_CONTAINER=0
 * 退出码 0 表示全部通过。容器默认保留运行，便于继续联调。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoRoot = path.resolve(serverDir, '..');
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';
const NODE = process.execPath;
const PORT = Number(process.env.RELAY_PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const step = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const tail = (text, lines = 12) =>
  (text || '').trim().split('\n').slice(-lines).join('\n');

function docker(args, env = {}) {
  return spawnSync(DOCKER, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000,
  });
}

/** 复用或生成密钥；写入仓库根 .env（已被 .gitignore 忽略），便于之后 compose down/up */
function loadOrCreateEnv() {
  const file = path.join(repoRoot, '.env');
  const values = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  let changed = false;
  if (!values.JWT_SECRET || values.JWT_SECRET.length < 32) {
    values.JWT_SECRET = randomBytes(32).toString('hex');
    changed = true;
  }
  if (!values.ADMIN_API_KEY || values.ADMIN_API_KEY.length < 16) {
    values.ADMIN_API_KEY = randomBytes(24).toString('hex');
    changed = true;
  }
  values.RELAY_PORT = String(PORT);
  if (changed || !existsSync(file)) {
    writeFileSync(
      file,
      `# 由 scripts/verify-docker.mjs 生成，请勿提交\nJWT_SECRET=${values.JWT_SECRET}\nADMIN_API_KEY=${values.ADMIN_API_KEY}\nRELAY_PORT=${PORT}\n`,
      'utf8',
    );
    console.log(`已写入 ${file}（.gitignore 已忽略，供后续 compose down/up 使用）`);
  }
  return values;
}

function failFast(result, label) {
  if (result.status !== 0) {
    step(label, false, `exit=${result.status}`);
    console.log('--- stdout ---\n' + tail(result.stdout));
    console.log('--- stderr ---\n' + tail(result.stderr));
    return true;
  }
  step(label, true);
  return false;
}

console.log(`仓库根目录: ${repoRoot}`);
console.log(`目标端口  : ${PORT}\n`);

// 1) 守护进程（Docker CLI 29 的 info --format 模板顶层无 .Server 字段，用 version 代替）
const info = docker(['version', '--format', '{{.Server.Version}}']);
if (failFast(info, 'Docker 守护进程可用')) {
  console.log('\n引擎没起来：先按 docs/WSL-FIX.md 完成 WSL 修复并重启，再运行本脚本。');
  console.log('提示：中继服务不依赖 Docker，可直接用 node dist/index.js 运行。');
  process.exit(1);
}
console.log(`          Server 版本 ${info.stdout.trim()}`);

const env = loadOrCreateEnv();

// 2) 镜像构建
if (process.env.SKIP_BUILD !== '1') {
  const build = docker(['build', '-t', 'remote-assist-relay:latest', './server']);
  if (failFast(build, '多阶段镜像构建')) {
    console.log('\n构建失败，输出见上。');
    process.exit(1);
  }
} else {
  console.log('SKIP  多阶段镜像构建（SKIP_BUILD=1）');
}

// 3) compose 启动
const up = docker(['compose', 'up', '-d', '--build'], env);
if (failFast(up, 'compose 启动容器')) {
  console.log('\n容器启动失败，输出见上。');
  process.exit(1);
}

// 4) 轮询健康
const deadline = Date.now() + 90_000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) { healthy = true; break; }
  } catch { /* 容器还在起 */ }
  await new Promise((r) => setTimeout(r, 1500));
}
step('容器 /health 就绪', healthy);
if (!healthy) {
  const logs = docker(['compose', 'logs', '--tail=40'], env);
  console.log(tail(logs.stdout + logs.stderr, 40));
  process.exit(1);
}

// 5) 全链路 REST + 双端 WS
const verify = spawnSync(NODE, ['scripts/verify-remote.mjs'], {
  cwd: serverDir,
  env: { ...process.env, BASE_URL: BASE },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 180_000,
});
if (verify.stdout) process.stdout.write(verify.stdout);
if (verify.stderr) process.stderr.write(verify.stderr);
step('容器 REST + 双端 WS 全链路', verify.status === 0, `exit=${verify.status}`);

// 6) 容器状态
const ps = docker(['compose', 'ps'], env);
console.log('\n--- docker compose ps ---\n' + (ps.stdout || ps.stderr || '').trim());

if (process.env.KEEP_CONTAINER === '0') {
  docker(['compose', 'down'], env);
  console.log('容器已下线（KEEP_CONTAINER=0）');
} else {
  console.log('容器保留运行；下线请在仓库根目录执行 docker compose down（.env 已备好密钥）');
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
