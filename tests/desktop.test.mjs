import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { containsWorkspace, migrateLegacyData } from '../desktop/data.mjs';
import { start } from '../server.mjs';

test('Desktop migration gracefully stops the legacy service and preserves its data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workspace-desktop-'));
  const source = join(root, 'legacy-data');
  const target = join(root, 'desktop-data');
  let legacy;
  try {
    legacy = await start({ port: 0, dataDir: source, exitOnShutdown: false });
    await mkdir(join(source, 'sessions'), { recursive: true });
    await writeFile(join(source, 'sessions', 'context.json'), '{"preserved":true}');
    await writeFile(join(source, 'server.log'), 'transient log');

    const migratedFrom = await migrateLegacyData(target, [source], { port: legacy.port });
    assert.equal(migratedFrom, source);
    assert.equal(await containsWorkspace(target), true);
    assert.equal(await readFile(join(target, 'sessions', 'context.json'), 'utf8'), '{"preserved":true}');
    await assert.rejects(readFile(join(target, 'server.lock'), 'utf8'));
    await assert.rejects(readFile(join(target, 'server.log'), 'utf8'));
    legacy = null;
  } finally {
    await legacy?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Desktop migration never overwrites an initialized desktop data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workspace-desktop-existing-'));
  const source = join(root, 'legacy-data');
  const target = join(root, 'desktop-data');
  let sourceApp;
  let targetApp;
  try {
    sourceApp = await start({ port: 0, dataDir: source, exitOnShutdown: false });
    targetApp = await start({ port: 0, dataDir: target, exitOnShutdown: false });
    await sourceApp.close();
    await targetApp.close();
    sourceApp = null;
    targetApp = null;

    assert.equal(await migrateLegacyData(target, [source]), null);
    assert.equal(await containsWorkspace(target), true);
  } finally {
    await sourceApp?.close();
    await targetApp?.close();
    await rm(root, { recursive: true, force: true });
  }
});
