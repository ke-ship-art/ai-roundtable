import { access, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');

const url = `http://127.0.0.1:${port}`;
const dataDir = resolve(root, process.env.DATA_DIR || 'data');
const noOpen = process.argv.includes('--no-open');

async function probe() {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.name === 'pi-multi-agent-workspace';
  } catch {
    return false;
  }
}

async function ensureDependencies() {
  try {
    await access(join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), constants.R_OK);
    return;
  } catch {
    console.log('首次启动：正在安装项目依赖，请稍候……');
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npm, ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', windowsHide: false });
  const code = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', done);
  });
  if (code !== 0) throw new Error(`依赖安装失败（退出码 ${code}）。`);
}

function openBrowser() {
  if (noOpen) return;
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : process.platform === 'darwin'
      ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

if (await probe()) {
  console.log(noOpen ? `服务已经在运行：${url}` : `服务已经在运行，正在打开 ${url}`);
  openBrowser();
  process.exit(0);
}

await ensureDependencies();
await mkdir(dataDir, { recursive: true });
const log = await open(join(dataDir, 'server.log'), 'a');
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.mjs'], {
  cwd: root,
  detached: true,
  env: process.env,
  stdio: ['ignore', log.fd, log.fd],
  windowsHide: true,
});
server.unref();

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  if (await probe()) {
    await log.close();
    console.log(noOpen ? `启动成功：${url}` : `启动成功，正在打开 ${url}`);
    openBrowser();
    process.exit(0);
  }
  await delay(250);
}

await log.close();
throw new Error(`本地服务在 30 秒内未就绪。请查看 ${join(dataDir, 'server.log')}`);
