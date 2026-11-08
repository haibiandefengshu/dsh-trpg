// 面板客户端契约：侧边栏入口 + 整页面板
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

test('注册了侧边栏图标', () => {
  assert.ok(/name: 'sidebar\.panellist'/.test(src), '缺少 sidebar.panellist 注册');
  assert.ok(/label:\s*function \(\) \{ return '跑团面板'/.test(src) || /跑团面板/.test(src), '缺少中文标签');
});

test('注册了 main 面板，key 与侧边栏 id 一致', () => {
  const idMatch = /const PANEL_ID = '([^']+)'/.exec(src);
  assert.ok(idMatch, '缺少 PANEL_ID');
  const id = idMatch[1];
  assert.ok(new RegExp(`id: PANEL_ID`).test(src), '侧边栏 id 没用 PANEL_ID');
  assert.ok(new RegExp(`name: 'main', key: PANEL_ID`).test(src), 'main 的 key 没用 PANEL_ID');
});

test('图标组件只吃 size，不处理点击', () => {
  assert.ok(/function SidebarIcon\(props\)/.test(src));
  assert.ok(/props\.size/.test(src));
  // 图标里不该出现 onClick —— 导航由侧边栏自己负责
  const seg = src.slice(src.indexOf('function SidebarIcon'), src.indexOf('function PanelPage'));
  assert.ok(!/onClick/.test(seg), 'SidebarIcon 不该自带点击处理');
});

test('整页面板有滚动容器', () => {
  const seg = src.slice(src.indexOf('function PanelPage'), src.indexOf('return {\n      inject'));
  assert.ok(/overflowY: 'auto'/.test(seg), '整页面板应有滚动容器');
});

test('插件详情页那块仍然保留', () => {
  assert.ok(/name: 'plugins\.bundle\.config'/.test(src));
});
