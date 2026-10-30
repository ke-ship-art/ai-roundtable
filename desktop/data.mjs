import { access, cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const transientFiles = new Set(['server.lock', 'server.log']);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function containsWorkspace(directory) {
  return exists(join(directory, 'workspace.sqlite'));
}

export async function stopLegacyServer(directory, port = 4317) {
  const lockPath = join(directory, 'server.lock');
  let pid;
  try {
    pid = Number((await readFile(lockPath, 'utf8')).trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`旧版数据目录的 server.lock 无效：${directory}`);
  }

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) {
    await rm(lockPath, { force: true });
    return false;
  }

  let health;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    health = response.ok ? await response.json() : null;
  } catch {
    health = null;
  }
  if (health?.name !== 'pi-multi-agent-workspace' || health.pid !== pid) {
    throw new Error(
      '检测到旧版服务锁，但无法确认对应进程。请先双击旧版 stop.cmd，再启动桌面版。',
    );
  }

  const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!stateResponse.ok) throw new Error('无法读取旧版服务的停止令牌。');
  const state = await stateResponse.json();
  const shutdownResponse = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workspace-Token': state.csrf,
    },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  if (!shutdownResponse.ok) throw new Error('旧版服务拒绝优雅停止请求。');

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!(await exists(lockPath))) return true;
    await delay(100);
  }
  throw new Error('旧版服务未能在 12 秒内完成收尾。');
}

export async function migrateLegacyData(targetDirectory, candidates, { port = 4317 } = {}) {
  const target = resolve(targetDirectory);
  if (await containsWorkspace(target)) return null;

  const sources = [...new Set(candidates.filter(Boolean).map(candidate => resolve(candidate)))];
  for (const candidate of sources) {
    if (candidate === target || !(await containsWorkspace(candidate))) continue;
    await stopLegacyServer(candidate, port);

    const temporary = `${target}.importing-${process.pid}`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(candidate, temporary, {
      recursive: true,
      filter: path => !transientFiles.has(path.split(/[\\/]/).at(-1)),
    });

    if (await exists(target)) {
      await cp(temporary, target, { recursive: true, force: false, errorOnExist: false });
      await rm(temporary, { recursive: true, force: true });
    } else {
      await rename(temporary, target);
    }
    return candidate;
  }
  return null;
}
