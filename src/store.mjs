import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const id = () => randomUUID();

function cleanSessionPath(dataDir, value) {
  if (!value || !isAbsolute(value)) return value || null;

  const local = relative(dataDir, value);
  if (local && !local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local)) {
    return local.split(sep).join('/');
  }

  const parts = value.split(/[\\/]+/);
  const sessionsIndex = parts.lastIndexOf('sessions');
  if (sessionsIndex >= 0) {
    const portable = parts.slice(sessionsIndex).join('/');
    if (existsSync(join(dataDir, ...portable.split('/')))) return portable;
    // Preserve the portable target even when it is currently missing. The session
    // adapter will report missing context rather than silently starting over.
    return portable;
  }

  return value;
}

function artifactMetadata(artifact) {
  const { content: _content, ...metadata } = artifact;
  return metadata;
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'workspace.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS state(
        id INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_backup(
        createdAt INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages(
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        json TEXT NOT NULL,
        PRIMARY KEY(room_id, seq)
      );
      CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id, seq);
      CREATE TABLE IF NOT EXISTS artifacts(
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY(room_id, id)
      );
      CREATE TABLE IF NOT EXISTS effects(
        room_id TEXT NOT NULL,
        effect_key TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(room_id, effect_key)
      );
    `);

    const row = this.db.prepare('SELECT json FROM state WHERE id = 1').get();
    this.state = row
      ? JSON.parse(row.json)
      : { schemaVersion: 3, agents: [], profiles: [], models: [], rooms: [] };

    if (row && (this.state.schemaVersion || 1) < 3) {
      this.db.prepare('INSERT INTO state_backup VALUES(?, ?)').run(Date.now(), row.json);
    }

    this.migrateToV2();
    this.migrateToV3();
    this.restoreRuntimeState();
    this.save();
  }

  migrateToV2() {
    this.state.agents ||= [];
    this.state.rooms ||= [];
    this.state.profiles ||= [];
    this.state.models ||= [];
    if ((this.state.schemaVersion || 1) >= 2) return;

    const agents = [];
    for (const legacy of this.state.agents) {
      let defaultModelId = legacy.defaultModelId;
      if (!defaultModelId) {
        const profileId = id();
        defaultModelId = id();
        this.state.profiles.push({
          id: profileId,
          name: `${legacy.name} 接入`,
          baseUrl: legacy.baseUrl,
          api: legacy.api || 'openai-completions',
          authMode: legacy.keyEnv
            ? 'api_key'
            : legacy.baseUrl?.startsWith('http://127.0.0.1')
              ? 'none'
              : 'api_key',
          keyEnv: legacy.keyEnv || '',
          requestGapMs: legacy.requestGapMs || 0,
        });
        this.state.models.push({
          id: defaultModelId,
          profileId,
          name: legacy.model,
          modelId: legacy.model,
          contextWindow: legacy.contextWindow || 32000,
          maxTokens: legacy.maxTokens || 2048,
          enabled: true,
        });
      }
      agents.push({
        id: legacy.id,
        name: legacy.name,
        role: legacy.role,
        canWrite: Boolean(legacy.canWrite),
        defaultModelId,
      });
    }
    this.state.agents = agents;
    this.state.schemaVersion = 2;
  }

  migrateToV3() {
    if (this.state.schemaVersion >= 3) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const room of this.state.rooms) {
        for (const message of room.messages || []) {
          this.db
            .prepare('INSERT OR IGNORE INTO messages(room_id, seq, id, json) VALUES(?, ?, ?, ?)')
            .run(room.id, message.seq, message.id, JSON.stringify(message));
        }
        for (const artifact of room.artifacts || []) {
          this.db
            .prepare('INSERT OR IGNORE INTO artifacts(room_id, id, json, content) VALUES(?, ?, ?, ?)')
            .run(room.id, artifact.id, JSON.stringify(artifactMetadata(artifact)), artifact.content || '');
        }
        for (const [effectKey, result] of Object.entries(room.effects || {})) {
          this.db
            .prepare('INSERT OR IGNORE INTO effects(room_id, effect_key, json) VALUES(?, ?, ?)')
            .run(room.id, effectKey, JSON.stringify(result));
        }

        delete room.messages;
        delete room.effects;
        room.artifacts = (room.artifacts || []).map(artifactMetadata);
      }
      this.state.schemaVersion = 3;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  restoreRuntimeState() {
    for (const room of this.state.rooms) {
      const messageStats = this.db
        .prepare('SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS lastSeq FROM messages WHERE room_id = ?')
        .get(room.id);
      room.messageCount = Number(messageStats.count);
      room.lastMessageSeq = Number(messageStats.lastSeq);
      room.artifacts = this.db
        .prepare('SELECT json FROM artifacts WHERE room_id = ? ORDER BY rowid')
        .all(room.id)
        .map(row => JSON.parse(row.json));
      room.tasks ||= [];
      room.queue ||= [];

      if (room.status === 'running') room.status = 'paused';
      for (const [agentId, member] of Object.entries(room.members)) {
        if (member.status === 'running') {
          member.status = 'interrupted';
          member.error = '服务已重启；请确认成果后继续。';
        }
        member.modelId ||= this.agent(agentId).defaultModelId;
        member.sessionFile = cleanSessionPath(this.directory, member.sessionFile);
      }
    }
  }

  snapshot() {
    return {
      ...this.state,
      rooms: this.state.rooms.map(room => {
        const { messages: _messages, effects: _effects, ...metadata } = room;
        return {
          ...metadata,
          artifacts: (room.artifacts || []).map(artifactMetadata),
        };
      }),
    };
  }

  save() {
    this.db
      .prepare('INSERT OR REPLACE INTO state VALUES(1, ?)')
      .run(JSON.stringify(this.snapshot()));
  }

  room(roomId) {
    const room = this.state.rooms.find(candidate => candidate.id === roomId);
    if (!room) throw new Error('工作区不存在');
    return room;
  }

  agent(agentId) {
    const agent = this.state.agents.find(candidate => candidate.id === agentId);
    if (!agent) throw new Error('Agent 不存在');
    return agent;
  }

  profile(profileId) {
    const profile = this.state.profiles.find(candidate => candidate.id === profileId);
    if (!profile) throw new Error('接入配置不存在');
    return profile;
  }

  model(modelId) {
    const model = this.state.models.find(candidate => candidate.id === modelId);
    if (!model) throw new Error('模型不存在');
    return model;
  }

  createRoom(title, agentIds, limits = {}) {
    if (agentIds.length < 2 || agentIds.length > 8 || new Set(agentIds).size !== agentIds.length) {
      throw new Error('请选择 2–8 个不同 Agent');
    }
    const members = Object.fromEntries(
      agentIds.map(agentId => {
        const agent = this.agent(agentId);
        this.model(agent.defaultModelId);
        return [
          agentId,
          { cursor: 0, status: 'idle', sessionFile: null, modelId: agent.defaultModelId },
        ];
      }),
    );
    const room = {
      id: id(),
      title: title.slice(0, 100),
      createdAt: Date.now(),
      members,
      tasks: [],
      artifacts: [],
      queue: [],
      status: 'idle',
      activations: 0,
      tokens: 0,
      messageCount: 0,
      lastMessageSeq: 0,
      limits: { activations: 24, tokens: 60000, concurrency: 2, ...limits },
    };
    this.state.rooms.unshift(room);
    this.save();
    return room;
  }

  message(room, from, text, kind = 'chat', to = null, extra = {}) {
    const message = {
      seq: room.lastMessageSeq + 1,
      id: id(),
      from,
      to,
      text,
      kind,
      time: Date.now(),
      ...extra,
    };
    this.db
      .prepare('INSERT INTO messages(room_id, seq, id, json) VALUES(?, ?, ?, ?)')
      .run(room.id, message.seq, message.id, JSON.stringify(message));
    room.lastMessageSeq = message.seq;
    room.messageCount += 1;
    return message;
  }

  listMessages(roomId, { after, before, limit = 100 } = {}) {
    this.room(roomId);
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    let rows;
    let direction;
    if (Number.isInteger(after) && after >= 0) {
      rows = this.db
        .prepare('SELECT json FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
        .all(roomId, after, safeLimit + 1);
      direction = 'newer';
    } else {
      const upperBound = Number.isInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
      rows = this.db
        .prepare('SELECT json FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(roomId, upperBound, safeLimit + 1);
      direction = 'older';
    }

    const hasMore = rows.length > safeLimit;
    const selected = rows.slice(0, safeLimit).map(row => JSON.parse(row.json));
    if (direction === 'older') selected.reverse();
    return { messages: selected, hasMore, direction };
  }

  messagesAfter(roomId, cursor, maxCharacters = 18_000) {
    const rows = this.db
      .prepare('SELECT json FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT 501')
      .all(roomId, cursor);
    const messages = [];
    let size = 0;
    for (const row of rows) {
      const message = JSON.parse(row.json);
      const length = row.json.length;
      if (size + length > maxCharacters && messages.length) break;
      messages.push(message);
      size += length;
    }
    const finalSequence = messages.at(-1)?.seq || cursor;
    return {
      messages,
      hasMore: rows.length > messages.length || finalSequence < this.room(roomId).lastMessageSeq,
    };
  }

  saveArtifact(room, artifact) {
    const metadata = artifactMetadata(artifact);
    this.db
      .prepare('INSERT INTO artifacts(room_id, id, json, content) VALUES(?, ?, ?, ?)')
      .run(room.id, artifact.id, JSON.stringify(metadata), artifact.content);
    room.artifacts.push(metadata);
    return metadata;
  }

  artifact(roomId, artifactId) {
    this.room(roomId);
    const row = this.db
      .prepare('SELECT json, content FROM artifacts WHERE room_id = ? AND id = ?')
      .get(roomId, artifactId);
    if (!row) throw new Error('成果不存在');
    return { ...JSON.parse(row.json), content: row.content };
  }

  effect(roomId, effectKey) {
    const row = this.db
      .prepare('SELECT json FROM effects WHERE room_id = ? AND effect_key = ?')
      .get(roomId, effectKey);
    return row ? JSON.parse(row.json) : undefined;
  }

  saveEffect(roomId, effectKey, result) {
    this.db
      .prepare('INSERT OR REPLACE INTO effects(room_id, effect_key, json) VALUES(?, ?, ?)')
      .run(roomId, effectKey, JSON.stringify(result));
  }

  removeRoom(roomId) {
    this.room(roomId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['messages', 'artifacts', 'effects']) {
        this.db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(roomId);
      }
      this.state.rooms = this.state.rooms.filter(room => room.id !== roomId);
      this.save();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.save();
    this.db.close();
  }
}
