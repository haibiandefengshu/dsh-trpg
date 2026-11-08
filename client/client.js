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
      /**
       * 模组列表走公开的 /trpg/modules（只有 id/标题/幕数），
       * 不再依赖 /trpg/panel —— 那个端点令牌不对就 403，下拉框会永远是空的。
       */
      const [modules, setModules] = useState([
        { id: 'mist-harbor', title: '雾港旧宅', scenes: 6 },
        { id: 'midnight-express', title: '午夜列车', scenes: 4 },
      ]);
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

      const loadModules = useCallback(async function () {
        try {
          const res = await fetch(ENDPOINT + '/trpg/modules');
          if (!res.ok) return;
          const j = await res.json();
          if (j && Array.isArray(j.modules) && j.modules.length) setModules(j.modules);
        } catch (e) { /* 拿不到就继续用内置清单 */ }
      }, []);

      useEffect(function () {
        loadModules();
        load();
        const t = setInterval(load, 5000);
        return function () { clearInterval(t); };
      }, [load, loadModules]);

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
          /**
           * 令牌同步结果如实说 —— 同步失败时不提示的话，
           * 用户以为改好了，群里却照旧没反应（最难查的一种状态）。
           */
          if (!j.ok) {
            setSaved('保存失败：' + (j.error || ''));
          } else if (j.tokenChanged && j.forwarder && !j.forwarder.ok) {
            const f = j.forwarder;
            const why = f.step === 'network'
              ? '连不上 Roost（' + f.base + '）'
              : f.step === 'config'
                ? 'Roost 拒绝了写入（HTTP ' + f.status + '）'
                : 'Roost 重载失败（HTTP ' + f.status + '）';
            setSaved('令牌已存到 DSH 侧，但没能同步给 Roost：' + why + '。请到 Roost 面板手动改成同一个值。');
          } else if (j.tokenChanged) {
            setSaved('已保存：令牌已更新，并已同步给 Roost 侧的转发器');
          } else {
            setSaved('已保存（模组下次 /trpg start 生效；工作区对新建会话生效）');
          }
          load();
        } catch (e) {
          setSaved('保存失败：' + String((e && e.message) || e));
        }
      };

      /**
       * 错误只占一行，不阻塞下面的控件。
       * 以前是 `if (err) return ...`：令牌一不对整个面板就被红字替换，
       * 连「共享令牌」输入框一起没了 —— 看得见提示、却没地方能改。
       */
      const errLine = err
        ? h('div', { style: { color: '#c0392b', fontSize: 12, marginTop: 6 } }, err)
        : null;

      const campaigns = (data && data.campaigns) || [];

      const statusText = data
        ? '构建 ' + data.build + '｜运行 ' + Math.round((data.uptimeMs || 0) / 1000) + 's｜进行中 ' + data.busy
        : '加载中…';

      const head = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('strong', null, '跑团面板'),
        h('span', { style: { color: '#888', fontSize: 12 } }, statusText));

      /**
       * 共享令牌单独成块：它是最常改、也最容易填错的一项，
       * 不该和模组/工作区混在同一列里。用可见文本框，核对不用猜。
       */
      const tokenRow = h('div', {
        style: {
          marginTop: 10, padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--dsh-border, #ddd)',
        },
      },
        h('div', { style: Object.assign({}, labelStyle, { marginBottom: 4, fontWeight: 600 }) }, '共享令牌'),
        h('input', {
          style: inputStyle, value: token, type: 'text',
          onChange: function (e) { setToken(e.target.value); },
          placeholder: '与 Roost 面板里「跑团转发器」的共享令牌一致',
          autocomplete: 'off',
        }),
        h('div', { style: { color: '#888', fontSize: 11, marginTop: 3 } },
          '填一次会记在浏览器里；两边不一致时，群里发指令不会有任何反应。' +
          (data && data.config && data.config.tokenConfigured === false ? '（宿主当前还没配令牌）' : '')));

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

      const ADMIN_URL = 'http://127.0.0.1:17322/trpg/admin';

      const openAdmin = function () {
        try {
          const w = window.open(ADMIN_URL, '_blank', 'noopener,noreferrer');
          if (!w) setSaved('浏览器拦了新窗口，请手动复制下面的地址打开。');
        } catch (e) {
          setSaved('浏览器拦了新窗口，请手动复制下面的地址打开。');
        }
      };

      const adminHint = h('div', {
        style: { marginTop: 12, paddingTop: 10, borderTop: '1px dashed #ddd' },
      },
        h('div', { style: row },
          h('button', { onClick: openAdmin, style: { padding: '5px 14px', borderRadius: 6, cursor: 'pointer' } }, '在浏览器中打开管理页')),
        h('div', { style: { color: '#888', fontSize: 11, marginTop: 6 } },
          '面板加载不出来（或令牌改不动）时用这个：',
          h('code', { style: { userSelect: 'all' } }, ADMIN_URL)));

      const list = h('div', { style: { marginTop: 14 } },
        h('strong', null, '进行中的团'),
        campaigns.length === 0
          ? h('div', { style: { color: '#888' } }, '还没有团。在群里发 /trpg start 开一场。')
          : campaigns.map(function (c) { return h(CampaignLine, { key: c.groupKey, campaign: c, onSetDefault: setDefaultCard }); }));

      return h('div', { style: box }, head, errLine, tokenRow, moduleRow, wsRow, actions, importBox, adminHint, list);
    }

    const PANEL_ID = 'dsh-trpg';

    /**
     * 侧边栏图标。
     *
     * 框架只把 `size` 传进来 —— 图标是**纯装饰**，点击和选中态由侧边栏自己管，
     * 它按 `id` 去 `main` 槽里找同 key 的面板打开。所以这里不需要任何事件处理。
     * 画一个骰子（20 面体的意思）：圆 + 中间的点。
     */
    function SidebarIcon(props) {
      const size = (props && props.size) || 20;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M12 2.8 20 7v10l-8 4.2L4 17V7z' }),
        h('path', { d: 'M12 8.2 15.4 10v4.2L12 16l-3.4-1.8V10z' }),
      );
    }

    /** 侧边栏打开的整页面板：给个能滚动的容器，别让内容顶到边 */
    function PanelPage(props) {
      return h('div', {
        style: {
          height: '100%', overflowY: 'auto', boxSizing: 'border-box',
          padding: '18px 22px', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6,
        },
      }, h(Panel, props));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 原来的位置：插件详情页里的配置块，保留
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register({ name: 'plugins.bundle.config', key: PANEL_ID }, Panel);
        });

        // 侧边栏入口：id 与下面的 main.key 一致，点图标就打开跑团面板
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: function () { return '跑团面板'; },
          }, SidebarIcon);
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelPage);
        });
      },
    };
  },
});
