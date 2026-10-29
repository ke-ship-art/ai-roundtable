import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const entropy = Buffer.from('pi-multi-agent-workspace:credentials:v1').toString('base64');
const protectScript = `Add-Type -AssemblyName System.Security;$source=[Console]::In.ReadToEnd().Trim();$plain=[Convert]::FromBase64String($source);$entropy=[Convert]::FromBase64String('${entropy}');$cipher=[System.Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($cipher))`;
const unprotectScript = `Add-Type -AssemblyName System.Security;$source=[Console]::In.ReadToEnd().Trim();$cipher=[Convert]::FromBase64String($source);$entropy=[Convert]::FromBase64String('${entropy}');$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($plain))`;

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function run(command, args, input = '') {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolvePromise(stdout.trimEnd());
      else reject(new Error(`${command} 失败（${code}）：${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

function workspaceAccount(directory) {
  return createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 32);
}

export const windowsProtector = {
  name: 'Windows DPAPI（当前用户）',
  async encrypt(text) {
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    return run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand(protectScript),
    ], encoded);
  },
  async decrypt(ciphertext) {
    const encoded = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand(unprotectScript),
    ], ciphertext);
    return Buffer.from(encoded, 'base64').toString('utf8');
  },
};

function macOSProtector(directory) {
  const account = workspaceAccount(directory);
  const service = 'Pi Workspace credentials';
  return {
    name: 'macOS Keychain',
    async encrypt(text) {
      // Base64 avoids putting raw API keys in the process arguments. The value is
      // still protected by the user's login keychain at rest.
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      await run('/usr/bin/security', [
        'add-generic-password',
        '-a',
        account,
        '-s',
        service,
        '-w',
        encoded,
        '-U',
      ]);
      return JSON.stringify({ backend: 'macos-keychain', account });
    },
    async decrypt(marker) {
      const parsed = JSON.parse(marker);
      if (parsed.backend !== 'macos-keychain' || parsed.account !== account) {
        throw new Error('macOS Keychain 凭据标记不匹配');
      }
      const encoded = await run('/usr/bin/security', [
        'find-generic-password',
        '-a',
        account,
        '-s',
        service,
        '-w',
      ]);
      return Buffer.from(encoded, 'base64').toString('utf8');
    },
  };
}

function linuxProtector(directory) {
  const account = workspaceAccount(directory);
  return {
    name: 'Linux Secret Service',
    async encrypt(text) {
      await run('secret-tool', [
        'store',
        '--label=Pi Workspace credentials',
        'application',
        'pi-workspace',
        'workspace',
        account,
      ], text);
      return JSON.stringify({ backend: 'linux-secret-service', account });
    },
    async decrypt(marker) {
      const parsed = JSON.parse(marker);
      if (parsed.backend !== 'linux-secret-service' || parsed.account !== account) {
        throw new Error('Linux Secret Service 凭据标记不匹配');
      }
      return run('secret-tool', [
        'lookup',
        'application',
        'pi-workspace',
        'workspace',
        account,
      ]);
    },
  };
}

export function defaultProtector(directory) {
  if (process.platform === 'win32') return windowsProtector;
  if (process.platform === 'darwin') return macOSProtector(directory);
  return linuxProtector(directory);
}

async function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', flush: true, mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class SecretStore {
  constructor(directory, protector = defaultProtector(directory)) {
    this.directory = directory;
    this.protector = protector;
    this.name = protector.name || '系统凭据库';
    this.data = {};
    this.pending = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const ciphertext = await readFile(join(this.directory, 'credentials.enc'), 'utf8');
      this.data = JSON.parse(await this.protector.decrypt(ciphertext.trim()));
      if (!this.data || Array.isArray(this.data) || typeof this.data !== 'object') {
        throw new Error('凭据内容格式无效');
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.data = {};
        return;
      }
      throw new Error(
        '凭据无法解密。请使用保存凭据时的操作系统用户，或移走 data/credentials.enc 后重新配置。',
        { cause: error },
      );
    }
  }

  get(id) {
    return this.data[id];
  }

  has(id) {
    return typeof this.data[id] === 'string' && this.data[id].length > 0;
  }

  set(id, value) {
    if (typeof value !== 'string' || !value) throw new Error('API Key 不能为空');
    return this.modify(data => {
      data[id] = value;
    });
  }

  delete(id) {
    return this.modify(data => {
      delete data[id];
    });
  }

  modify(update) {
    const task = this.pending.catch(() => undefined).then(async () => {
      const next = { ...this.data };
      update(next);
      let ciphertext;
      try {
        ciphertext = await this.protector.encrypt(JSON.stringify(next));
      } catch (error) {
        throw new Error(
          `无法使用 ${this.name} 保存凭据。Linux 需要 secret-tool 和可用的 Secret Service；也可改用环境变量。`,
          { cause: error },
        );
      }
      await atomicWrite(join(this.directory, 'credentials.enc'), ciphertext);
      this.data = next;
    });
    this.pending = task;
    return task;
  }
}
