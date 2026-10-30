import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './src/engine.mjs';
import { apiEndpoint, integer, readJson, requiredText, sendJson } from './src/http-utils.mjs';
import { acquire } from './src/lock.mjs';
import { SecretStore } from './src/secrets.mjs';
import { id, Store } from './src/store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const applicationName = 'ai-roundtable';

function recommendedGap(baseUrl, authMode) {
  if (authMode === 'none') return 0;
  try {
    if (new URL(baseUrl).hostname.endsWith('agnes-ai.cn')) return 65_000;
  } catch {
    // apiEndpoint will produce the user-facing validation error.
  }
  return 2_000;
}

function publicProfile(profile, secrets) {
  return {
    ...profile,
    hasCredential:
      secrets.has(profile.id) || Boolean(profile.keyEnv && process.env[profile.keyEnv]),
  };
}

export async function start({
  port = Number(process.env.PORT || 4317),
  dataDir = process.env.DATA_DIR || join(root, 'data'),
  secretProtector,
  exitOnShutdown = false,
} = {}) {
  const directory = resolve(dataDir);
  const unlock = acquire(directory);
  let store;
  let secrets;
  try {
    store = new Store(directory);
    secrets = new SecretStore(directory, secretProtector);
    await secrets.init();
  } catch (error) {
    store?.close();
    unlock();
    throw error;
  }

  const clients = new Set();
  const csrf = randomBytes(24).toString('hex');
  const emit = (type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 1_000_000) {
        client.end();
        clients.delete(client);
      } else {
        client.write(payload);
      }
    }
  };
  const engine = new Engine(store, directory, emit, secrets);

  let closePromise;
  let app;
  const assertConfigIdle = () => {
    if (engine.active.size) throw new Error('请先暂停正在运行的 Agent 再修改配置');
  };

  const server = http.createServer(async (request, response) => {
    try {
      const activePort = server.address().port;
      const host = request.headers.host;
      if (![`127.0.0.1:${activePort}`, `localhost:${activePort}`].includes(host)) {
        return sendJson(response, { error: 'Invalid host' }, 403);
      }
      if (
        request.headers.origin &&
        ![`http://127.0.0.1:${activePort}`, `http://localhost:${activePort}`].includes(
          request.headers.origin,
        )
      ) {
        return sendJson(response, { error: 'Invalid origin' }, 403);
      }

      const url = new URL(request.url, `http://${host}`);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );

      if (request.method === 'GET') {
        if (url.pathname === '/api/health') {
          return sendJson(response, { name: applicationName, pid: process.pid, schemaVersion: 3 });
        }
        if (url.pathname === '/api/state') {
          return sendJson(response, { ...engine.publicState(), csrf });
        }
        if (url.pathname === '/api/events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          response.write(`event: snapshot\ndata: ${JSON.stringify(engine.publicState())}\n\n`);
          clients.add(response);
          request.on('close', () => clients.delete(response));
          return;
        }

        const messageMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
        if (messageMatch) {
          const roomId = decodeURIComponent(messageMatch[1]);
          const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
          if (
            (after !== undefined && (!Number.isInteger(after) || after < 0)) ||
            (before !== undefined && (!Number.isInteger(before) || before < 1)) ||
            !Number.isInteger(limit)
          ) {
            throw new Error('消息分页参数无效');
          }
          return sendJson(response, store.listMessages(roomId, { after, before, limit }));
        }

        const artifactMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/artifacts\/([^/]+)$/);
        if (artifactMatch) {
          const roomId = decodeURIComponent(artifactMatch[1]);
          const artifactId = decodeURIComponent(artifactMatch[2]);
          return sendJson(response, store.artifact(roomId, artifactId));
        }

        const files = {
          '/': 'index.html',
          '/app.js': 'app.js',
          '/markdown.js': 'markdown.js',
          '/style.css': 'style.css',
          '/settings.css': 'settings.css',
          '/icon.png': 'icon.png',
        };
        const file = files[url.pathname];
        if (!file) return sendJson(response, { error: 'Not found' }, 404);
        response.setHeader(
          'Content-Type',
          file.endsWith('.png')
            ? 'image/png'
            : file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/html; charset=utf-8',
        );
        response.end(await readFile(join(root, 'public', file)));
        return;
      }

      if (request.method !== 'POST') return sendJson(response, { error: 'Method not allowed' }, 405);
      if (request.headers['x-workspace-token'] !== csrf) {
        return sendJson(response, { error: '请刷新页面重试' }, 403);
      }
      const input = await readJson(request);

      if (url.pathname === '/api/shutdown') {
        sendJson(response, { ok: true, message: '正在优雅停止' }, 202);
        setImmediate(() => void app.close());
        return;
      }

      if (url.pathname === '/api/profiles') {
        assertConfigIdle();
        if (store.state.profiles.length >= 30 && !input.id) throw new Error('最多配置 30 个接入');
        const previous = input.id ? store.profile(input.id) : null;
        const api = input.api || 'openai-completions';
        if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(api)) {
          throw new Error('不支持的协议');
        }
        const authMode = input.authMode || 'api_key';
        if (!['api_key', 'none'].includes(authMode)) throw new Error('认证方式无效');
        if (input.keyEnv && !/^[A-Z][A-Z0-9_]{0,99}$/.test(input.keyEnv)) {
          throw new Error('环境变量名格式不合法');
        }
        const baseUrl = apiEndpoint(input.baseUrl);
        const profile = {
          id: previous?.id || id(),
          name: requiredText(input.name, 80),
          baseUrl,
          api,
          authMode,
          keyEnv: input.keyEnv || '',
          requestGapMs: integer(
            input.requestGapMs,
            previous?.requestGapMs ?? recommendedGap(baseUrl, authMode),
            0,
            300_000,
          ),
        };
        const destinationChanged =
          previous &&
          (previous.baseUrl !== profile.baseUrl ||
            previous.api !== profile.api ||
            previous.authMode !== profile.authMode);
        if (input.apiKey) await secrets.set(profile.id, requiredText(input.apiKey, 4096));
        else if ((authMode === 'none' || destinationChanged) && secrets.has(profile.id)) {
          await secrets.delete(profile.id);
        }
        if (previous) Object.assign(previous, profile);
        else store.state.profiles.push(profile);
        engine.change();
        return sendJson(response, publicProfile(profile, secrets));
      }

      if (url.pathname === '/api/profiles/key') {
        assertConfigIdle();
        const profile = store.profile(input.id);
        await secrets.set(profile.id, requiredText(input.apiKey, 4096));
        engine.change();
        return sendJson(response, { ok: true });
      }

      if (url.pathname === '/api/profiles/logout') {
        assertConfigIdle();
        const profile = store.profile(input.id);
        await secrets.delete(profile.id);
        engine.change();
        return sendJson(response, { ok: true });
      }

      if (url.pathname === '/api/profiles/remove') {
        assertConfigIdle();
        const profile = store.profile(input.id);
        if (store.state.models.some(model => model.profileId === profile.id)) {
          throw new Error('请先删除此接入下的模型');
        }
        store.state.profiles = store.state.profiles.filter(candidate => candidate.id !== profile.id);
        await secrets.delete(profile.id);
        engine.change();
        return sendJson(response, { ok: true });
      }

      if (url.pathname === '/api/profiles/catalog') {
        const profile = store.profile(input.id);
        const apiKey = secrets.get(profile.id) || (profile.keyEnv && process.env[profile.keyEnv]);
        if (profile.authMode !== 'none' && !apiKey) throw new Error('请先保存 API Key');
        const headers = {};
        if (apiKey) {
          if (profile.api === 'anthropic-messages') {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
          } else if (profile.api === 'google-generative-ai') {
            headers['x-goog-api-key'] = apiKey;
          } else {
            headers.Authorization = `Bearer ${apiKey}`;
          }
        }
        const catalogResponse = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/models`, {
          headers,
          signal: AbortSignal.timeout(20_000),
        });
        if (!catalogResponse.ok) throw new Error(`读取模型目录失败：HTTP ${catalogResponse.status}`);
        const catalogBody = await catalogResponse.json();
        const list = Array.isArray(catalogBody.data)
          ? catalogBody.data
          : Array.isArray(catalogBody.models)
            ? catalogBody.models
            : [];
        return sendJson(
          response,
          list
            .map(model => ({
              id: model.id || model.name,
              name: model.displayName || model.name || model.id,
            }))
            .filter(model => model.id)
            .slice(0, 500),
        );
      }

      if (url.pathname === '/api/models') {
        assertConfigIdle();
        if (store.state.models.length >= 100 && !input.id) throw new Error('最多配置 100 个模型');
        const previous = input.id ? store.model(input.id) : null;
        const profile = store.profile(requiredText(input.profileId, 100));
        if (previous && previous.profileId !== profile.id) {
          throw new Error('已有模型不能移动到其他接入，请新建模型');
        }
        const model = {
          id: previous?.id || id(),
          profileId: profile.id,
          name: requiredText(input.name, 100),
          modelId: requiredText(input.modelId, 200),
          contextWindow: integer(input.contextWindow, 32_000, 1024, 2_000_000),
          maxTokens: integer(input.maxTokens, 2048, 64, 200_000),
          enabled: input.enabled !== false,
        };
        if (model.maxTokens >= model.contextWindow) throw new Error('输出上限必须小于上下文长度');
        if (previous) Object.assign(previous, model);
        else store.state.models.push(model);
        engine.change();
        return sendJson(response, model);
      }

      if (url.pathname === '/api/models/remove') {
        assertConfigIdle();
        const model = store.model(input.id);
        const referenced =
          store.state.agents.some(agent => agent.defaultModelId === model.id) ||
          store.state.rooms.some(room =>
            Object.values(room.members).some(member => member.modelId === model.id),
          );
        if (referenced) throw new Error('模型仍被 Agent 或历史工作区使用，不能删除');
        store.state.models = store.state.models.filter(candidate => candidate.id !== model.id);
        engine.change();
        return sendJson(response, { ok: true });
      }

      if (url.pathname === '/api/agents') {
        assertConfigIdle();
        if (store.state.agents.length >= 30 && !input.id) throw new Error('最多配置 30 个 Agent');
        const previous = input.id ? store.agent(input.id) : null;
        const defaultModel = store.model(requiredText(input.defaultModelId, 100));
        if (!defaultModel.enabled) throw new Error('默认模型必须已启用');
        const agent = {
          id: previous?.id || id(),
          name: requiredText(input.name, 60),
          role: requiredText(input.role, 2000),
          canWrite: Boolean(input.canWrite),
          defaultModelId: defaultModel.id,
        };
        if (previous) Object.assign(previous, agent);
        else store.state.agents.push(agent);
        engine.change();
        return sendJson(response, agent);
      }

      if (url.pathname === '/api/agents/remove') {
        assertConfigIdle();
        const agent = store.agent(input.id);
        if (store.state.rooms.some(room => room.members[agent.id])) {
          throw new Error('Agent 被历史工作区引用，无法删除');
        }
        store.state.agents = store.state.agents.filter(candidate => candidate.id !== agent.id);
        engine.change();
        return sendJson(response, { ok: true });
      }

      if (url.pathname === '/api/rooms') {
        if (!Array.isArray(input.agents)) throw new Error('需要 Agent 列表');
        if (store.state.rooms.length >= 100) throw new Error('工作区数量上限');
        const room = store.createRoom(requiredText(input.title, 100), input.agents);
        emit('room', { room: engine.publicRoom(room) });
        return sendJson(response, { id: room.id });
      }

      const room = store.room(input.room);
      if (url.pathname === '/api/rooms/model') {
        engine.switchModel(room, requiredText(input.agent, 100), requiredText(input.modelId, 100));
        return sendJson(response, { ok: true });
      }
      if (url.pathname === '/api/rooms/remove') {
        await engine.removeRoom(room);
        return sendJson(response, { ok: true });
      }
      if (url.pathname === '/api/message') {
        engine.submit(room, requiredText(input.text, 8000), input.to || null);
        return sendJson(response, { ok: true });
      }
      if (url.pathname === '/api/control') {
        if (!['pause', 'resume', 'stop'].includes(input.action)) throw new Error('未知操作');
        await engine.control(room, input.action);
        return sendJson(response, { ok: true });
      }
      if (url.pathname === '/api/limits') {
        room.limits = {
          activations: integer(input.activations, 24, 1, 200),
          tokens: integer(input.tokens, 60_000, 1000, 1_000_000),
          concurrency: integer(input.concurrency, 2, 1, 4),
        };
        engine.change(room);
        engine.pump();
        return sendJson(response, { ok: true });
      }
      if (url.pathname === '/api/rename') {
        room.title = requiredText(input.title, 100);
        engine.change(room);
        return sendJson(response, { ok: true });
      }
      return sendJson(response, { error: 'Not found' }, 404);
    } catch (error) {
      if (!response.headersSent) sendJson(response, { error: error.message }, 400);
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();

  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolvePromise);
    });
  } catch (error) {
    clearInterval(heartbeat);
    store.close();
    unlock();
    throw error;
  }

  app = {
    server,
    engine,
    store,
    secrets,
    port: server.address().port,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(heartbeat);
        await engine.close();
        for (const client of clients) client.end();
        await new Promise(resolvePromise => server.close(resolvePromise));
        store.close();
        unlock();
        if (exitOnShutdown) process.exit(0);
      })();
      return closePromise;
    },
  };
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js 22.19.0 或更高版本才能运行；当前为 ${process.versions.node}`);
  }
  const appInstance = await start({ exitOnShutdown: true });
  console.log(`AI Roundtable: http://127.0.0.1:${appInstance.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await appInstance.close();
      process.exit(0);
    });
  }
}
