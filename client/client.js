// dsh-trpg 的可视化面板（Client 半边）
//
// 挂在「插件 → dsh-trpg」详情页的描述下面（slot: plugins.bundle.config）。
// 数据来自宿主半边的本地端口 17322：/trpg/panel 读，/trpg/panel/config 写。
window.__ModuleLoader__.load({
  id: 'dsh-trpg',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const ENDPOINT = 'http://127.0.0.1:17322';
    const box = {
      border: '1px solid var(--dsh-border, #d8d8d8)',
      borderRadius: 10,
      padding: '12px 14px',
      marginTop: 10,
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: 1.6,
    };
    const row = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' };
    const labelStyle = { minWidth: 88, color: 'var(--dsh-text-secondary, #666)' };
    const inputStyle = {
      flex: 1, minWidth: 180, padding: '5px 8px', borderRadius: 6,
      border: '1px solid var(--dsh-border, #ccc)', background: 'var(--dsh-bg, #fff)',
      color: 'var(--dsh-text, #111)', fontFamily: 'inherit', fontSize: 13,
    };

    function CampaignLine(props) {
      const c = props.campaign;
      const cards = c.cards.length
        ? h('div', { style: { marginTop: 4 } }, c.cards.map(function (k) {
            const isDefault = c.defaultSlot === k.slot;
            return h('div', { key: k.slot, style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 } },
              h('span', null, '[' + k.slot + '] ' + k.name + (k.bound ? '' : '（未绑定）') + (isDefault ? ' ← 默认' : '')),
              h('button', {
                onClick: function () { props.onSetDefault(c.groupKey, isDefault ? '' : k.slot); },
                style: { padding: '1px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
              }, isDefault ? '取消默认' : '设为默认'));
          }))
        : '还没有角色卡';
      return h('div', { style: { marginTop: 6, paddingTop: 6, borderTop: '1px dashed #ddd' } },
        h('div', null, c.groupKey.slice(0, 8) + '…｜' + c.moduleId + '｜' + c.status + '｜第 ' + c.turn + ' 回合｜' + c.scene),
        cards);
    }

    function Panel() {
      const [data, setData] = useState(null);
      const [err, setErr] = useState('');
      // 令牌存在浏览器本地：服务端不再回显它，面板也就不该指望从接口拿
      const [token, setToken] = useState(function () {
        try { return window.localStorage.getItem('dsh-trpg/token') || ''; } catch (e) { return ''; }
      });
      const [moduleId, setModuleId] = useState('');
      const [workspaceDir, setWorkspaceDir] = useState('');
      const [saved, setSaved] = useState('');
      const [modJson, setModJson] = useState('');
      const [importMsg, setImportMsg] = useState('');

      const authHeaders = function () {
        return token ? { 'x-trpg-token': token } : {};
      };

      const load = useCallback(async function () {
        try {
          const res = await fetch(ENDPOINT + '/trpg/panel', { headers: authHeaders() });
          if (res.status === 401 || res.status === 403) {
            setErr('共享令牌不对。填下面「共享令牌」里的值（与 Roost 的 trpg-forwarder 一致），再点刷新。');
            return;
          }
          if (res.status === 503) {
            setErr('还没配共享令牌：先在这里填一个，再去 Roost 的 trpg-forwarder 填同一个值。');
            return;
          }
          const j = await res.json();
          setData(j);
          setModuleId(j.config?.moduleId || '');
          setWorkspaceDir(j.config?.workspaceDir || '');
          setErr('');
        } catch (e) {
          setErr('连不上 dsh-trpg（' + ENDPOINT + '）：' + String((e && e.message) || e));
        }
      }, [token]);

      useEffect(function () {
        load();
        const t = setInterval(load, 5000);
        return function () { clearInterval(t); };
      }, [load]);

      const setDefaultCard = async function (groupKey, slot) {
        try {
          await fetch(ENDPOINT + '/trpg/panel/card', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ groupKey: groupKey, slot: slot }),
          });
          load();
        } catch (e) { /* 面板只是辅助，失败不弹窗 */ }
      };

      const importModule = async function () {
        setImportMsg('');
        try {
          const res = await fetch(ENDPOINT + '/trpg/panel/module', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ json: modJson }),
          });
          const j = await res.json();
          if (j.ok) {
            setImportMsg('已导入 ' + j.id + '（' + j.scenes + ' 幕），可在上面的模组下拉里选');
            setModJson('');
            load();
          } else {
            setImportMsg('导入失败：' + (j.error || ''));
          }
        } catch (e) {
          setImportMsg('导入失败：' + String((e && e.message) || e));
        }
      };

      const save = async function () {
        setSaved('');
        try {
          const res = await fetch(ENDPOINT + '/trpg/panel/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ token: token, moduleId: moduleId, workspaceDir: workspaceDir }),
          });
          const j = await res.json();
          if (j.ok) {
            try { window.localStorage.setItem('dsh-trpg/token', token); } catch (e) { /* 隐私模式就算了 */ }
          }
          setSaved(j.ok ? '已保存（令牌立即生效；模组下次 /trpg start 生效；工作区对新建会话生效）' : '保存失败：' + (j.error || ''));
          load();
        } catch (e) {
          setSaved('保存失败：' + String((e && e.message) || e));
        }
      };

      if (err) return h('div', { style: box }, h('div', { style: { color: '#c0392b' } }, err));

      const campaigns = (data && data.campaigns) || [];
      const modules = (data && data.modules) || [];
      const statusText = data
        ? '构建 ' + data.build + '｜运行 ' + Math.round((data.uptimeMs || 0) / 1000) + 's｜进行中 ' + data.busy
        : '加载中…';

      const head = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('strong', null, '跑团面板'),
        h('span', { style: { color: '#888', fontSize: 12 } }, statusText));

      const tokenRow = h('div', { style: row },
        h('span', { style: labelStyle }, '共享令牌'),
        h('input', {
          style: inputStyle, value: token, type: 'password',
          onChange: function (e) { setToken(e.target.value); },
          placeholder: '与 Roost 的 trpg-forwarder 一致（只存本地浏览器）',
        }));

      const moduleRow = h('div', { style: row },
        h('span', { style: labelStyle }, '模组'),
        h('select', {
          style: inputStyle, value: moduleId,
          onChange: function (e) { setModuleId(e.target.value); },
        }, modules.map(function (m) {
          return h('option', { key: m.id, value: m.id }, m.title + '（' + m.id + '，' + m.scenes + ' 幕）');
        })));

      const wsRow = h('div', { style: row },
        h('span', { style: labelStyle }, '工作区目录'),
        h('input', {
          style: inputStyle, value: workspaceDir,
          onChange: function (e) { setWorkspaceDir(e.target.value); },
          placeholder: '留空＝~/.dsh/dsh-trpg/workspace',
        }));

      const actions = h('div', { style: row },
        h('button', { onClick: save, style: { padding: '5px 14px', borderRadius: 6, cursor: 'pointer' } }, '保存'),
        h('button', { onClick: load, style: { padding: '5px 12px', borderRadius: 6, cursor: 'pointer' } }, '刷新'),
        saved ? h('span', { style: { color: '#2b7a4b', fontSize: 12 } }, saved) : null);

      const importBox = h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '1px dashed #ddd' } },
        h('div', { style: { color: '#666', fontSize: 12, marginBottom: 6 } },
          '导入模组：粘贴 JSON（{ "id": "my-mod", "title": "…", "opening": "…", "scenes": [{ "sceneId": "start", "title": "…", "desc": "…", "clues": [], "exits": [] }] }）'),
        h('textarea', {
          value: modJson,
          onChange: function (e) { setModJson(e.target.value); },
          placeholder: '{ "id": "my-mod", "title": "自定义模组", "scenes": [ … ] }',
          style: {
            width: '100%', minHeight: 96, boxSizing: 'border-box', padding: 8, borderRadius: 6,
            border: '1px solid var(--dsh-border, #ccc)', fontFamily: 'ui-monospace, monospace',
            fontSize: 12, background: 'var(--dsh-bg, #fff)', color: 'var(--dsh-text, #111)',
          },
        }),
        h('div', { style: row },
          h('button', { onClick: importModule, style: { padding: '5px 14px', borderRadius: 6, cursor: 'pointer' } }, '导入模组'),
          importMsg ? h('span', { style: { color: '#2b7a4b', fontSize: 12 } }, importMsg) : null));

      const list = h('div', { style: { marginTop: 14 } },
        h('strong', null, '进行中的团'),
        campaigns.length === 0
          ? h('div', { style: { color: '#888' } }, '还没有团。在群里发 /trpg start 开一场。')
          : campaigns.map(function (c) { return h(CampaignLine, { key: c.groupKey, campaign: c, onSetDefault: setDefaultCard }); }));

      return h('div', { style: box }, head, tokenRow, moduleRow, wsRow, actions, importBox, list);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-trpg' }, Panel);
        });
      },
    };
  },
});
