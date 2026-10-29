import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { renderMarkdown } from '../public/markdown.js';
import { start } from '../server.mjs';
import { Engine } from '../src/engine.mjs';
import { makeSession } from '../src/pi-session.mjs';
import { Store } from '../src/store.mjs';

const testProtector = {
  name: 'Portable test vault',
  async encrypt(text) {
    return Buffer.from(text, 'utf8').toString('base64');
  },
  async decrypt(ciphertext) {
    return Buffer.from(ciphertext, 'base64').toString('utf8');
  },
};

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workspace-'));
  const store = new Store(directory);
  try {
    await run(store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function members(store) {
  store.state.profiles.push({
    id: 'p',
    name: 'Local',
    baseUrl: 'http://127.0.0.1:1/v1',
    api: 'openai-completions',
    authMode: 'none',
    keyEnv: '',
    requestGapMs: 0,
  });
  store.state.models.push(
    {
      id: 'm1',
      profileId: 'p',
      name: 'Model One',
      modelId: 'one',
      contextWindow: 32_000,
      maxTokens: 1024,
      enabled: true,
    },
    {
      id: 'm2',
      profileId: 'p',
      name: 'Model Two',
      modelId: 'two',
      contextWindow: 64_000,
      maxTokens: 2048,
      enabled: true,
    },
  );
  store.state.agents.push(
    { id: 'a', name: 'Alpha', role: '设计', canWrite: true, defaultModelId: 'm1' },
    { id: 'b', name: 'Beta', role: '评审', canWrite: false, defaultModelId: 'm2' },
  );
  return store.createRoom('test', ['a', 'b']);
}

function httpClient(base, state) {
  return async (path, body, headers = {}) => {
    const response = await fetch(`${base}/api/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-Token': state.csrf,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };
}

function splitUtf8Request({ port, path, token, body }) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const needle = Buffer.from('中', 'utf8');
  const characterIndex = payload.indexOf(needle);
  assert(characterIndex >= 0);
  const split = characterIndex + 1;
  const first = payload.subarray(0, split);
  const second = payload.subarray(split);

  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error('raw HTTP request timed out')));
    socket.once('error', reject);
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('end', () => {
      const response = Buffer.concat(chunks).toString('utf8');
      const [head, responseBody] = response.split('\r\n\r\n');
      resolvePromise({ head, responseBody });
    });
    socket.once('connect', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nX-Workspace-Token: ${token}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
      );
      socket.write(`${first.length.toString(16)}\r\n`);
      socket.write(first);
      socket.write('\r\n');
      setImmediate(() => {
        socket.write(`${second.length.toString(16)}\r\n`);
        socket.write(second);
        socket.end('\r\n0\r\n\r\n');
      });
    });
  });
}

test('Legacy snapshot migrates messages, artifacts and effects into row tables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-migrate-'));
  try {
    const database = new DatabaseSync(join(directory, 'workspace.sqlite'));
    database.exec('CREATE TABLE state(id INTEGER PRIMARY KEY, json TEXT NOT NULL)');
    database.prepare('INSERT INTO state VALUES(1, ?)').run(
      JSON.stringify({
        schemaVersion: 2,
        profiles: [
          {
            id: 'p',
            name: 'Old API',
            baseUrl: 'https://example.com/v1',
            api: 'openai-completions',
            authMode: 'api_key',
            keyEnv: '',
            requestGapMs: 0,
          },
        ],
        models: [
          {
            id: 'm',
            profileId: 'p',
            name: 'Old model',
            modelId: 'legacy-model',
            contextWindow: 32_000,
            maxTokens: 1024,
            enabled: true,
          },
        ],
        agents: [
          { id: 'a', name: 'Old A', role: 'review', canWrite: true, defaultModelId: 'm' },
          { id: 'b', name: 'Old B', role: 'design', canWrite: false, defaultModelId: 'm' },
        ],
        rooms: [
          {
            id: 'r',
            title: 'old',
            status: 'idle',
            members: {
              a: { cursor: 0, status: 'idle', sessionFile: 'C:\\old\\sessions\\r\\a\\one.jsonl' },
              b: { cursor: 0, status: 'idle', sessionFile: null },
            },
            messages: [
              { seq: 1, id: 'message', from: 'user', to: null, text: '保留中文', kind: 'chat', time: 1 },
            ],
            tasks: [],
            artifacts: [
              { id: 'artifact', name: 'result.md', content: 'large body', author: 'a', time: 2 },
            ],
            effects: { 'a:call': { content: [{ type: 'text', text: '{"ok":true}' }], details: {} } },
            queue: [],
            activations: 0,
            tokens: 0,
            limits: { activations: 24, tokens: 60_000, concurrency: 1 },
          },
        ],
      }),
    );
    database.close();

    const store = new Store(directory);
    const room = store.room('r');
    assert.equal(store.state.schemaVersion, 3);
    assert.equal(store.listMessages('r').messages[0].text, '保留中文');
    assert.equal(store.artifact('r', 'artifact').content, 'large body');
    assert.equal(store.effect('r', 'a:call').content[0].text, '{"ok":true}');
    assert.equal(room.members.a.sessionFile, 'sessions/r/a/one.jsonl');
    assert.equal(room.messageCount, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM state_backup').get().count, 1);
    const snapshot = store.db.prepare('SELECT json FROM state WHERE id = 1').get().json;
    assert(!snapshot.includes('large body'));
    assert(!snapshot.includes('保留中文'));
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Messages append by row and artifact bodies never re-enter the snapshot', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    const large = 'x'.repeat(24_000);
    store.message(room, 'user', '第一条');
    store.message(room, 'user', '第二条');
    store.saveArtifact(room, { id: 'f', name: 'large.md', content: large, author: 'a', time: 1 });
    store.save();

    const stateJson = store.db.prepare('SELECT json FROM state WHERE id = 1').get().json;
    assert(stateJson.length < 10_000);
    assert(!stateJson.includes(large));
    assert.deepEqual(
      store.listMessages(room.id, { after: 0 }).messages.map(message => message.text),
      ['第一条', '第二条'],
    );

    const recovered = new Store(directory);
    assert.equal(recovered.room(room.id).messageCount, 2);
    assert.equal(recovered.artifact(room.id, 'f').content.length, 24_000);
    recovered.close();
  }));

test('Resume an idle room settles without unsolicited model requests', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    const engine = new Engine(store, directory);
    await engine.control(room, 'resume');
    assert.equal(room.status, 'idle');
    assert.equal(engine.active.size, 0);
  }));

test('Resume preserves both pending peers and interrupted agents', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    const engine = new Engine(store, directory);
    engine.pump = () => {};
    room.status = 'paused';
    room.queue = ['b'];
    room.members.a.status = 'interrupted';
    await engine.control(room, 'resume');
    assert.deepEqual(room.queue, ['b', 'a']);
  }));

test('SQLite recovery marks an in-flight run interrupted without replaying it', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    store.message(room, 'user', 'persist');
    room.status = 'running';
    room.members.a.status = 'running';
    store.save();
    const recovered = new Store(directory);
    assert.equal(recovered.listMessages(room.id).messages[0].text, 'persist');
    assert.equal(recovered.room(room.id).status, 'paused');
    assert.equal(recovered.room(room.id).members.a.status, 'interrupted');
    recovered.close();
  }));

test('Directed messages deduplicate effects and read_artifact does not duplicate its body', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    const engine = new Engine(store, directory);
    engine.pump = () => {};
    room.status = 'running';
    const tools = engine.tools(room, store.agent('a'), { tools: 0, modelId: 'm1' });
    const send = tools.find(tool => tool.name === 'send_message');
    await send.execute('call1', { to: 'b', text: 'review' });
    await send.execute('call1', { to: 'b', text: 'review' });
    assert.deepEqual(room.queue, ['b']);
    assert.equal(store.listMessages(room.id).messages.length, 1);
    assert.equal(store.listMessages(room.id).messages[0].modelId, 'm1');
    await assert.rejects(send.execute('bad', { to: 'missing', text: 'hi' }));
    await assert.rejects(send.execute('self', { to: 'a', text: 'hi' }));

    store.saveArtifact(room, {
      id: 'large',
      name: 'large.md',
      content: 'z'.repeat(24_000),
      author: 'a',
      time: 1,
    });
    const read = tools.find(tool => tool.name === 'read_artifact');
    await read.execute('read-call', { id: 'large' });
    assert.equal(store.effect(room.id, 'a:read-call'), undefined);
  }));

test('Atomic task ownership, immutable artifacts and per-agent capabilities', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    const engine = new Engine(store, directory);
    engine.pump = () => {};
    room.status = 'running';
    const alpha = engine.tools(room, store.agent('a'), { tools: 0, modelId: 'm1' });
    const beta = engine.tools(room, store.agent('b'), { tools: 0, modelId: 'm2' });
    const board = tools => tools.find(tool => tool.name === 'task_board');
    await board(alpha).execute('1', { action: 'create', title: 'Do work' });
    const taskId = room.tasks[0].id;
    await board(alpha).execute('2', { action: 'claim', taskId });
    await assert.rejects(board(beta).execute('3', { action: 'claim', taskId }));
    await assert.rejects(board(beta).execute('4', { action: 'complete', taskId }));
    await board(alpha).execute('5', { action: 'complete', taskId, result: 'Done' });
    assert.equal(room.tasks[0].status, 'done');
    assert(!beta.some(tool => tool.name === 'save_artifact'));
    const save = alpha.find(tool => tool.name === 'save_artifact');
    await save.execute('6', { name: '../../escape.txt', content: 'stored only in SQLite' });
    assert.equal(room.artifacts.length, 1);
    assert.equal(store.artifact(room.id, room.artifacts[0].id).content, 'stored only in SQLite');
  }));

test('Pause and stop gate tools while pause preserves pending work', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    const engine = new Engine(store, directory);
    engine.pump = () => {};
    room.status = 'running';
    engine.enqueue(room, 'a');
    await engine.control(room, 'pause');
    assert.deepEqual(room.queue, ['a']);
    const tool = engine.tools(room, store.agent('a'), { tools: 0, modelId: 'm1' })[0];
    await assert.rejects(tool.execute('1', { to: 'b', text: 'blocked' }));
    await engine.control(room, 'stop');
    assert.deepEqual(room.queue, []);
  }));

test('Pi Session stores a relative path and keeps context across a model switch', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    const member = room.members.a;
    const profile = store.profile('p');
    const first = store.model('m1');
    const second = store.model('m2');
    const sessionDirectory = join(directory, 'sessions', room.id, 'a');
    const base = {
      profile,
      member,
      dataDir: directory,
      dir: sessionDirectory,
      systemPrompt: 'isolated',
      tools: [],
      onEvent: () => {},
    };
    const session = await makeSession({ ...base, modelConfig: first });
    assert.deepEqual(session.getActiveToolNames(), []);
    session.sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '[workspace-sync:7]\ntest' }],
      timestamp: Date.now(),
    });
    session.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'journal fixture' }],
      api: 'openai-completions',
      provider: 'workspace',
      model: 'one',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    session.dispose();
    const file = member.sessionFile;
    assert(!file.includes(directory));
    member.cursor = 0;
    const engine = new Engine(store, directory);
    engine.switchModel(room, 'a', 'm2');
    const reopened = await makeSession({ ...base, modelConfig: second });
    assert.equal(member.cursor, 7);
    assert.equal(member.sessionFile, file);
    assert.equal(member.modelId, 'm2');
    assert.equal(reopened.model.id, 'two');
    assert.equal(reopened.getLastAssistantText(), 'journal fixture');
    reopened.dispose();
  }));

test('Missing persisted Pi Session fails visibly instead of creating an empty context', () =>
  fixture(async (store, directory) => {
    const room = members(store);
    room.members.a.sessionFile = 'sessions/missing/context.jsonl';
    await assert.rejects(
      makeSession({
        modelConfig: store.model('m1'),
        profile: store.profile('p'),
        member: room.members.a,
        dataDir: directory,
        dir: join(directory, 'sessions', room.id, 'a'),
        systemPrompt: 'isolated',
        tools: [],
        onEvent: () => {},
      }),
      /原会话文件不存在/,
    );
  }));

test('Markdown renders common formatting while escaping model-supplied HTML', () => {
  const html = renderMarkdown('# Title\n\n**bold** and `code`\n- item\n<img src=x onerror=alert(1)>');
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>item<\/li><\/ul>/);
  assert(!html.includes('<img'));
  assert(html.includes('&lt;img'));
});

test('SSE sends one snapshot then incremental message and room events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-sse-'));
  let app;
  const controller = new AbortController();
  try {
    app = await start({ port: 0, dataDir: directory, secretProtector: testProtector });
    const room = members(app.store);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/events`, {
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const nextEvent = async () => {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (block.startsWith(':')) continue;
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          return { event, data: data ? JSON.parse(data) : null };
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed before expected event');
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
      }
    };

    assert.equal((await nextEvent()).event, 'snapshot');
    app.engine.post(room, 'user', 'incremental');
    app.engine.change(room);
    const first = await nextEvent();
    const second = await nextEvent();
    assert.deepEqual([first.event, second.event], ['message', 'room']);
    assert.equal(first.data.message.text, 'incremental');
    assert.equal('messages' in second.data.room, false);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    controller.abort();
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP state is lightweight, credentials restart, models switch and rooms delete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-http-'));
  let app;
  try {
    app = await start({ port: 0, dataDir: directory, secretProtector: testProtector });
    let base = `http://127.0.0.1:${app.port}`;
    let state = await fetch(`${base}/api/state`).then(response => response.json());
    let post = httpClient(base, state);
    const secret = 'test-secret-never-return';
    const saved = await post('profiles', {
      name: 'Example',
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      authMode: 'api_key',
      apiKey: secret,
      requestGapMs: 0,
    });
    const profileId = saved.body.id;
    const first = await post('models', {
      profileId,
      name: 'One',
      modelId: 'one',
      contextWindow: 32_000,
      maxTokens: 1024,
      enabled: true,
    });
    const second = await post('models', {
      profileId,
      name: 'Two',
      modelId: 'two',
      contextWindow: 32_000,
      maxTokens: 1024,
      enabled: true,
    });
    const alpha = await post('agents', {
      name: 'A',
      role: 'design',
      defaultModelId: first.body.id,
    });
    const beta = await post('agents', {
      name: 'B',
      role: 'review',
      defaultModelId: first.body.id,
    });
    const created = await post('rooms', {
      title: 'switch',
      agents: [alpha.body.id, beta.body.id],
    });
    app.store.message(app.store.room(created.body.id), 'user', '**markdown**');
    assert.equal(
      (await post('rooms/model', {
        room: created.body.id,
        agent: alpha.body.id,
        modelId: second.body.id,
      })).response.status,
      200,
    );

    const publicStateText = await fetch(`${base}/api/state`).then(response => response.text());
    assert(!publicStateText.includes(secret));
    assert(!publicStateText.includes('**markdown**'));
    assert(!publicStateText.includes('messages'));
    assert(!((await readFile(join(directory, 'workspace.sqlite'))).includes(Buffer.from(secret))));
    assert(!(await readFile(join(directory, 'credentials.enc'), 'utf8')).includes(secret));
    const messages = await fetch(
      `${base}/api/rooms/${created.body.id}/messages?limit=100`,
    ).then(response => response.json());
    assert(messages.messages.some(message => message.text === '**markdown**'));

    await app.close();
    app = undefined;
    app = await start({ port: 0, dataDir: directory, secretProtector: testProtector });
    base = `http://127.0.0.1:${app.port}`;
    state = await fetch(`${base}/api/state`).then(response => response.json());
    post = httpClient(base, state);
    assert.equal(state.profiles.find(profile => profile.id === profileId).hasCredential, true);
    assert.equal(
      state.rooms.find(room => room.id === created.body.id).members[alpha.body.id].modelId,
      second.body.id,
    );
    const switchedMessages = await fetch(
      `${base}/api/rooms/${created.body.id}/messages?limit=100`,
    ).then(response => response.json());
    assert(switchedMessages.messages.some(message => message.kind === 'notice'));

    await post('rooms/remove', { room: created.body.id });
    const afterRemoval = await fetch(`${base}/api/state`).then(response => response.json());
    assert(!afterRemoval.rooms.some(room => room.id === created.body.id));
    assert.equal(
      app.store.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE room_id = ?').get(created.body.id)
        .count,
      0,
    );
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Chunked UTF-8 request preserves a Chinese character split across TCP chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-utf8-'));
  let app;
  try {
    app = await start({ port: 0, dataDir: directory, secretProtector: testProtector });
    const base = `http://127.0.0.1:${app.port}`;
    const state = await fetch(`${base}/api/state`).then(response => response.json());
    const post = httpClient(base, state);
    const profile = await post('profiles', {
      name: 'Local',
      baseUrl: 'http://127.0.0.1:1/v1',
      api: 'openai-completions',
      authMode: 'none',
      requestGapMs: 0,
    });
    const model = await post('models', {
      profileId: profile.body.id,
      name: 'Local',
      modelId: 'local',
      contextWindow: 32_000,
      maxTokens: 1024,
      enabled: true,
    });
    const alpha = await post('agents', { name: 'A', role: 'A', defaultModelId: model.body.id });
    const beta = await post('agents', { name: 'B', role: 'B', defaultModelId: model.body.id });
    const created = await post('rooms', {
      title: 'utf8',
      agents: [alpha.body.id, beta.body.id],
    });
    await post('control', { room: created.body.id, action: 'pause' });
    const text = `${'a'.repeat(7900)}中文结尾`;
    const result = await splitUtf8Request({
      port: app.port,
      path: '/api/message',
      token: state.csrf,
      body: { room: created.body.id, text, to: null },
    });
    assert.match(result.head, / 200 /);
    const messages = app.store.listMessages(created.body.id).messages;
    assert.equal(messages.at(-1).text, text);
    assert(!messages.at(-1).text.includes('\uFFFD'));
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Local shutdown endpoint closes the server and removes its lock gracefully', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-shutdown-'));
  let app;
  try {
    app = await start({ port: 0, dataDir: directory, secretProtector: testProtector });
    const base = `http://127.0.0.1:${app.port}`;
    const state = await fetch(`${base}/api/state`).then(response => response.json());
    const closed = once(app.server, 'close');
    const response = await fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-Token': state.csrf,
      },
      body: '{}',
    });
    assert.equal(response.status, 202);
    await closed;
    await app.close();
    assert.equal(existsSync(join(directory, 'server.lock')), false);
    app = undefined;
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
