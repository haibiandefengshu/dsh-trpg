// /trpg/panel/config 的鉴权回归。
//
// 这个端点不走通用令牌校验（否则令牌丢了就永远改不回来），所以它自己判：
//   · 当前没配令牌 → 允许（首次配置）
//   · 带正确的**当前**令牌 → 允许
//
// 曾经还有第三条「带的令牌等于要写入的新值就放行」，等于没鉴权：
// 任何人 POST { token: 'hacked' } 并在头里带 x-trpg-token: hacked 就能改掉令牌，
// 还会顺手把 Roost 侧 trpg-forwarder 的令牌同步成同一个值。这条回归就是守它的。
process.resourcesPath = process.resourcesPath || 'E:\\dsh\\resources';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = path.resolve(process.cwd());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-auth-'));
const OUTBOX = 'http://127.0.0.1:17899/api/plugins/trpg-forwarder/r/send'; // 没有监听，连接立即被拒

/** 起一个实例；返回 { post } 方便发请求。 */
async function boot(port, token) {
  // 每个实例都要拿自己的模块副本：host.js 内部按 apply 刷新时间戳，同一进程多次 apply 是支持的
  const host = await import(pathToFileURL(path.join(HOST, 'src/host.js')).href + '?t=' + port + Date.now());
  const disposers = [];
  const sub = path.join(dir, `t${port}`);
  fs.mkdirSync(sub, { recursive: true });
  await host.apply(
    {
      logger: { info() {}, warn() {} },
      agents: { get: () => null },
      sessions: { flush: async () => {} },
      get: () => undefined,
      on: (evt, fn) => { if (evt === 'dispose') disposers.push(fn); return () => {}; },
      onTeardown() {},
    },
    {
      port,
      token,
      dbPath: path.join(sub, 'x.sqlite'),
      workspaceDir: sub,
      dataDir: sub,
      roostSendUrl: OUTBOX,
    },
  );
  await new Promise((r) => setTimeout(r, 350));
  const post = (body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/trpg/panel/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  return { post, stop: () => { for (const fn of disposers) { try { fn(); } catch { /* 忽略 */ } } } };
}

test('已有令牌时：带错令牌改配置 → 403', async () => {
  const inst = await boot(17731, 'tk-current-1');
  try {
    const r = await inst.post({ token: 'other' }, { 'x-trpg-token': 'wrong' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'bad_token');
  } finally {
    inst.stop();
  }
});

test('回归：拿「新令牌」自证不能绕过（旧漏洞）', async () => {
  const inst = await boot(17732, 'tk-current-2');
  try {
    // 攻击者不知道旧令牌，把新值同时放进头和 body
    const r = await inst.post({ token: 'hacked' }, { 'x-trpg-token': 'hacked' });
    assert.equal(r.status, 403, '带新值自证必须被拒');
  } finally {
    inst.stop();
  }
});

test('已有令牌时：带正确的当前令牌 → 允许修改', async () => {
  const inst = await boot(17733, 'tk-current-3');
  try {
    const r = await inst.post({ token: 'tk-next-3' }, { 'x-trpg-token': 'tk-current-3' });
    assert.equal(r.status, 200);
    assert.equal(r.body.tokenChanged, true);
  } finally {
    inst.stop();
  }
});

test('完全没有令牌时（首次配置）→ 允许设置', async () => {
  const inst = await boot(17734, '');
  try {
    const r = await inst.post({ token: 'tk-first-4' }, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.tokenChanged, true);
  } finally {
    inst.stop();
  }
});

test('不带任何令牌头、直接改密码 → 403', async () => {
  const inst = await boot(17735, 'tk-current-5');
  try {
    const r = await inst.post({ token: 'sneaky' });
    assert.equal(r.status, 403);
  } finally {
    inst.stop();
  }
});
