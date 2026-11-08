// SQLite 单一事实来源：5 张表（会话/角色卡/场景/回合快照/战役记忆）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trpg_sessions (
  group_key       TEXT PRIMARY KEY,
  group_openid    TEXT NOT NULL,
  dsh_session_id  TEXT DEFAULT NULL,
  status          TEXT NOT NULL DEFAULT 'idle',
  module_id       TEXT NOT NULL DEFAULT 'default',
  current_scene   TEXT NOT NULL DEFAULT 'start',
  turn_id         INTEGER NOT NULL DEFAULT 1,
  unlocked_clues  TEXT NOT NULL DEFAULT '[]',
  combat_json         TEXT NOT NULL DEFAULT '{"active":false}',
  pending_checks_json TEXT NOT NULL DEFAULT '{}',
  default_slot        TEXT NOT NULL DEFAULT '',
  house_rule          INTEGER NOT NULL DEFAULT 3,
  group_name          TEXT NOT NULL DEFAULT '',
  updated_at          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trpg_investigators (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key        TEXT NOT NULL,
  slot_code        TEXT NOT NULL,
  user_openid      TEXT DEFAULT NULL,
  user_uin         TEXT DEFAULT NULL,
  qq_nickname      TEXT NOT NULL DEFAULT '',
  char_name        TEXT NOT NULL,
  stats_json       TEXT NOT NULL,
  skills_json      TEXT NOT NULL DEFAULT '{}',
  items_json       TEXT NOT NULL DEFAULT '[]',
  status_tags      TEXT NOT NULL DEFAULT '[]',
  tactic_pref      TEXT NOT NULL DEFAULT 'dodge',
  is_afk           INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_key, user_openid)
);
CREATE INDEX IF NOT EXISTS idx_inv_group_uin ON trpg_investigators(group_key, user_uin);
CREATE TABLE IF NOT EXISTS trpg_scenes (
  module_id       TEXT NOT NULL,
  scene_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  public_desc     TEXT NOT NULL,
  clues_json      TEXT NOT NULL DEFAULT '[]',
  npcs_json       TEXT NOT NULL DEFAULT '[]',
  exits_json      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (module_id, scene_id)
);
CREATE TABLE IF NOT EXISTS trpg_snapshots (
  group_key       TEXT NOT NULL,
  turn_id         INTEGER NOT NULL,
  dsh_message_idx INTEGER NOT NULL DEFAULT 0,
  session_backup  TEXT NOT NULL,
  party_backup    TEXT NOT NULL,
  action_summary  TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (group_key, turn_id)
);
CREATE TABLE IF NOT EXISTS trpg_campaign_memory (
  group_key   TEXT NOT NULL,
  fact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  fact        TEXT NOT NULL,
  importance  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_group ON trpg_campaign_memory(group_key, importance DESC);
`;

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrateInvestigatorBinding(db);
  try {
    const cols = db.prepare('PRAGMA table_info(trpg_sessions)').all().map((c) => c.name);
    if (!cols.includes('default_slot')) db.exec("ALTER TABLE trpg_sessions ADD COLUMN default_slot TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('house_rule')) db.exec('ALTER TABLE trpg_sessions ADD COLUMN house_rule INTEGER NOT NULL DEFAULT 3');
    if (!cols.includes('group_name')) db.exec("ALTER TABLE trpg_sessions ADD COLUMN group_name TEXT NOT NULL DEFAULT ''");
  } catch { /* 加列失败不影响启动 */ }
  return db;
}

/**
 * 把 user_openid 从 NOT NULL 迁到可空。
 *
 * 起因：一张卡「没人绑」和「绑了谁」是两回事，用空字符串表示未绑定会撞
 * UNIQUE(group_key, user_openid)——一个群只能有一张未绑定卡。
 * SQLite 允许多个 NULL，所以未绑定统一写 NULL。
 * 老库改不了 NOT NULL，只能重建表再搬数据。
 */
function migrateInvestigatorBinding(db) {
  const cols = db.prepare('PRAGMA table_info(trpg_investigators)').all();
  const col = cols.find((c) => c.name === 'user_openid');
  if (!col || !col.notnull) return;
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE trpg_investigators_new (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      group_key        TEXT NOT NULL,
      slot_code        TEXT NOT NULL,
      user_openid      TEXT DEFAULT NULL,
      user_uin         TEXT DEFAULT NULL,
      qq_nickname      TEXT NOT NULL DEFAULT '',
      char_name        TEXT NOT NULL,
      stats_json       TEXT NOT NULL,
      skills_json      TEXT NOT NULL DEFAULT '{}',
      items_json       TEXT NOT NULL DEFAULT '[]',
      status_tags      TEXT NOT NULL DEFAULT '[]',
      tactic_pref      TEXT NOT NULL DEFAULT 'dodge',
      is_afk           INTEGER NOT NULL DEFAULT 0,
      UNIQUE(group_key, user_openid)
    )`);
    db.exec(`INSERT INTO trpg_investigators_new
      (id, group_key, slot_code, user_openid, user_uin, qq_nickname, char_name, stats_json, skills_json, items_json, status_tags, tactic_pref, is_afk)
      SELECT id, group_key, slot_code, NULLIF(user_openid, ''), user_uin, qq_nickname, char_name, stats_json, skills_json, items_json, status_tags, tactic_pref, is_afk
      FROM trpg_investigators`);
    db.exec('DROP TABLE trpg_investigators');
    db.exec('ALTER TABLE trpg_investigators_new RENAME TO trpg_investigators');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inv_group_uin ON trpg_investigators(group_key, user_uin)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

const j = (v, d) => {
  if (v == null || v === '') return d;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return d; }
};
const s = (v) => JSON.stringify(v ?? null);

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function getSession(db, gk) {
  const row = db.prepare('SELECT * FROM trpg_sessions WHERE group_key = ?').get(gk);
  if (!row) return null;
  return {
    groupKey: row.group_key,
    groupOpenid: row.group_openid,
    dshSessionId: row.dsh_session_id || '',
    status: row.status,
    moduleId: row.module_id,
    currentScene: row.current_scene,
    turnId: Number(row.turn_id) || 1,
    unlockedClues: j(row.unlocked_clues, []),
    combat: j(row.combat_json, { active: false }),
    pendingChecks: j(row.pending_checks_json, {}),
    defaultSlot: row.default_slot || '',
    houseRule: Number(row.house_rule ?? 3),
    groupName: row.group_name || '',
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function ensureSession(db, gk, patch = {}) {
  const exists = getSession(db, gk);
  if (exists) return updateSession(db, gk, patch);
  db.prepare(`INSERT INTO trpg_sessions
    (group_key, group_openid, dsh_session_id, status, module_id, current_scene, turn_id, unlocked_clues, combat_json, pending_checks_json, updated_at, group_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '{"active":false}', '{}', ?, ?)`).run(
    gk, String(patch.groupOpenid || ''), patch.dshSessionId ?? null,
    patch.status || 'idle', patch.moduleId || 'default', patch.currentScene || 'start',
    patch.turnId || 1, Date.now(), String(patch.groupName || ''),
  );
  const fresh = getSession(db, gk);
  // 老行没有群名时补一次（后续改名要用）
  if (patch.groupName && fresh.groupName !== patch.groupName) {
    updateSession(db, gk, { groupName: patch.groupName });
    return getSession(db, gk);
  }
  return fresh;
}

const COLS = {
  groupOpenid: 'group_openid', dshSessionId: 'dsh_session_id', status: 'status',
  moduleId: 'module_id', currentScene: 'current_scene', turnId: 'turn_id',
  unlockedClues: 'unlocked_clues', combat: 'combat_json', pendingChecks: 'pending_checks_json',
  defaultSlot: 'default_slot', houseRule: 'house_rule', groupName: 'group_name',
};
const JSON_FIELDS = new Set(['unlockedClues', 'combat', 'pendingChecks']);

export function updateSession(db, gk, patch = {}) {
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(COLS)) {
    if (!(k in patch)) continue;
    sets.push(`${col} = ?`);
    args.push(JSON_FIELDS.has(k) ? s(patch[k]) : patch[k] ?? null);
  }
  if (!sets.length) return getSession(db, gk);
  sets.push('updated_at = ?');
  args.push(Date.now(), gk);
  db.prepare(`UPDATE trpg_sessions SET ${sets.join(', ')} WHERE group_key = ?`).run(...args);
  return getSession(db, gk);
}

function invOf(row) {
  if (!row) return null;
  return {
    id: Number(row.id), groupKey: row.group_key, slot: row.slot_code,
    openid: row.user_openid, uin: row.user_uin || '', nickname: row.qq_nickname || '',
    charName: row.char_name, stats: j(row.stats_json, {}), skills: j(row.skills_json, {}),
    items: j(row.items_json, []), statusTags: j(row.status_tags, []),
    tactic: row.tactic_pref || 'dodge', afk: Number(row.is_afk) === 1,
  };
}

export function listInvestigators(db, gk) {
  return db.prepare('SELECT * FROM trpg_investigators WHERE group_key = ? ORDER BY id ASC').all(gk).map(invOf);
}

export function getInvestigator(db, gk, slot) {
  return invOf(db.prepare('SELECT * FROM trpg_investigators WHERE group_key = ? AND slot_code = ?').get(gk, String(slot)));
}

export function findByOpenid(db, gk, openid) {
  return invOf(db.prepare('SELECT * FROM trpg_investigators WHERE group_key = ? AND user_openid = ?').get(gk, String(openid)));
}

export function insertInvestigator(db, gk, inv) {
  const info = db.prepare(`INSERT INTO trpg_investigators
    (group_key, slot_code, user_openid, user_uin, qq_nickname, char_name, stats_json, skills_json, items_json, status_tags, tactic_pref, is_afk)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    gk, inv.slot, inv.openid || null, inv.uin || null, inv.nickname || '', inv.charName,
    s(inv.stats || {}), s(inv.skills || {}), s(inv.items || []), s(inv.statusTags || []),
    inv.tactic || 'dodge', inv.afk ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

export function updateInvestigator(db, gk, slot, patch = {}) {
  const map = {
    openid: 'user_openid', uin: 'user_uin', nickname: 'qq_nickname', charName: 'char_name',
    stats: 'stats_json', skills: 'skills_json', items: 'items_json', statusTags: 'status_tags',
    tactic: 'tactic_pref', afk: 'is_afk',
  };
  const jsonFields = new Set(['stats', 'skills', 'items', 'statusTags']);
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in patch)) continue;
    sets.push(`${col} = ?`);
    const v = patch[k];
    args.push(jsonFields.has(k) ? s(v) : k === 'afk' ? (v ? 1 : 0) : v ?? null);
  }
  if (!sets.length) return getInvestigator(db, gk, slot);
  args.push(gk, String(slot));
  db.prepare(`UPDATE trpg_investigators SET ${sets.join(', ')} WHERE group_key = ? AND slot_code = ?`).run(...args);
  return getInvestigator(db, gk, slot);
}

export function getScene(db, moduleId, sceneId) {
  const row = db.prepare('SELECT * FROM trpg_scenes WHERE module_id = ? AND scene_id = ?').get(String(moduleId), String(sceneId));
  if (!row) return null;
  return {
    moduleId: row.module_id, sceneId: row.scene_id, title: row.title, desc: row.public_desc,
    clues: j(row.clues_json, []), npcs: j(row.npcs_json, []), exits: j(row.exits_json, []),
  };
}

export function listScenes(db, moduleId) {
  return db.prepare('SELECT * FROM trpg_scenes WHERE module_id = ?').all(String(moduleId));
}

export function upsertScene(db, sc) {
  db.prepare(`INSERT INTO trpg_scenes (module_id, scene_id, title, public_desc, clues_json, npcs_json, exits_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(module_id, scene_id) DO UPDATE SET
      title = excluded.title, public_desc = excluded.public_desc,
      clues_json = excluded.clues_json, npcs_json = excluded.npcs_json, exits_json = excluded.exits_json`).run(
    sc.moduleId, sc.sceneId, sc.title || sc.sceneId, sc.desc || '',
    s(sc.clues || []), s(sc.npcs || []), s(sc.exits || []),
  );
}

export function ensureSnapshot(db, gk, turnId) {
  const row = db.prepare('SELECT turn_id FROM trpg_snapshots WHERE group_key = ? AND turn_id = ?').get(gk, turnId);
  if (row) return false;
  db.prepare(`INSERT INTO trpg_snapshots (group_key, turn_id, dsh_message_idx, session_backup, party_backup, action_summary, created_at)
    VALUES (?, ?, 0, ?, ?, '', ?)`).run(gk, turnId, s(getSession(db, gk)), s(listInvestigators(db, gk)), Date.now());
  return true;
}

export function appendSummary(db, gk, turnId, line) {
  const text = String(line || '').trim();
  if (!text) return;
  const row = db.prepare('SELECT action_summary FROM trpg_snapshots WHERE group_key = ? AND turn_id = ?').get(gk, turnId);
  if (!row) return;
  const prev = row.action_summary ? `${row.action_summary}；` : '';
  db.prepare('UPDATE trpg_snapshots SET action_summary = ? WHERE group_key = ? AND turn_id = ?')
    .run(`${prev}${text}`.slice(0, 1200), gk, turnId);
}

export function getSnapshot(db, gk, turnId) {
  const row = db.prepare('SELECT * FROM trpg_snapshots WHERE group_key = ? AND turn_id = ?').get(gk, turnId);
  if (!row) return null;
  return {
    turnId: Number(row.turn_id), session: j(row.session_backup, null), party: j(row.party_backup, []),
    summary: row.action_summary || '', createdAt: Number(row.created_at) || 0,
  };
}

export function latestSnapshot(db, gk) {
  const row = db.prepare('SELECT * FROM trpg_snapshots WHERE group_key = ? ORDER BY turn_id DESC LIMIT 1').get(gk);
  return row ? getSnapshot(db, gk, Number(row.turn_id)) : null;
}

export function restoreSnapshot(db, gk, turnId) {
  const snap = getSnapshot(db, gk, turnId);
  if (!snap?.session) return null;
  tx(db, () => {
    db.prepare('DELETE FROM trpg_investigators WHERE group_key = ?').run(gk);
    for (const inv of snap.party) insertInvestigator(db, gk, inv);
    const x = snap.session;
    updateSession(db, gk, {
      status: x.status, moduleId: x.moduleId, currentScene: x.currentScene, turnId: x.turnId,
      unlockedClues: x.unlockedClues, combat: x.combat, pendingChecks: x.pendingChecks,
      dshSessionId: x.dshSessionId || null,
    });
  });
  return snap;
}

/**
 * 彻底删掉一个群的跑团记录。
 *
 * trpg_scenes 不按群存（属于模组定义，多群共用一份），所以不动它 ——
 * 删了会把别人的进度一起抹掉。
 */
export function purgeCampaign(db, gk) {
  return tx(db, () => {
    const before = {
      investigators: db.prepare('SELECT COUNT(*) AS n FROM trpg_investigators WHERE group_key = ?').get(gk)?.n ?? 0,
      snapshots: db.prepare('SELECT COUNT(*) AS n FROM trpg_snapshots WHERE group_key = ?').get(gk)?.n ?? 0,
      facts: db.prepare('SELECT COUNT(*) AS n FROM trpg_campaign_memory WHERE group_key = ?').get(gk)?.n ?? 0,
    };
    db.prepare('DELETE FROM trpg_investigators WHERE group_key = ?').run(gk);
    db.prepare('DELETE FROM trpg_snapshots WHERE group_key = ?').run(gk);
    db.prepare('DELETE FROM trpg_campaign_memory WHERE group_key = ?').run(gk);
    db.prepare('DELETE FROM trpg_sessions WHERE group_key = ?').run(gk);
    return before;
  });
}

export function deleteSnapshot(db, gk, turnId) {
  db.prepare('DELETE FROM trpg_snapshots WHERE group_key = ? AND turn_id = ?').run(gk, turnId);
}

export function campaignFacts(db, gk, limit = 12) {
  return db.prepare('SELECT fact, importance FROM trpg_campaign_memory WHERE group_key = ? ORDER BY importance DESC, fact_id DESC LIMIT ?').all(gk, limit);
}

export function addCampaignFact(db, gk, fact, importance = 1) {
  const text = String(fact || '').trim().slice(0, 300);
  if (!text) return null;
  return Number(db.prepare('INSERT INTO trpg_campaign_memory (group_key, fact, importance, created_at) VALUES (?, ?, ?, ?)').run(gk, text, Number(importance) || 1, Date.now()).lastInsertRowid);
}

export function closeDb(db) { try { db.close(); } catch {} }
