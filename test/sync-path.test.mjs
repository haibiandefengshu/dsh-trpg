// 同步路径必须有 /r —— 少了它永远是 404「接口不存在」
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

const hits = [];
let roostToken = 'OLD-TOKEN-1';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, body });
    if (!req.url.startsWith('/api/plugins/trpg-forwarder/r/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"接口不存在"}');
    }
    if (req.url.endsWith('/r/config')) {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { /* ignore */ }
      if (roostToken && p.from !== roostToken) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end('{"error":"bad_token"}');
      }
      roostToken = p.token;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => fake.listen(17821, '127.0.0.1', r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-syncpath-'));
const disposers = [];
const port = 17822;
await host.apply(
  {
    logger: { info() {}, warn() {} }, agents: { get: () => null }, sessions: { flush: async () => {} },
    get: () => undefined, on: (e, f) => { if (e === 'dispose') disposers.push(f); return () => {}; }, onTeardown() {},
  },
  {
    port, token: 'OLD-TOKEN-1', dbPath: path.join(dir, 'x.sqlite'), workspaceDir: dir, dataDir: dir,
    roostSendUrl: 'http://127.0.0.1:17821/api/plugins/trpg-forwarder/r/send',
  },
);
test.after(() => {
  for (const fn of disposers) { try { fn(); } catch {} }
  fake.close();
});
await new Promise((r) => setTimeout(r, 300));

test('同步打的是 /r/config 与 /r/reload', async () => {
  hits.length = 0;
  roostToken = 'OLD-TOKEN-1';
  const res = await fetch(`http://127.0.0.1:${port}/trpg/panel/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trpg-token': 'OLD-TOKEN-1' },
    body: JSON.stringify({ token: 'BRAND-NEW-9' }),
  });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.forwarder.ok, true, JSON.stringify(j.forwarder));
  assert.ok(hits.some((h) => h.url === '/api/plugins/trpg-forwarder/r/config'), hits.map((h) => h.url).join(','));
  assert.ok(hits.some((h) => h.url === '/api/plugins/trpg-forwarder/r/reload'));
  assert.ok(hits.some((h) => h.body.includes('OLD-TOKEN-1')), '应带 from 旧令牌');
  assert.equal(roostToken, 'BRAND-NEW-9');
});

test('from 不对时如实报 config 失败', async () => {
  // 先把 Roost 侧令牌改成别的，制造不一致
  roostToken = 'ROOST-ONLY-VALUE';
  const res = await fetch(`http://127.0.0.1:${port}/trpg/panel/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trpg-token': 'BRAND-NEW-9' },
    body: JSON.stringify({ token: 'ANOTHER-3' }),
  });
  const j = await res.json();
  assert.equal(j.forwarder.ok, false);
  assert.equal(j.forwarder.step, 'config');
  assert.equal(j.forwarder.status, 403);
});
