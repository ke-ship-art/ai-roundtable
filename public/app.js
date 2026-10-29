import { escapeHtml, renderMarkdown } from './markdown.js';

const $ = selector => document.querySelector(selector);
const labels = {
  idle: '等待任务',
  running: '协作中',
  paused: '已暂停',
  stopped: '已终止',
  error: '需要处理',
  interrupted: '已中断',
};

let state = { profiles: [], models: [], agents: [], rooms: [] };
let selected = localStorage.getItem('room');
let csrf = '';
let handler;
let streaming = {};
let activity = {};
let catalogProfileId;
let catalogItems = [];
const messageCache = new Map();

const room = () => state.rooms.find(candidate => candidate.id === selected);
const agent = id => state.agents.find(candidate => candidate.id === id);
const profile = id => state.profiles.find(candidate => candidate.id === id);
const model = id => state.models.find(candidate => candidate.id === id);
const name = id =>
  id === 'user' ? '你' : id === 'system' ? '系统' : agent(id)?.name || id;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').style.display = 'block';
  setTimeout(() => {
    $('#toast').style.display = 'none';
  }, 5000);
}

async function api(path, data) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': csrf },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

async function refreshState() {
  const fresh = await fetch('/api/state').then(response => response.json());
  csrf = fresh.csrf;
  state = fresh;
  if (selected && !room()) selected = state.rooms[0]?.id || null;
  render();
}

function upsertRoom(updated) {
  const index = state.rooms.findIndex(candidate => candidate.id === updated.id);
  if (index >= 0) state.rooms[index] = updated;
  else state.rooms.unshift(updated);
}

function mergeConfig(config) {
  state.schemaVersion = config.schemaVersion;
  state.credentialBackend = config.credentialBackend;
  state.profiles = config.profiles;
  state.models = config.models;
  state.agents = config.agents;
}

function modelLabel(id) {
  const selectedModel = model(id);
  return selectedModel
    ? `${selectedModel.name} · ${profile(selectedModel.profileId)?.name || '接入已删除'}`
    : '模型不可用';
}

function messageMarkup(message) {
  const modelName = message.modelId ? model(message.modelId)?.name || '旧模型' : '';
  const target = message.to
    ? ` → ${message.to === 'all' ? '全体成员' : name(message.to)}`
    : '';
  return `<article class="message ${message.from === 'user' ? 'user' : escapeHtml(message.kind)}" data-message-id="${escapeHtml(message.id)}">
    <div class="avatar">${escapeHtml(name(message.from).slice(0, 1))}</div>
    <div class="content">
      <div class="meta">
        <b>${escapeHtml(name(message.from))}</b>
        <span>${new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${modelName ? ` · ${escapeHtml(modelName)}` : ''}${escapeHtml(target)}</span>
      </div>
      <div class="markdown">${renderMarkdown(message.text)}</div>
    </div>
  </article>`;
}

function cacheFor(roomId) {
  if (!messageCache.has(roomId)) {
    messageCache.set(roomId, { items: [], loaded: false, loading: false, hasOlder: false });
  }
  return messageCache.get(roomId);
}

async function ensureMessages(roomId) {
  const cache = cacheFor(roomId);
  if (cache.loaded || cache.loading) return;
  cache.loading = true;
  try {
    const result = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=100`).then(
      response => response.json(),
    );
    if (result.error) throw new Error(result.error);
    cache.items = result.messages;
    cache.hasOlder = result.hasMore;
    cache.loaded = true;
  } finally {
    cache.loading = false;
  }
}

async function catchUpMessages(roomId) {
  const cache = cacheFor(roomId);
  if (!cache.loaded || cache.loading) return;
  let after = cache.items.at(-1)?.seq || 0;
  for (;;) {
    const result = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/messages?after=${after}&limit=500`,
    ).then(response => response.json());
    if (result.error) throw new Error(result.error);
    for (const message of result.messages) {
      if (!cache.items.some(existing => existing.id === message.id)) cache.items.push(message);
    }
    after = cache.items.at(-1)?.seq || after;
    if (!result.hasMore) break;
  }
  if (selected === roomId) renderMessages();
}

async function loadOlderMessages() {
  const cache = cacheFor(selected);
  if (!cache.hasOlder || cache.loading || !cache.items.length) return;
  cache.loading = true;
  const pane = $('.conversation');
  const previousHeight = pane.scrollHeight;
  try {
    const before = cache.items[0].seq;
    const result = await fetch(
      `/api/rooms/${encodeURIComponent(selected)}/messages?before=${before}&limit=100`,
    ).then(response => response.json());
    if (result.error) throw new Error(result.error);
    const known = new Set(cache.items.map(message => message.id));
    cache.items = [...result.messages.filter(message => !known.has(message.id)), ...cache.items];
    cache.hasOlder = result.hasMore;
    renderMessages();
    pane.scrollTop += pane.scrollHeight - previousHeight;
  } catch (error) {
    toast(error.message);
  } finally {
    cache.loading = false;
  }
}

function renderMessages() {
  const container = $('#messages');
  if (!room()) {
    container.replaceChildren();
    return;
  }
  const cache = cacheFor(selected);
  if (!cache.loaded) {
    container.innerHTML = '<p class="empty-note">正在加载消息…</p>';
    return;
  }
  const older = cache.hasOlder
    ? '<button type="button" class="load-older" data-load-older>加载更早消息</button>'
    : '';
  const messages = cache.items.length
    ? cache.items.map(messageMarkup).join('')
    : '<p class="empty-note no-messages">还没有消息。</p>';
  container.innerHTML = older + messages;
}

function appendMessage(roomId, message) {
  const cache = messageCache.get(roomId);
  if (!cache?.loaded || cache.items.some(existing => existing.id === message.id)) return;
  cache.items.push(message);
  if (selected !== roomId) return;

  const container = $('#messages');
  container.querySelector('.no-messages')?.remove();
  const pane = $('.conversation');
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 130;
  container.insertAdjacentHTML('beforeend', messageMarkup(message));
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

async function select(roomId) {
  selected = roomId || null;
  if (selected) localStorage.setItem('room', selected);
  else localStorage.removeItem('room');
  render();
  renderMessages();
  if (!selected) return;
  try {
    await ensureMessages(selected);
    if (selected === roomId) renderMessages();
  } catch (error) {
    toast(error.message);
  }
}

function render() {
  const activeRoom = room();
  $('#rooms').innerHTML = state.rooms
    .map(
      item => `<button data-room="${escapeHtml(item.id)}" class="${item.id === selected ? 'selected' : ''}">
        ◈ ${escapeHtml(item.title)}
        <small>${Object.keys(item.members).length} 个成员 · ${labels[item.status]}</small>
      </button>`,
    )
    .join('');
  $('#roomCount').textContent = state.rooms.length;
  $('#title').textContent = activeRoom?.title || '让不同的思考，一起向前。';
  $('#status').textContent = labels[activeRoom?.status] || '准备就绪';
  $('#welcome').hidden = Boolean(activeRoom);
  $('#composer').hidden = !activeRoom;
  $('#messages').hidden = !activeRoom;

  for (const id of ['pause', 'resume', 'stop', 'limits', 'deleteRoom']) {
    $(`#${id}`).disabled = !activeRoom;
  }
  if (!activeRoom) {
    $('#members').innerHTML = '<p class="empty-note">每位 Agent 都有独立身份与上下文。</p>';
    $('#tasks').textContent = '任务会在 Agent 创建后出现在这里。';
    $('#artifacts').textContent = '等待团队交付第一份成果。';
    renderMessages();
    return;
  }

  const recipient = $('#recipient').value;
  $('#recipient').innerHTML =
    '<option value="">@ 全体成员</option>' +
    Object.keys(activeRoom.members)
      .map(agentId => `<option value="${escapeHtml(agentId)}">@ ${escapeHtml(name(agentId))}</option>`)
      .join('');
  $('#recipient').value = recipient;

  const enabled = state.models.filter(item => item.enabled && profile(item.profileId));
  $('#members').innerHTML = Object.entries(activeRoom.members)
    .map(
      ([agentId, member]) => `<div class="member">
        <div class="avatar">${escapeHtml(name(agentId).slice(0, 1))}</div>
        <div class="member-info">
          <strong>${escapeHtml(name(agentId))}</strong>
          <select class="member-model" data-member-model="${escapeHtml(agentId)}" aria-label="切换 ${escapeHtml(name(agentId))} 的模型" ${member.status === 'running' ? 'disabled' : ''}>
            ${enabled.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === member.modelId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(profile(item.profileId)?.name)}</option>`).join('')}
          </select>
          <small>${labels[member.status]} · 已同步 #${member.cursor}</small>
          ${member.error ? `<small class="member-error">${escapeHtml(member.error)}</small>` : ''}
        </div>
      </div>`,
    )
    .join('');

  $('#tasks').innerHTML = activeRoom.tasks.length
    ? activeRoom.tasks
        .map(
          task => `<div class="task">${task.status === 'done' ? '✓' : task.status === 'working' ? '◉' : '○'} ${escapeHtml(task.title)}
            <div class="hint">${task.owner ? escapeHtml(name(task.owner)) : '待领取'}${task.result ? ` · ${escapeHtml(task.result)}` : ''}</div>
          </div>`,
        )
        .join('')
    : '还没有任务。Agent 可自行创建和领取。';
  $('#taskCount').textContent = activeRoom.tasks.length;
  $('#artifacts').innerHTML = activeRoom.artifacts.length
    ? activeRoom.artifacts
        .map(
          artifact => `<button class="artifact" data-artifact="${escapeHtml(artifact.id)}">↗ ${escapeHtml(artifact.name)}
            <div class="hint">${escapeHtml(name(artifact.author))}</div>
          </button>`,
        )
        .join('')
    : '等待团队交付第一份成果。';
  $('#usage').textContent = `激活 ${activeRoom.activations} / ${activeRoom.limits.activations} · Token ${activeRoom.tokens.toLocaleString()} / ${activeRoom.limits.tokens.toLocaleString()} · 并发 ${activeRoom.limits.concurrency}`;
  renderStreams();
}

function renderStreams() {
  $('#streams').textContent =
    Object.entries(activity)
      .filter(([key]) => key.startsWith(`${selected}:`))
      .map(([key, value]) => `${name(key.slice(selected.length + 1))} · ${value}\n`)
      .join('') +
    Object.entries(streaming)
      .filter(([key]) => key.startsWith(`${selected}:`))
      .map(
        ([key, value]) => `${name(key.slice(selected.length + 1))} 正在输出…\n${value}`,
      )
      .join('\n\n');
}

function modal(title, body, submit, label = '保存') {
  handler = submit;
  $('#dialogTitle').textContent = title;
  $('#dialogBody').innerHTML = body;
  $('#dialogSubmit').textContent = label;
  $('#dialogSubmit').hidden = !submit;
  $('#formError').textContent = '';
  if (!$('#dialog').open) $('#dialog').showModal();
}

const field = (name, label, value = '', type = 'text', required = true) =>
  `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? 'required' : ''}></label>`;
const option = (value, label, selectedOption = false) =>
  `<option value="${escapeHtml(value)}" ${selectedOption ? 'selected' : ''}>${escapeHtml(label)}</option>`;

async function saveConfig(path, data) {
  const result = await api(path, data);
  await refreshState();
  return result;
}

function profileForm(item = {}) {
  const defaultGap = item.requestGapMs ?? (item.baseUrl?.includes('agnes-ai.cn') || !item.id ? 65_000 : 2_000);
  modal(
    item.id ? '编辑接入' : '新增接入',
    `${field('name', '配置名称', item.name || 'Agnes API')}
    ${field('baseUrl', 'API 基础地址', item.baseUrl || 'https://api.agnes-ai.cn/v1')}
    <div class="fields">
      <label>API 协议<select name="api">${[
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai',
      ].map(value => option(value, value, item.api === value)).join('')}</select></label>
      <label>认证方式<select name="authMode">
        ${option('api_key', 'API Key', item.authMode !== 'none')}
        ${option('none', '本地服务，无需密钥', item.authMode === 'none')}
      </select></label>
    </div>
    <label>API Key<input name="apiKey" type="password" autocomplete="off" placeholder="${item.hasCredential ? `已由 ${escapeHtml(state.credentialBackend)} 保存；留空保留` : '输入后安全保存'}"></label>
    ${field('keyEnv', '或环境变量名称（可选）', item.keyEnv || '', 'text', false)}
    ${field('requestGapMs', '同一地址请求间隔（毫秒）', defaultGap, 'number')}
    <p class="hint">凭据后端：${escapeHtml(state.credentialBackend || '系统凭据库')}。Agnes 默认 65,000ms；其他远程服务建议至少 2,000ms。系统还会对 429 和瞬时错误做最多 3 次指数退避。修改 API 地址、协议或认证方式时必须重新输入密钥。</p>`,
    form =>
      saveConfig('profiles', {
        ...Object.fromEntries(form),
        id: item.id,
        requestGapMs: Number(form.get('requestGapMs')),
      }),
  );
}

function modelForm(item = {}) {
  if (!state.profiles.length) {
    toast('请先新增接入配置');
    profileForm();
    return;
  }
  const profileId = item.profileId || catalogProfileId || state.profiles[0].id;
  modal(
    item.id ? '编辑模型' : '添加模型',
    `<label>所属接入<select name="profileId">${state.profiles.map(candidate => option(candidate.id, candidate.name, candidate.id === profileId)).join('')}</select></label>
    <div class="fields">
      ${field('name', '显示名称', item.name || item.modelId || '新模型')}
      ${field('modelId', '模型 ID', item.modelId || 'agnes-2.5-flash')}
    </div>
    <div class="fields">
      ${field('contextWindow', '上下文长度', item.contextWindow || 32_000, 'number')}
      ${field('maxTokens', '输出上限', item.maxTokens || 2048, 'number')}
    </div>
    <label><input name="enabled" type="checkbox" ${item.enabled !== false ? 'checked' : ''}>在工作区模型菜单中启用</label>`,
    form =>
      saveConfig('models', {
        ...Object.fromEntries(form),
        id: item.id,
        contextWindow: Number(form.get('contextWindow')),
        maxTokens: Number(form.get('maxTokens')),
        enabled: form.has('enabled'),
      }),
  );
}

function agentForm(item = {}) {
  if (!state.models.some(candidate => candidate.enabled)) {
    toast('请先添加并启用模型');
    modelForm();
    return;
  }
  modal(
    item.id ? '编辑 Agent 身份' : '添加 Agent 身份',
    `${field('name', '名称', item.name || '研究员')}
    ${field('role', '职责', item.role || '分析任务、提出方案，并向队友请求独立检查')}
    <label>新工作区默认模型<select name="defaultModelId">${state.models
      .filter(candidate => candidate.enabled)
      .map(candidate => option(candidate.id, modelLabel(candidate.id), candidate.id === (item.defaultModelId || state.models.find(modelItem => modelItem.enabled)?.id)))
      .join('')}</select></label>
    <label><input name="canWrite" type="checkbox" ${item.canWrite ? 'checked' : ''}>允许保存文本成果</label>`,
    form =>
      saveConfig('agents', {
        ...Object.fromEntries(form),
        id: item.id,
        canWrite: form.has('canWrite'),
      }),
  );
}

function manage() {
  const profiles = state.profiles.length
    ? state.profiles
        .map(
          item => `<div class="agent-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.api)} · ${item.hasCredential || item.authMode === 'none' ? '凭据已就绪' : '未保存凭据'}</small></div><div>
            <button type="button" data-profile-edit="${escapeHtml(item.id)}">编辑</button>
            <button type="button" data-profile-key="${escapeHtml(item.id)}">密钥</button>
            ${item.hasCredential ? `<button type="button" data-profile-logout="${escapeHtml(item.id)}">清除密钥</button>` : ''}
            <button type="button" data-profile-catalog="${escapeHtml(item.id)}">模型目录</button>
            <button type="button" data-profile-remove="${escapeHtml(item.id)}">删除</button>
          </div></div>`,
        )
        .join('')
    : '<p class="empty-note">先添加模型服务的地址和凭据。</p>';
  const models = state.models.length
    ? state.models
        .map(
          item => `<div class="agent-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.modelId)} · ${escapeHtml(profile(item.profileId)?.name || '接入缺失')} · ${item.enabled ? '已启用' : '已停用'}</small></div><div>
            <button type="button" data-model-edit="${escapeHtml(item.id)}">编辑</button>
            <button type="button" data-model-remove="${escapeHtml(item.id)}">删除</button>
          </div></div>`,
        )
        .join('')
    : '<p class="empty-note">接入配置保存后，再添加模型。</p>';
  const agents = state.agents.length
    ? state.agents
        .map(
          item => `<div class="agent-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(modelLabel(item.defaultModelId))}</small></div><div>
            <button type="button" data-agent-edit="${escapeHtml(item.id)}">编辑</button>
            <button type="button" data-agent-copy="${escapeHtml(item.id)}">复制</button>
            <button type="button" data-agent-remove="${escapeHtml(item.id)}">删除</button>
          </div></div>`,
        )
        .join('')
    : '<p class="empty-note">模型就绪后，创建具有独立职责的 Agent 身份。</p>';
  modal(
    '配置中心',
    `<section class="manage-section"><div class="section-label">1 · 接入配置 <button type="button" id="createProfile">＋ 新增接入</button></div>${profiles}</section>
    <section class="manage-section"><div class="section-label">2 · 模型 <button type="button" id="createModel">＋ 添加模型</button></div>${models}</section>
    <section class="manage-section"><div class="section-label">3 · Agent 身份 <button type="button" id="createAgent">＋ 添加 Agent</button></div>${agents}</section>
    <p class="hint">凭据后端：${escapeHtml(state.credentialBackend || '系统凭据库')}。历史工作区引用的配置不会被误删。</p>`,
    null,
  );
}

function catalog(profileId, items) {
  catalogProfileId = profileId;
  catalogItems = items;
  modal(
    '供应商模型目录',
    items.length
      ? `<p class="hint">已读取 ${items.length} 个模型。点击一项添加到工作区。</p><div class="catalog-list">${items.map((item, index) => `<button type="button" data-catalog-index="${index}"><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(item.id)}</small></button>`).join('')}</div>`
      : '<p class="empty-note">服务返回了空模型目录，请手动添加模型 ID。</p>',
    null,
  );
}

$('#dialogForm').onsubmit = async event => {
  event.preventDefault();
  if (!handler) return;
  $('#dialogSubmit').disabled = true;
  try {
    await handler(new FormData(event.target));
    $('#dialog').close();
  } catch (error) {
    $('#formError').textContent = error.message;
  } finally {
    $('#dialogSubmit').disabled = false;
  }
};
$('#closeDialog').onclick = () => $('#dialog').close();

$('#dialogBody').onclick = async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'createProfile') profileForm();
  if (button.id === 'createModel') modelForm();
  if (button.id === 'createAgent') agentForm();
  if (button.dataset.profileEdit) profileForm(profile(button.dataset.profileEdit));
  if (button.dataset.profileKey) {
    const item = profile(button.dataset.profileKey);
    modal(
      '更新长期保存的 API Key',
      `${field('apiKey', 'API Key', '', 'password')}<p class="hint">密钥使用 ${escapeHtml(state.credentialBackend)} 保存，重启后仍可使用。</p>`,
      form => saveConfig('profiles/key', { id: item.id, apiKey: form.get('apiKey') }),
    );
  }
  if (button.dataset.profileLogout) {
    try {
      await saveConfig('profiles/logout', { id: button.dataset.profileLogout });
      manage();
    } catch (error) {
      toast(error.message);
    }
  }
  if (button.dataset.profileCatalog) {
    try {
      catalog(
        button.dataset.profileCatalog,
        await api('profiles/catalog', { id: button.dataset.profileCatalog }),
      );
    } catch (error) {
      toast(error.message);
    }
  }
  if (button.dataset.profileRemove) {
    try {
      await saveConfig('profiles/remove', { id: button.dataset.profileRemove });
      manage();
    } catch (error) {
      toast(error.message);
    }
  }
  if (button.dataset.modelEdit) modelForm(model(button.dataset.modelEdit));
  if (button.dataset.modelRemove) {
    try {
      await saveConfig('models/remove', { id: button.dataset.modelRemove });
      manage();
    } catch (error) {
      toast(error.message);
    }
  }
  if (button.dataset.agentEdit) agentForm(agent(button.dataset.agentEdit));
  if (button.dataset.agentCopy) {
    agentForm({
      ...agent(button.dataset.agentCopy),
      id: undefined,
      name: `${name(button.dataset.agentCopy)} 副本`,
    });
  }
  if (button.dataset.agentRemove) {
    try {
      await saveConfig('agents/remove', { id: button.dataset.agentRemove });
      manage();
    } catch (error) {
      toast(error.message);
    }
  }
  if (button.dataset.catalogIndex !== undefined) {
    const item = catalogItems[Number(button.dataset.catalogIndex)];
    modelForm({
      profileId: catalogProfileId,
      name: item.name || item.id,
      modelId: item.id,
      enabled: true,
    });
  }
};

for (const id of ['manage', 'addAgent', 'setup']) $(`#${id}`).onclick = manage;

$('#newRoom').onclick = () => {
  if (state.agents.length < 2) {
    toast('请先配置至少两个 Agent');
    manage();
    return;
  }
  modal(
    '新建协作工作区',
    `${field('title', '工作区名称', '新的协作任务')}
    <label>选择 2–8 位成员</label>
    ${state.agents.map(item => `<label><input name="agents" value="${escapeHtml(item.id)}" type="checkbox" checked>${escapeHtml(item.name)} · ${escapeHtml(model(item.defaultModelId)?.name || '模型缺失')}</label>`).join('')}
    <p class="hint">简单任务可在发送时只指定一位成员，避免不必要的多 Agent Token 消耗。</p>`,
    async form => {
      const created = await api('rooms', {
        title: form.get('title'),
        agents: form.getAll('agents'),
      });
      await refreshState();
      await select(created.id);
    },
    '创建工作区',
  );
};

$('#rooms').onclick = event => {
  const button = event.target.closest('[data-room]');
  if (button) void select(button.dataset.room);
};

$('#messages').onclick = event => {
  if (event.target.closest('[data-load-older]')) void loadOlderMessages();
};

$('#members').onchange = async event => {
  const selection = event.target.closest('[data-member-model]');
  if (!selection) return;
  selection.disabled = true;
  try {
    await api('rooms/model', {
      room: selected,
      agent: selection.dataset.memberModel,
      modelId: selection.value,
    });
  } catch (error) {
    toast(error.message);
    render();
  }
};

$('#composer').onsubmit = async event => {
  event.preventDefault();
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !room()) return;
  try {
    await api('message', { room: selected, text, to: $('#recipient').value });
    input.value = '';
  } catch (error) {
    toast(error.message);
  }
};

$('#input').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
};

for (const action of ['pause', 'resume', 'stop']) {
  $(`#${action}`).onclick = () => api('control', { room: selected, action }).catch(error => toast(error.message));
}

$('#deleteRoom').onclick = async () => {
  const activeRoom = room();
  if (!activeRoom) return;
  if (!confirm(`确定删除工作区“${activeRoom.title}”吗？\n\n共享消息、任务、成果和 Pi Session 都会被删除，此操作无法撤销。`)) return;
  try {
    await api('rooms/remove', { room: activeRoom.id });
    messageCache.delete(activeRoom.id);
    state.rooms = state.rooms.filter(candidate => candidate.id !== activeRoom.id);
    await select(state.rooms[0]?.id || null);
  } catch (error) {
    toast(error.message);
  }
};

$('#limits').onclick = () => {
  const activeRoom = room();
  modal(
    '调整运行预算',
    `${field('activations', '最大激活次数', activeRoom.limits.activations, 'number')}
    ${field('tokens', 'Token 预算', activeRoom.limits.tokens, 'number')}
    ${field('concurrency', '工作区并发数（1–4）', activeRoom.limits.concurrency, 'number')}
    <p class="hint">Token 是服务商上报的累计用量。简单任务建议定向发给一位 Agent，只在需要独立检查时唤醒队友。</p>`,
    form =>
      api('limits', {
        room: selected,
        ...Object.fromEntries([...form].map(([key, value]) => [key, Number(value)])),
      }),
  );
};

$('#artifacts').onclick = async event => {
  const artifactId = event.target.closest('[data-artifact]')?.dataset.artifact;
  if (!artifactId || !room()) return;
  try {
    const artifact = await fetch(
      `/api/rooms/${encodeURIComponent(selected)}/artifacts/${encodeURIComponent(artifactId)}`,
    ).then(response => response.json());
    if (artifact.error) throw new Error(artifact.error);
    modal(
      artifact.name,
      `<div class="artifact-content markdown">${renderMarkdown(artifact.content)}</div>`,
      () => {
        const link = document.createElement('a');
        const url = URL.createObjectURL(new Blob([artifact.content], { type: 'text/plain' }));
        link.href = url;
        link.download = artifact.name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      '下载文本',
    );
  } catch (error) {
    toast(error.message);
  }
};

const initial = await fetch('/api/state').then(response => response.json());
csrf = initial.csrf;
state = initial;
if (!room()) selected = state.rooms[0]?.id || null;
render();
await select(selected);

const source = new EventSource('/api/events');
source.onopen = () => {
  $('#connection').textContent = '本地服务已连接';
};
source.onerror = () => {
  $('#connection').textContent = '连接中断，正在重连';
  streaming = {};
  activity = {};
  renderStreams();
  refreshState()
    .then(() => (selected ? catchUpMessages(selected) : undefined))
    .catch(() => undefined);
};
source.addEventListener('snapshot', event => {
  const snapshot = JSON.parse(event.data);
  state = { ...snapshot, csrf };
  if (selected && !room()) selected = state.rooms[0]?.id || null;
  render();
  if (selected) void catchUpMessages(selected);
});
source.addEventListener('config', event => {
  mergeConfig(JSON.parse(event.data));
  render();
});
source.addEventListener('room', event => {
  const updated = JSON.parse(event.data).room;
  upsertRoom(updated);
  render();
  const cache = messageCache.get(updated.id);
  if (updated.id === selected && cache?.loaded && updated.lastMessageSeq > (cache.items.at(-1)?.seq || 0)) {
    void catchUpMessages(updated.id);
  }
});
source.addEventListener('room_removed', event => {
  const { id: roomId } = JSON.parse(event.data);
  state.rooms = state.rooms.filter(candidate => candidate.id !== roomId);
  messageCache.delete(roomId);
  if (selected === roomId) void select(state.rooms[0]?.id || null);
  else render();
});
source.addEventListener('delta', event => {
  const delta = JSON.parse(event.data);
  const key = `${delta.room}:${delta.agent}`;
  streaming[key] = (streaming[key] || '') + delta.text;
  renderStreams();
});
source.addEventListener('stream_end', event => {
  const ended = JSON.parse(event.data);
  delete streaming[`${ended.room}:${ended.agent}`];
  delete activity[`${ended.room}:${ended.agent}`];
  renderStreams();
});
source.addEventListener('message', event => {
  const payload = JSON.parse(event.data);
  appendMessage(payload.room, payload.message);
});
source.addEventListener('activity', event => {
  const update = JSON.parse(event.data);
  activity[`${update.room}:${update.agent}`] = `正在执行 ${update.tool}`;
  renderStreams();
});
