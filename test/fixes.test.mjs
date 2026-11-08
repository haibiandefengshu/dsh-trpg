// 本轮 6 类 bug 的回归测试
process.resourcesPath = process.resourcesPath || 'E:\\dsh\\resources';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = path.resolve(process.cwd());
const host = await import(pathToFileURL(path.join(HOST, 'src/host.js')).href);
const { openDb, ensureSession, insertInvestigator, updateSession } = await import(pathToFileURL(path.join(HOST, 'src/db.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-fix-'));
const dbPath = path.join(dir, 'x.sqlite');
const db0 = openDb(dbPath);
ensureSession(db0, 'G1', { groupOpenid: 'G1', status: 'running', moduleId: 'mist-harbor', groupName: '甲团' });
ensureSession(db0, 'G2', { groupOpenid: 'G2', status: 'running', moduleId: 'mist-harbor', groupName: '乙团' });
insertInvestigator(db0, 'G1', { slot: 'P1', openid: 'U1', nickname: '小明', charName: '亚瑟', stats: { hp: 9, maxHp: 12 }, skills: { 侦查: 70 }, items: [], statusTags: [] });
db0.close();

const disposers = [];
const port = 17721;
await host.apply(
  {
    logger: { info() {}, warn() {} },
    agents: { get: () => null },
    sessions: { flush: async () => {} },
    get: () => undefined,
    on: (evt, fn) => { if (evt === 'dispose') disposers.push(fn); return () => {}; },
    onTeardown() {},
  },
  { port, token: 'tk-12345678', dbPath, workspaceDir: dir, dataDir: dir,
    // 隔离：不要指向真实的 8080，否则启动拉取会把测试令牌换成真值
    roostSendUrl: 'http://127.0.0.1:17899/api/plugins/trpg-forwarder/r/send' },
);
test.after(() => { for (const fn of disposers) { try { fn(); } catch { /* 忽略 */ } } });
await new Promise((r) => setTimeout(r, 350));

const ok = (l, c, e = '') => console.log((c ? '✔' : '✘') + ' ' + l + (e ? ' — ' + e : ''));

test('F1 两个群各自持有出站实例', async () => {
  // 从两个群分别打 /trpg status，两边都要有回复（以前共用 turn 会串台）
  const send = (gk) => fetch(`http://127.0.0.1:${port}/trpg/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trpg-token': 'tk-12345678' },
    body: JSON.stringify({ eventId: 'e-' + gk, groupId: gk, userId: 'U1', nickname: 't', msgId: 'm-' + gk, text: '/trpg status', timestamp: Date.now(), roleLevel: 0 }),
  });
  const a = await send('G1');
  const b = await send('G2');
  ok('F1 甲团事件 200', a.status === 200);
  ok('F1 乙团事件 200', b.status === 200);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

test('F2 config 读 moduleId', async () => {
  const { readConfig } = await import(pathToFileURL(path.join(HOST, 'src/config.js')).href);
  const c = readConfig({ moduleId: 'midnight-express' });
  assert.equal(c.moduleId, 'midnight-express');
  assert.equal(c.defaultModule, 'midnight-express');
});

test('F5 roostSendUrl 可覆盖', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/trpg/panel/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trpg-token': 'tk-12345678' },
    body: JSON.stringify({ roostSendUrl: 'http://127.0.0.1:18080/api/plugins/trpg-forwarder/r/send' }),
  });
  assert.equal(res.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.roostSendUrl, 'http://127.0.0.1:18080/api/plugins/trpg-forwarder/r/send');
});

test('F9 工具 schema 每个 object 节点都有 additionalProperties', async () => {
  const { createTools } = await import(pathToFileURL(path.join(HOST, 'src/tools.js')).href);
  const { openDb } = await import(pathToFileURL(path.join(HOST, 'src/db.js')).href);
  const db = openDb(':memory:');
  const tools = createTools({
    db, cfg: { turnBudget: 8 },
    outbound: { broadcast() {}, send: async () => ({ ok: true }) },
    log: () => {}, groupKey: 'G', getTurn: () => null,
  });

  // 复刻 impl 里的递归修复，验证修复后没有遗漏节点
  function deepFix(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(deepFix);
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepFix(v);
    if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = true;
    if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, deepFix(v)]));
    if (out.items) out.items = deepFix(out.items);
    return out;
  }
  const problems = [];
  const walk = (n, p) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, p + '[' + i + ']'));
    if (n.type === 'object' && n.additionalProperties === undefined) problems.push(p);
    for (const [k, v] of Object.entries(n)) walk(v, p + '.' + k);
  };
  for (const t of tools) {
    const schema = deepFix({ type: 'object', properties: Object.fromEntries(Object.entries(t.parameters || {}).map(([k, v]) => [k, deepFix(v)])), additionalProperties: false });
    walk(schema, t.name);
  }
  ok('F9 全部合规', problems.length === 0, problems.join(','));
  assert.deepEqual(problems, []);
  db.close();
});

test('F3 /trpg tools 可用（不再是死代码）', async () => {
  const { handleCommand } = await import(pathToFileURL(path.join(HOST, 'src/commands.js')).href);
  const { openDb } = await import(pathToFileURL(path.join(HOST, 'src/db.js')).href);
  const db = openDb(':memory:');
  const evt = { groupKey: 'G', groupId: 'G', userId: 'U1', nickname: 't', msgId: 'm', roleLevel: 0 };
  const r = handleCommand({ text: '/trpg tools', evt, db, cfg: {} });
  ok('F3 tools 有回复', String(r.reply || '').includes('trpg_roll_check'), String(r.reply || '').slice(0, 30));
  assert.ok(String(r.reply).includes('trpg_roll_check'));
  db.close();
});

test('F4 /ra 使用本群房规', async () => {
  const { handleCommand } = await import(pathToFileURL(path.join(HOST, 'src/commands.js')).href);
  const { openDb, ensureSession, updateSession } = await import(pathToFileURL(path.join(HOST, 'src/db.js')).href);
  const db = openDb(':memory:');
  ensureSession(db, 'G', { groupOpenid: 'G', status: 'running', moduleId: 'mist-harbor' });
  updateSession(db, 'G', { houseRule: 0 });
  const evt = { groupKey: 'G', groupId: 'G', userId: 'U1', nickname: 't', msgId: 'm', roleLevel: 0 };
  handleCommand({ text: '/st 测试 hp10 san50 侦查50', evt, db, cfg: {} });
  const r = handleCommand({ text: '/ra 侦查', evt, db, cfg: {} });
  ok('F4 /ra 出结果', String(r.reply).includes('D100'), String(r.reply).slice(0, 40));
  assert.ok(String(r.reply).includes('D100'));
  db.close();
});

test('F6 只剩一个入口', () => {
  assert.ok(fs.existsSync(path.join(HOST, 'src/host.js')));
  assert.ok(!fs.existsSync(path.join(HOST, 'src/entry.js')), 'entry.js 应已删除');
});
