import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const nextRequest = new Map();

function resolveSessionFile(dataDir, storedPath) {
  if (!storedPath) return null;
  return isAbsolute(storedPath) ? storedPath : resolve(dataDir, ...storedPath.split('/'));
}

function portableSessionFile(dataDir, absolutePath) {
  const portable = relative(dataDir, absolutePath);
  if (!portable || portable === '..' || portable.startsWith(`..${sep}`) || isAbsolute(portable)) {
    throw new Error('会话文件不在工作区数据目录中');
  }
  return portable.split(sep).join('/');
}

/**
 * Pi 1.4.0 does not expose a public per-request scheduling hook. Keep the single
 * compatibility seam here, fail loudly on SDK shape changes, and cover it with tests.
 */
export function installRequestPolicy(session, { profile, modelConfig, beforeRequest }) {
  const original = session.agent?.streamFunction;
  if (typeof original !== 'function') {
    throw new Error('Pi SDK 1.4.0 兼容性检查失败：streamFunction 不存在');
  }

  session.agent.streamFunction = async (model, context, options) => {
    beforeRequest();
    const gap = profile.requestGapMs || 0;
    const now = Date.now();
    const scheduledAt = Math.max(now, nextRequest.get(profile.baseUrl) || 0);
    nextRequest.set(profile.baseUrl, scheduledAt + gap);
    if (scheduledAt > now) {
      await delay(scheduledAt - now, undefined, { signal: options?.signal });
    }
    options?.signal?.throwIfAborted();
    beforeRequest(false);
    return original(model, context, { ...options, maxTokens: modelConfig.maxTokens });
  };
}

export async function makeSession({
  modelConfig,
  profile,
  member,
  dataDir,
  dir,
  systemPrompt,
  tools,
  key,
  onEvent,
  beforeRequest = () => {},
}) {
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'),
    refreshOnCreate: false,
  });
  const compat =
    profile.api === 'openai-completions'
      ? { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' }
      : undefined;
  runtime.registerProvider('workspace', {
    baseUrl: profile.baseUrl,
    api: profile.api,
    apiKey: profile.authMode === 'none' ? 'local-no-key' : 'WORKSPACE_UNUSED_KEY',
    authHeader: profile.authMode !== 'none',
    models: [
      {
        id: modelConfig.modelId,
        name: modelConfig.name,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: modelConfig.contextWindow,
        maxTokens: modelConfig.maxTokens,
        ...(compat ? { compat } : {}),
      },
    ],
  });
  await runtime.setRuntimeApiKey('workspace', key || 'local-no-key');
  const model = runtime.getModel('workspace', modelConfig.modelId);
  if (!model) throw new Error('无法加载所选模型');

  const storedFile = resolveSessionFile(dataDir, member.sessionFile);
  if (storedFile && !existsSync(storedFile)) {
    throw new Error(`原会话文件不存在：${member.sessionFile}。已停止恢复，避免静默创建空上下文。`);
  }
  const manager = storedFile ? SessionManager.open(storedFile, dir) : SessionManager.create(dir, dir);

  // Recover the delivery watermark from Pi's durable journal after a crash.
  for (const entry of manager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    const text =
      typeof entry.message.content === 'string'
        ? entry.message.content
        : entry.message.content
            ?.filter(content => content.type === 'text')
            .map(content => content.text)
            .join('');
    const match = text?.match(/^\[workspace-sync:(\d+)\]/);
    if (match) member.cursor = Math.max(member.cursor, Number(match[1]));
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: Math.min(4096, modelConfig.contextWindow / 4),
      keepRecentTokens: Math.min(6000, modelConfig.contextWindow / 3),
    },
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      maxAgentDelayMs: 60_000,
      // Keep provider-internal retries disabled so the AgentSession budget below
      // remains the single, observable three-retry policy.
      provider: { maxRetries: 0, maxRetryDelayMs: 60_000 },
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'off',
    sessionManager: manager,
    resourceLoader,
    settingsManager,
    tools: tools.map(tool => tool.name),
    customTools: tools,
  });
  member.sessionFile = portableSessionFile(dataDir, manager.getSessionFile());
  session.subscribe(onEvent);
  installRequestPolicy(session, { profile, modelConfig, beforeRequest });
  return session;
}
