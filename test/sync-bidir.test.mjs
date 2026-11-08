// 双向令牌同步：Roost 改 → DSH 跟上（事件路径），DSH 改 → 推给 Roost
process.resourcesPath = process.resourcesPath || 'E:\\dsh\\resources';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const HOST = path.resolve(process.cwd());
const host = await import(pathToFileURL(path.join(HOST, 'src/host.js')).href);

let roostToken = 'ROOST-1';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!req.url.startsWith('/api/plugins/trpg-forwarder/r/')) return j(404, { error: '接口不存在' });
    if (req.url.endsWith('/r/token')) return j(200, { ok: true, token: roostToken, configured: Boolean(roostToken) });
    if (req.url.endsWith('/r/config')) {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { /* ignore */ }
      if (roostToken && p.from !== roostToken) return j(403, { error: 'bad_token' });
      if (!p.token) return j(400, { error: 'nothing_to_update' });
      roostToken = p.token;
      return j(200, { ok: true });
    }
    return j(200, { ok: true });
  });
});
await new Promise((r) => fake.listen(17851, '127.0.0.1', r));

const states = [];
async function boot(port, token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-bidir-'));
  const disposers = [];
  await host.apply(
    {
      logger: { info() {}, warn() {} }, agents: { get: () => null }, sessions: { flush: async () => {} },
      get: () => undefined, on: (e, f) => { if (e === 'dispose') disposers.push(f); return () => {}; }, onTeardown() {},
    },
    {
      port, token, dbPath: path.join(dir, 'x.sqlite'), workspaceDir: dir, dataDir: dir,
      roostSendUrl: 'http://127.0.0.1:17851/api/plugins/trpg-forwarder/r/send',
    },
  );
  await new Promise((r) => setTimeout(r, 200));
  states.push({ dir, disposers });
  return { dir, disposers };
}

test.after(() => {
  for (const s of states) for (const fn of s.disposers) { try { fn(); } catch {} }
  fake.close();
});

test('启动时只提示不一致，不覆盖本地新值', async () => {
  roostToken = 'ROOST-AT-BOOT';
  const { dir } = await boot(17852, 'DSH-NEWER-1');
  await new Promise((r) => setTimeout(r, 1600));

  /**
   * 启动拉取**只提示不覆盖**：
   * 「DSH 刚改成新值、推送失败」的情况下，如果启动就拿 Roost 的旧值盖回去，
   * 用户看到的是「改了又变回去了」。覆盖发生在事件投递路径（见下一个测试）。
   */
  const exists = fs.existsSync(path.join(dir, 'config.json'));
  const cfgFile = exists ? JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) : {};
  assert.notEqual(cfgFile.token, 'ROOST-AT-BOOT', '不该被 Roost 的旧值覆盖');
  // 本地值仍然有效
  assert.equal((await fetch('http://127.0.0.1:17852/trpg/panel', { headers: { 'x-trpg-token': 'DSH-NEWER-1' } })).status, 200);
});

test('Roost 改令牌后，事件投递一次就能通过', async () => {
  roostToken = 'ROOST-START-2';
  await boot(17853, 'ROOST-START-2');
  await new Promise((r) => setTimeout(r, 1600));

  roostToken = 'ROOST-CHANGED-3';
  await new Promise((r) => setTimeout(r, 10500)); // 等 10 秒缓存过期

  const ev = await fetch('http://127.0.0.1:17853/trpg/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trpg-token': 'ROOST-CHANGED-3' },
    body: JSON.stringify({ eventId: 'e1', groupId: 'G1', userId: 'U1', nickname: 't', msgId: 'm1', text: '/trpg status', timestamp: Date.now(), roleLevel: 0 }),
  });
  assert.equal(ev.status, 200, '用 Roost 的新令牌投递应当被接受');
});

test('DSH 改令牌 → 推给 Roost，本地与远端一致', async () => {
  roostToken = 'BASE-4';
  const { dir } = await boot(17854, 'BASE-4');
  await new Promise((r) => setTimeout(r, 1600));
  const res = await fetch('http://127.0.0.1:17854/trpg/panel/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trpg-token': 'BASE-4' },
    body: JSON.stringify({ token: 'PUSHED-5' }),
  });
  const j = await res.json();
  assert.equal(j.forwarder.ok, true, JSON.stringify(j.forwarder));
  assert.equal(roostToken, 'PUSHED-5');
  const cfgFile = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cfgFile.token, 'PUSHED-5');
});
