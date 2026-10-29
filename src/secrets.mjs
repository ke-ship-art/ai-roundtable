import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const entropy = Buffer.from('pi-multi-agent-workspace:credentials:v1').toString('base64');
const protectScript = `Add-Type -AssemblyName System.Security;$source=[Console]::In.ReadToEnd().Trim();$plain=[Convert]::FromBase64String($source);$entropy=[Convert]::FromBase64String('${entropy}');$cipher=[System.Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($cipher))`;
const unprotectScript = `Add-Type -AssemblyName System.Security;$source=[Console]::In.ReadToEnd().Trim();$cipher=[Convert]::FromBase64String($source);$entropy=[Convert]::FromBase64String('${entropy}');$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($plain))`;

function encodedCommand(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(script)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Windows 凭据加密失败（${code}）：${stderr.trim()}`)));
    child.stdin.end(input);
  });
}

export const windowsProtector = {
  name: 'Windows DPAPI（当前用户）',
  async encrypt(text) {
    if (process.platform !== 'win32') throw new Error('当前系统不支持 Windows DPAPI；请改用环境变量提供凭据。');
    return runPowerShell(protectScript, Buffer.from(text, 'utf8').toString('base64'));
  },
  async decrypt(ciphertext) {
    if (process.platform !== 'win32') throw new Error('此凭据只能由原 Windows 用户账户解密。');
    const encoded = await runPowerShell(unprotectScript, ciphertext);
    return Buffer.from(encoded, 'base64').toString('utf8');
  },
};

async function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', flush: true });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class SecretStore {
  constructor(directory, protector = windowsProtector) {
    this.directory = directory;
    this.protector = protector;
    this.data = {};
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const ciphertext = await readFile(join(this.directory, 'credentials.enc'), 'utf8');
      this.data = JSON.parse(await this.protector.decrypt(ciphertext.trim()));
      if (!this.data || Array.isArray(this.data) || typeof this.data !== 'object') throw new Error('凭据内容格式无效');
    } catch (error) {
      if (error.code === 'ENOENT') { this.data = {}; return; }
      throw new Error('凭据无法解密。请使用保存凭据时的 Windows 用户账户，或移走 data/credentials.enc 后重新配置。', { cause: error });
    }
  }
  get(id) { return this.data[id]; }
  has(id) { return typeof this.data[id] === 'string' && this.data[id].length > 0; }
  set(id, value) {
    if (typeof value !== 'string' || !value) throw new Error('API Key 不能为空');
    return this.modify(data => { data[id] = value; });
  }
  delete(id) { return this.modify(data => { delete data[id]; }); }
  modify(fn) {
    const task = this.pending.catch(() => undefined).then(async () => {
      const next = { ...this.data }; fn(next);
      let ciphertext;
      try { ciphertext = await this.protector.encrypt(JSON.stringify(next)); }
      catch (error) { throw new Error('无法使用 Windows 当前用户加密保存凭据。请确认 Windows 凭据服务可用，或改用环境变量。', { cause: error }); }
      await atomicWrite(join(this.directory, 'credentials.enc'), ciphertext);
      this.data = next;
    });
    this.pending = task;
    return task;
  }
}
