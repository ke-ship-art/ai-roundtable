import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export function acquire(directory) {
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, 'server.lock');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx');
      writeFileSync(descriptor, String(process.pid));
      closeSync(descriptor);
      return () => unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) {
        throw Error('数据目录锁异常；请检查 server.lock');
      }

      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (processError) {
        if (processError.code === 'ESRCH') alive = false;
      }

      if (alive) throw Error('此数据目录已有服务进程；请使用现有服务。');
      unlinkSync(lockPath);
    }
  }

  throw Error('无法取得数据目录锁');
}
