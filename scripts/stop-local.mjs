import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, process.env.DATA_DIR || 'data');
const port = Number(process.env.PORT || 4317);
const url = `http://127.0.0.1:${port}`;

let pid;
try {
  pid = Number((await readFile(join(dataDir, 'server.lock'), 'utf8')).trim());
} catch {
  console.log('服务没有运行。');
  process.exit(0);
}
if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('server.lock 中的进程编号无效。');

let alive = true;
try { process.kill(pid, 0); } catch { alive = false; }
if (!alive) {
  await unlink(join(dataDir, 'server.lock')).catch(() => undefined);
  console.log('服务已经停止，已清理旧锁文件。');
  process.exit(0);
}

let health;
try {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
  health = response.ok ? await response.json() : null;
} catch {
  health = null;
}
if (!health || health.name !== 'pi-multi-agent-workspace' || health.pid !== pid) {
  throw new Error('无法确认锁文件对应当前工作区服务。为避免结束错误进程，已取消操作。');
}

const stateResponse = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) });
if (!stateResponse.ok) throw new Error('无法读取本地服务的停止令牌。');
const state = await stateResponse.json();
const shutdownResponse = await fetch(`${url}/api/shutdown`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Workspace-Token': state.csrf,
  },
  body: '{}',
  signal: AbortSignal.timeout(3000),
});
if (!shutdownResponse.ok) {
  const body = await shutdownResponse.json().catch(() => ({}));
  throw new Error(body.error || '本地服务拒绝优雅停止请求。');
}

for (let attempt = 0; attempt < 120; attempt++) {
  await delay(100);
  try { process.kill(pid, 0); } catch {
    const lockPath = join(dataDir, 'server.lock');
    const current = await readFile(lockPath, 'utf8').catch(() => '');
    if (Number(current.trim()) === pid) await unlink(lockPath).catch(() => undefined);
    console.log('Pi Workspace 已停止。');
    process.exit(0);
  }
}
throw new Error('服务未能在 12 秒内优雅停止。没有强制结束进程，以免跳过数据库和会话收尾。');
