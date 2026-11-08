// 单聊（c2c）链路：桥要接住、DSH 要按 direct 走 sendC2C
process.resourcesPath = process.resourcesPath || 'E:\\dsh\\resources';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const ROOST = 'C:/Users/张海枫/.dsh/dsh-roost/roost';
const bridge = (await import(pathToFileURL(path.join(ROOST, 'plugins/trpg-forwarder/index.js')).href)).default;

const sentEvents = [];
const routes = new Map();
const store = new Map();
let middleware = null;
const cfgObj = { enabled: true, dshUrl: 'http://127.0.0.1:17881', token: 'T', botId: 'main', timeoutMs: 800, maxAttempts: 1 };
const noop = () => {};
const ctx = {
  logger: { info: noop, warn: noop, debug: noop, error: noop },
  config: cfgObj,
  registerRoute(m, p, h) { routes.set(m + ' ' + p, h); return m + ' ' + p; },
  async setConfig(p) { Object.assign(cfgObj, p); return cfgObj; },
  menu: noop, command: noop,
  storeGet: async (k, d) => (store.has(k) ? store.get(k) : d),
  storeSet: async (k, v) => { store.set(k, v); },
  on: () => () => {}, onTeardown: noop, levelOf: async () => 0,
  storage: { get: async (k, d) => (store.has(k) ? store.get(k) : d), set: async (k, v) => { store.set(k, v); } },
  use: (name, fn) => { if (name === 'trpg-forward') middleware = fn; },
  registerPage: () => null, push: noop, get: () => undefined,
  api: { sendGroup: noop, sendC2C: noop },
};
await bridge.setup(ctx);
await new Promise((r) => setTimeout(r, 500));

const dsh = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    sentEvents.push({ url: req.url, body: b });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => dsh.listen(17881, '127.0.0.1', r));

test.after(() => { dsh.close(); });

const mkMsg = (kind) => ({
  kind, id: 'm-' + kind + '-' + Math.random().toString(36).slice(2, 6),
  groupId: kind === 'group' ? 'GROUP-A' : '', userId: 'USER-OPENID-1',
  content: '/开始', receivedAt: Date.now(), userName: '小明', groupName: '甲团',
  replyNow: async () => ({}),
});

test('单聊 /开始 被接住并带 direct 标记', async () => {
  let passed = 0;
  await middleware({ msg: mkMsg('c2c') }, () => { passed += 1; });
  assert.equal(passed, 0, '单聊消息不该被放行给别的插件');

  await new Promise((r) => setTimeout(r, 2500));
  const e = sentEvents.find((x) => x.body.includes('"direct":true'));
  assert.ok(e, '单聊事件应投递到 DSH');
  assert.ok(e.body.includes('USER-OPENID-1'), 'groupId 应为对方 openid');
});

test('群聊仍是 direct=false', async () => {
  sentEvents.length = 0;
  let passed = 0;
  await middleware({ msg: mkMsg('group') }, () => { passed += 1; });
  assert.equal(passed, 0);
  await new Promise((r) => setTimeout(r, 2500));
  const e = sentEvents.find((x) => x.body.includes('GROUP-A'));
  assert.ok(e, '群聊事件应投递');
  assert.ok(e.body.includes('"direct":false'));
});

test('/send 按 direct 分流', async () => {
  const calls = [];
  ctx.api.sendGroup = (id) => { calls.push(['group', id]); return Promise.resolve({}); };
  ctx.api.sendC2C = (id) => { calls.push(['c2c', id]); return Promise.resolve({}); };
  const sendFn = routes.get('POST /send');

  await sendFn({ body: { groupId: 'USER-OPENID-1', content: 'hi', token: 'T', direct: true }, json: () => ({}) });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(calls.some((c) => c[0] === 'c2c'), '单聊应走 sendC2C：' + JSON.stringify(calls));

  calls.length = 0;
  await sendFn({ body: { groupId: 'GROUP-A', content: 'hi', token: 'T' }, json: () => ({}) });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(calls.some((c) => c[0] === 'group'), '群聊应走 sendGroup');
});
