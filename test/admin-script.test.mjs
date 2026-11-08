// 管理页内联脚本的语法必须能通过 —— 它一坏，整页交互全废
process.resourcesPath = process.resourcesPath || 'E:\\dsh\\resources';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = path.resolve(process.cwd());
const host = await import(pathToFileURL(path.join(HOST, 'src/host.js')).href);
const { openDb, ensureSession } = await import(pathToFileURL(path.join(HOST, 'src/db.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-inline-'));
const dbPath = path.join(dir, 'x.sqlite');
const db = openDb(dbPath);
ensureSession(db, 'G1', { groupOpenid: 'G1', status: 'running', moduleId: 'mist-harbor', groupName: '雾港调查小队' });
db.close();

const port = 17711;
// 注意：不关掉这个 server，测试进程会一直挂着
const disposers = [];
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
    roostSendUrl: 'http://127.0.0.1:17898/api/plugins/trpg-forwarder/r/send' },
);
test.after(() => {
  for (const fn of disposers) { try { fn(); } catch { /* 忽略 */ } }
});
await new Promise((r) => setTimeout(r, 350));

const html = await (await fetch(`http://127.0.0.1:${port}/trpg/admin`)).text();
const si = html.indexOf('<script>');
const se = html.indexOf('</script>', si);
const script = html.slice(si + '<script>'.length, se);

test('管理页内联脚本语法正确', () => {
  // new Function 会真正解析，语法错误直接抛
  assert.doesNotThrow(() => new Function(script), '内联 <script> 有语法错误');
});

test('脚本里没有跨行的单引号字符串', () => {
  // 典型事故：模板字符串里的 \n 落进 HTML 变成真实换行
  const badLines = script
    .split('\n')
    .filter((l) => {
      const quotes = (l.match(/'/g) || []).length;
      return quotes % 2 === 1;
    });
  assert.deepEqual(badLines, [], '存在引号未闭合的行，多半是换行被转义丢了');
});

test('删除按钮绑定了点击，且指向正确端点', () => {
  assert.ok(script.includes('button.del'), '缺少删除按钮绑定');
  assert.ok(script.includes('/trpg/panel/delete'), '缺少删除端点');
  assert.ok(script.includes('confirm(tip)'), '缺少二次确认');
});

test('保存 / 刷新 / 导入也都还在', () => {
  assert.ok(script.includes("$('save').onclick"), '保存按钮丢了');
  assert.ok(script.includes("$('reload').onclick"), '刷新按钮丢了');
  assert.ok(script.includes("importFile.onchange"), '导入模组丢了');
});
