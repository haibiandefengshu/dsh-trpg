// dsh-trpg 入口：起 17322 收事件、管会话、合批、驱动 DSH、直发群聊。
// 版本戳：由 host.js 每次 apply 时刷新，用来让子模块绕开 ESM 缓存
const STAMP = globalThis.__TRPG_STAMP__ || '0';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const { readConfig } = await import('./config.js?t=' + STAMP);
const { openDb, closeDb, ensureSession, getSession, updateSession, listInvestigators, getInvestigator, findByOpenid, getScene, campaignFacts, upsertScene } = await import('./db.js?t=' + STAMP);
const { createOutbound } = await import('./outbound.js?t=' + STAMP);
const { createBatcher } = await import('./batcher.js?t=' + STAMP);
const { createTurnRunner } = await import('./turn.js?t=' + STAMP);
const { createTools } = await import('./tools.js?t=' + STAMP);
const { renderHud } = await import('./hud.js?t=' + STAMP);
const { handleCommand } = await import('./commands.js?t=' + STAMP);
const { MODULE_ID, MODULES, MODULE_IDS, scenesOf, openingOf } = await import('./scenario.js?t=' + STAMP);

export const BUILD = STAMP;

export const name = 'trpg';
export const inject = ['agents', 'sessions'];

/**
 * 可视配置。DSH 设置页会按这个 schema 渲染表单，改完即生效。
 * 共享令牌在这里能直接改 —— 它必须和 Roost 侧 trpg-forwarder 的「共享令牌」一致。
 */
let z = null;
/**
 * 这个包是 link 进来的，没有自己的 node_modules，裸 import 解析不到
 * schemastery。所以按三步找：包内 → DSH 安装目录（Electron 的
 * process.resourcesPath）→ 放弃（退化成无表单，插件照常工作）。
 */
for (const spec of [
  '@deepseek-ai/schemastery',
  process.resourcesPath
    ? `file:///${String(process.resourcesPath).replace(/\\/g, '/').replace(/^\/+/, '')}/app/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs`
    : '',
]) {
  if (!spec) continue;
  try {
    const mod = await import(spec);
    z = mod?.default ?? mod;
    if (z?.object) break;
    z = null;
  } catch { z = null; }
}
export const Config = z
  ? z.object({
      token: z.string().default('trpg-shared-secret').description('共享令牌：必须与 Roost 插件 trpg-forwarder 的「共享令牌」完全一致'),
      port: z.number().default(17322).description('本插件监听端口，Roost 侧「dsh-trpg 地址」要指向它'),
      roostSendUrl: z.string().default('http://127.0.0.1:8080/api/plugins/trpg-forwarder/r/send').description('Roost 出站端点：本插件靠它把骰子与剧情直发进群'),
      agentPreset: z.string().default('trpg-keeper').description('守密人使用的 DSH agent preset'),
      batchWindowMs: z.number().default(6000).description('合批窗口（毫秒）'),
      maxBatch: z.number().default(6).description('一次最多合并几条行动'),
      turnBudget: z.number().default(8).description('单回合最多直发几条消息'),
      workspaceDir: z
        .string()
        .default('')
        .description('跑团会话使用的工作区目录；留空＝~/.dsh/dsh-trpg/workspace。改完对之后新建的会话生效'),
      roostAccessKey: z
        .string()
        .default('')
        .description('Roost 面板访问密钥（webui.accessKey）。设了密钥就必须填，否则下行 /send 会被 401 挡住'),
      moduleId: z
        .union([z.const('mist-harbor'), z.const('midnight-express')])
        .default('mist-harbor')
        .description('开局用哪个模组（/trpg start 时生效；跑团中随时可用 /trpg module <id> 切换）'),
    })
  : undefined;

export function apply(ctx, rawConfig) {
  const cfg = readConfig(rawConfig);
  cfg.modules = MODULES;
  cfg.moduleIds = MODULE_IDS;
  cfg.openingOf = openingOf;
  /**
   * 用户导入的模组：放在 <dataDir>/modules/*.json，启动时合并进 MODULES。
   * 面板导入后也会当场合并，这样 /trpg module 立刻能看到，不用重启。
   */
  function loadUserModules() {
    try {
      const dir = join(cfg.dataDir, 'modules');
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const m = JSON.parse(readFileSync(join(dir, name), 'utf8'));
          const id = String(m.id || name.replace(/\.json$/, ''));
          if (!id || !Array.isArray(m.scenes) || !m.scenes.length) continue;
          MODULES[id] = { title: String(m.title || id), scenes: m.scenes, opening: String(m.opening || '') };
          if (!MODULE_IDS.includes(id)) MODULE_IDS.push(id);
        } catch { /* 坏文件跳过，不影响别的 */ }
      }
    } catch { /* 没有目录就是没导入过 */ }
  }
  loadUserModules();

  cfg.defaultModule = cfg.moduleId || cfg.defaultModule;
  // 面板保存的覆盖值（~/.dsh/dsh-trpg/config.json）优先于 bundle 里的 config 行
  try {
    const f = join(cfg.dataDir, 'config.json');
    const o = JSON.parse(readFileSync(f, 'utf8'));
    if (o.token) cfg.token = String(o.token);
    if (o.moduleId && MODULES[o.moduleId]) cfg.moduleId = String(o.moduleId);
    if (typeof o.workspaceDir === 'string' && o.workspaceDir) cfg.workspaceDir = o.workspaceDir;
  } catch { /* 没有覆盖文件就是默认值 */ }
  const log = (...args) => {
    const fn = ctx.logger?.info ?? console.log;
    try { fn.call(ctx.logger ?? console, ...args); } catch { console.log(...args); }
  };
  const warn = (...args) => {
    const fn = ctx.logger?.warn ?? console.warn;
    try { fn.call(ctx.logger ?? console, ...args); } catch { console.warn(...args); }
  };

  /** 把关键错误写进 <dataDir>/plugin.log：桌面端的 stdout 不好捞，这个文件随时能看 */
  function logFile(line) {
    try {
      mkdirSync(cfg.dataDir, { recursive: true });
      writeFileSync(join(cfg.dataDir, 'plugin.log'), `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' });
    } catch { /* 写不进去也不影响主流程 */ }
  }

  const db = openDb(cfg.dbPath);
  // 所有内置模组都先入库：切换模组时就只是改 current_scene / module_id，不用重启
  for (const id of MODULE_IDS) for (const sc of scenesOf(id)) upsertScene(db, sc);

  const outbound = createOutbound({ cfg, log: warn });
  const activeTurns = new Map();
  const toolsReady = new WeakSet(); // 按 agent 实例记，而不是 sessionId
  const seenEvents = new Map();
  const startedAt = Date.now();

  const turnRunner = createTurnRunner({ ctx, cfg, log: warn });

  /* ── DSH 会话 ─────────────────────────────────────────────────────── */

  async function resolveAgent(sid) {
    for (let i = 0; i < 20; i += 1) {
      // 先问控制器要一份「活的」agent：ctx.agents 里可能是上一轮结束后已停的实例，
      // 复用它会让第二轮 followup 直接失败（表现就是「只能开局，第二轮不动」）
      try {
        const r = await ctx.get('sessionController')?.resolveAgent?.(sid);
        if (r?.agent) return r.agent;
      } catch { /* 还没就绪 */ }
      const live = ctx.agents?.get?.(sid) || ctx.agents?.get?.(`session-${sid}`);
      if (live) return live;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`拿不到 DSH 会话 ${sid} 的 agent`);
  }

  async function workspaceId() {
    const wc = ctx.get('workspaceController');
    if (!wc?.create) return undefined;
    const dir = cfg.workspaceDir || join(cfg.dataDir, 'workspace');
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const r = await wc.create({ path: dir });
    return r?.workspace?.workspaceId || r?.workspaceId;
  }

  /**
   * 会话标题：`群名 · 模组名`。
   * 群名拿不到就退成群号后 6 位 —— 侧栏里至少能认出是哪个群。
   */
  function sessionTitle(gk, moduleId) {
    const s = getSession(db, gk);
    const groupName = String(s?.groupName || '').trim();
    const mod = MODULES[moduleId || s?.moduleId]?.title || moduleId || '跑团';
    const who = groupName || `群${String(gk).slice(-6)}`;
    return `${who} · ${mod}`;
  }

  /** 改名是「锦上添花」：拿不到 sessionController.rename 就静默跳过，不能让首轮挂掉 */
  async function renameSession(sid, title) {
    try {
      const sc = ctx.get('sessionController');
      if (typeof sc?.rename === 'function') {
        await sc.rename({ sessionId: sid, title });
        return true;
      }
    } catch (e) {
      warn(`会话改名失败（${title}）：${e?.message || e}`);
    }
    return false;
  }

  async function ensureAgent(gk) {
    const s = getSession(db, gk);
    if (s?.dshSessionId) {
      try {
        const agent = await resolveAgent(s.dshSessionId);
        // 换过模组、或老会话标题是空的：顺手改成「群名 · 模组名」
        const want = sessionTitle(gk);
        const live = String(agent?.session?.title || agent?.session?.header?.title || '');
        if (live !== want) await renameSession(s.dshSessionId, want);
        return agent;
      } catch (e) { warn(`旧会话拉不起来，重建：${e.message}`); }
    }
    const sc = ctx.get('sessionController');
    if (!sc?.create) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）');
    const r = await sc.create({ workspaceId: await workspaceId(), agentPreset: cfg.agentPreset });
    const sid = String(r.sessionId);
    updateSession(db, gk, { dshSessionId: sid });
    const title = sessionTitle(gk);
    await renameSession(sid, title);
    log(`为 ${gk} 新建 DSH 会话 ${sid.slice(-8)}（${cfg.agentPreset}）标题：${title}`);
    return resolveAgent(sid);
  }

  async function loadDefineTool() {
    try {
      const m = await import('@deepseek-ai/dsh-tools');
      return typeof m?.defineTool === 'function' ? m.defineTool : null;
    } catch { return null; }
  }

  /**
   * 扁平参数表 → 标准 JSON Schema。
   *
   * 我们的工具定义用 DSH 的原生扁平形状（`{ name: { type, required } }`），
   * 但 `ctx.tools.register` 收的是标准 JSON Schema。以前直接把扁平表交过去，
   * 注册器把键 `type` 的值当成 schema 遍历，报
   *   unsupported JSON schema: parameters.type must be a value schema object
   * → **6 个工具全部注册失败**，模型手里没有骰子工具，
   *   于是只会凭空叙事、永远不掷骰（表现得就是「扔骰子没有显示」）。
   *
   * `additionalProperties: false` 是硬要求：新版 DSH 的严格子集校验要求
   * 每个 object 节点显式写布尔值，缺了直接拒注册。
   */
  function toJsonSchema(params) {
    const properties = {};
    const required = [];
    for (const [name, spec] of Object.entries(params || {})) {
      const { required: req, ...rest } = spec || {};
      properties[name] = rest;
      if (req) required.push(name);
    }
    return {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    };
  }

  /**
   * 补齐 output 并挑一种参数形状。
   *
   * `output.render` 必须返回**内容块数组**；返回字符串会让 DSH 在
   * `content.some(...)` 上炸掉，模型看到的是「接口报错了」。
   */
  function shapeTool(def, defineTool) {
    const withOutput = {
      ...def,
      output: def.output ?? {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
      },
    };
    if (defineTool) return defineTool(withOutput);
    return { ...withOutput, parameters: toJsonSchema(def.parameters) };
  }

  async function ensureTools(agent, gk, sid) {
    if (agent && toolsReady.has(agent)) return true;
    const registry = agent?.ctx?.tools;
    if (!registry?.register) { warn('agent 没有 tools 服务，本群只能叙事'); return false; }
    const defs = createTools({ db, cfg, outbound, log: warn, groupKey: gk, getTurn: () => activeTurns.get(gk) });
    const defineTool = await loadDefineTool();
    const names = [];
    const failed = [];
    for (const def of defs) {
      try {
        registry.register(shapeTool(def, defineTool));
        names.push(def.name);
      } catch (e) {
        failed.push(def.name + ':' + e.message);
        warn(`工具 ${def.name} 没装上：${e.message}`);
      }
    }
    if (agent) toolsReady.add(agent);
    const line = `挂工具 ${gk.slice(0, 8)}｜成功 ${names.length}/${defs.length}｜defineTool=${defineTool ? 'yes' : 'no'}` +
      (failed.length ? `｜失败：${failed.join('; ')}` : '');
    log(line);
    logFile(line);
    return names.length > 0;
  }

  /* ── 单回合 ───────────────────────────────────────────────────────── */

  async function runTurn(turnCtx) {
    const gk = turnCtx.groupKey;
    const s = getSession(db, gk);
    if (!s || s.status !== 'running') return;
    const scene = getScene(db, s.moduleId, s.currentScene);
    const party = listInvestigators(db, gk);
    const actions = turnCtx.events.map((e) => {
      const inv = findByOpenid(db, gk, e.userId);
      const raw = String(e.text || '').replace(/^\[导演\]\s*/, '').trim();
      /**
       * 指令类消息（/trpg start、/luck、/undo）不是"调查员在做的事"。
       * 直接塞进【本轮调查员行动】会让模型以为玩家说了「/trpg start」，
       * 于是把它当台词复述出来。
       */
      const isCmd = raw.startsWith('/') || raw.startsWith('.');
      return {
        slot: inv?.slot || '',
        charName: inv?.charName || e.nickname || '未录卡调查员',
        nickname: e.nickname || '',
        text: isCmd ? '' : raw.slice(0, 500),
        openid: e.userId,
      };
    }).filter((a) => a.text || turnCtx.events.length > 0);
    const hud = renderHud({
      groupKey: gk,
      session: s,
      party,
      scene,
      actions,
      campaign: campaignFacts(db, gk),
    });
    const payload = turnCtx.extraText ? `${hud}\n\n${turnCtx.extraText}` : hud;

    activeTurns.set(gk, {
      turnId: s.turnId,
      primarySlot: actions[0]?.slot || s.defaultSlot || '',
      slots: new Set(actions.map((a) => a.slot).filter(Boolean)),
      isDirector: Boolean(turnCtx.isDirector),
      groupOpenid: turnCtx.groupOpenid,
      expiresAt: Date.now() + cfg.turnTimeoutMs,
    });
    outbound.beginTurn(turnCtx.msgIdPool);

    async function playOnce() {
      const agent = await ensureAgent(gk);
      const sid = agent?.session?.id ?? agent?.sessionId ?? '';
      await ensureTools(agent, gk, sid);
      return turnRunner.run(agent, payload);
    }

    try {
      let text;
      try {
        text = await playOnce();
      } catch (error) {
        /**
         * DSH 的 blocked 只有两种来源：会话被归档，或 goal 轮次被抢占。
         * 归档过的会话再也跑不动（每一轮都被 preStep 拒掉），而且**第一轮
         * 往往还是好的** —— 表现就是「只能开局，第二轮不动」。
         * 所以这里丢掉旧会话、重建一个，再重跑同一轮。
         */
        if (error?.kind === 'blocked') {
          logFile(`会话被 blocked，重建（旧 ${String(getSession(db, gk)?.dshSessionId || '').slice(-8)}）`);
          updateSession(db, gk, { dshSessionId: null });
          text = await playOnce();
          logFile('重建后这一轮成功');
        } else {
          throw error;
        }
      }
      await outbound.send({
        groupId: turnCtx.groupOpenid,
        content: String(text).slice(0, 1800),
      });
      const fresh = getSession(db, gk);
      updateSession(db, gk, { turnId: (fresh?.turnId || 1) + 1 });
    } catch (error) {
      warn(`第 ${s.turnId} 回合失败：${error?.message || error}`);
      logFile(`回合失败 turn=${s.turnId} kind=${error?.kind || ''} msg=${error?.message || error}`);
      await outbound.send({
        groupId: turnCtx.groupOpenid,
        content: `⚠️ 守密人这边出了点问题（${String(error?.message || error).slice(0, 80)}），本轮状态已保留，行动可以重发。`,
      });
    } finally {
      outbound.endTurn();
      activeTurns.delete(gk);
    }
  }

  const batcher = createBatcher({ cfg, log: warn, onRelease: runTurn });

  /* ── 事件处理 ─────────────────────────────────────────────────────── */

  function rememberEvent(id) {
    const now = Date.now();
    for (const [k, at] of seenEvents) if (now - at > 10 * 60 * 1000) seenEvents.delete(k);
    if (seenEvents.has(id)) return false;
    seenEvents.set(id, now);
    return true;
  }

  async function handleEvent(evt) {
    const gk = evt.groupUin || evt.groupId;
    if (!gk) return;
    if (!rememberEvent(evt.eventId || `${evt.msgId}`)) return;

    ensureSession(db, gk, { groupOpenid: evt.groupId, groupName: evt.groupName || '' });
    const s = getSession(db, gk);
    const text = String(evt.text || '').trim();
    const isCmd = text.startsWith('/');
    const normalized = { ...evt, groupKey: gk };

    if (isCmd) {
      let r;
      try {
        r = handleCommand({ text, evt: normalized, db, cfg });
      } catch (error) {
        warn(`指令执行失败（${text.slice(0, 20)}）：${error?.message || error}`);
        outbound.beginTurn([evt.msgId]);
        await outbound.send({ groupId: evt.groupId, content: `⚠️ 指令执行出错：${String(error?.message || error).slice(0, 80)}`, replyMsgId: evt.msgId });
        outbound.endTurn();
        return;
      }
      if (!r.handled) return;
      outbound.beginTurn([evt.msgId]);
      if (r.reply) {
        await outbound.send({ groupId: evt.groupId, content: r.reply, replyMsgId: evt.msgId });
      }
      if (r.instant) {
        await runTurn({
          groupKey: gk,
          groupOpenid: evt.groupId,
          events: [evt],
          msgIdPool: [evt.msgId],
          isDirector: false,
          extraText: r.instant,
        });
      }
      if (r.renameSession) {
        const cur = getSession(db, gk);
        if (cur?.dshSessionId) await renameSession(cur.dshSessionId, sessionTitle(gk));
      }
      if (r.go) batcher.release(gk).catch(() => {});
      outbound.endTurn();
      return;
    }

    if (!s || s.status !== 'running') return;
    const res = batcher.push(normalized);
    if (res?.queued) {
      // 结算中：告诉玩家收到了，别让他以为消息丢了
      outbound.beginTurn([evt.msgId]);
      await outbound.send({ groupId: evt.groupId, content: '⏳ 守密人正在结算上一轮，你这条已记入下一轮。', replyMsgId: evt.msgId });
      outbound.endTurn();
    }
  }

  /* ── HTTP 入口（17322）────────────────────────────────────────────── */

  /** 面板用：从 ~/.dsh/dsh-trpg/config.json 读覆盖配置（不存在就空） */
  function readOverrides() {
    try {
      const f = join(cfg.dataDir, 'config.json');
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch { return {}; }
  }

  function saveOverrides(patch) {
    const f = join(cfg.dataDir, 'config.json');
    const next = { ...readOverrides(), ...patch };
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(f, JSON.stringify(next, null, 2));
    return next;
  }

  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      try {
        if (res.headersSent) return;
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch { /* 连接已断，忽略 */ }
    };
    /**
     * **异常绝不允许逃出这里**。
     *
     * DSH 宿主把 uncaughtException 直接当 fatal 处理，插件一个回调抛错
     * 就能让整个桌面端退出（今天连崩三次）。所以整段处理包起来：
     * 出错就回 500 并记一行 warn，进程继续活。
     */
    try {
      handleRequest(req, res, send);
    } catch (error) {
      warn(`请求处理失败：${error?.message || error}`);
      send(500, { ok: false, error: 'internal' });
    }
  });

  /**
   * 共享令牌校验。
   *
   * 空令牌**不等于**「开箱可用」：监听的是 127.0.0.1，但本机任何进程都能
   * 往 /trpg/event 灌事件，让守密人拿用户的模型额度说话。所以空值一律拒绝，
   * 并在启动日志里说清要去设置页填；不预置弱口令（以前默认 trpg-shared-secret，
   * 全世界装完都是同一个密码，等于没有）。
   *
   * 返回 null 表示通过，否则返回应该立即发出的响应。
   */
  function rejectUnauthorized(req, send) {
    const liveToken = String(cfg.token || '');
    if (!liveToken) {
      send(503, { ok: false, error: 'token_not_configured', hint: '设置 → 插件 → dsh-trpg → 共享令牌，填一个与 Roost trpg-forwarder 相同的值' });
      return true;
    }
    const token = String(req.headers['x-trpg-token'] || '');
    if (token !== liveToken) {
      send(403, { ok: false, error: 'bad_token' });
      return true;
    }
    return false;
  }

  function handleRequest(req, res, send) {
    let url;
    try { url = new URL(req.url || '/', `http://${cfg.host}:${cfg.port}`); } catch { return send(400, { ok: false }); }

    if (url.pathname === '/trpg/state' && req.method === 'GET') {
      if (rejectUnauthorized(req, send)) return;
      const group = String(url.searchParams.get('group') || '');
      const row = group ? db.prepare('SELECT status FROM trpg_sessions WHERE group_key = ?').get(group) : null;
      return send(200, { ok: true, running: row?.status === 'running', status: row?.status || 'none' });
    }

    /**
     * 面板：浏览器跨端口调用，必须带 CORS。
     *
     * 但 CORS 放开 `*` 不等于「谁都能读」：面板端点能读角色卡、改令牌、
     * 写模组文件——以前它们完全不校验令牌，而 GET 还会把共享令牌明文吐回去，
     * 于是本机随便哪个网页（或一条站点隔离失效的请求）都能把令牌薅走再改配置。
     * 现在整组端点（OPTIONS 预检除外）都必须带 x-trpg-token。
     */
    if (url.pathname.startsWith('/trpg/panel')) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, x-trpg-token');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return send(204, {});
      if (rejectUnauthorized(req, send)) return;
    }

    if (url.pathname === '/trpg/panel' && req.method === 'GET') {
      const rows = db.prepare('SELECT group_key, status, module_id, current_scene, turn_id, default_slot FROM trpg_sessions ORDER BY updated_at DESC').all();
      const campaigns = rows.map((r) => ({
        groupKey: r.group_key,
        status: r.status,
        moduleId: r.module_id,
        scene: r.current_scene,
        defaultSlot: r.default_slot || '',
        turn: Number(r.turn_id) || 0,
        cards: db.prepare('SELECT slot_code, char_name, user_openid FROM trpg_investigators WHERE group_key = ? ORDER BY id').all(r.group_key)
          .map((c) => ({ slot: c.slot_code, name: c.char_name, bound: Boolean(c.user_openid) })),
      }));
      const live = readOverrides();
      return send(200, {
        ok: true,
        build: BUILD,
        uptimeMs: Date.now() - startedAt,
        busy: [...activeTurns.keys()].length,
        config: {
          // 只报「配没配」，不回显明文：这个端点以前把共享令牌原样吐给调用者
          tokenConfigured: Boolean(String(live.token ?? cfg.token ?? '')),
          moduleId: String(live.moduleId ?? cfg.moduleId ?? cfg.defaultModule ?? 'mist-harbor'),
          workspaceDir: String(live.workspaceDir ?? cfg.workspaceDir ?? ''),
        },
        modules: MODULE_IDS.map((id) => ({ id, title: MODULES[id].title, scenes: MODULES[id].scenes.length })),
        campaigns,
      });
    }

    /** 面板：把某个角色卡设为该群的默认行动者 */
    if (url.pathname === '/trpg/panel/card' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
      req.on('end', () => {
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad_json' }); }
        try {
        const group = String(p.groupKey || '');
        const slot = String(p.slot || '');
        if (!group) return send(400, { ok: false, error: '缺少 groupKey' });
        if (!getSession(db, group)) return send(404, { ok: false, error: '这个群没有团' });
        if (slot && !getInvestigator(db, group, slot)) return send(404, { ok: false, error: '没有角色卡 ' + slot });
        updateSession(db, group, { defaultSlot: slot });
        log(`默认卡 ${group.slice(0, 8)} → ${slot || '（清空）'}`);
        return send(200, { ok: true, groupKey: group, defaultSlot: slot });
      } catch (error) {
        warn(`默认卡设置失败：${error?.message || error}`);
        return send(500, { ok: false, error: String(error?.message || error) });
      } });
      return;
    }

    if (url.pathname === '/trpg/panel/module' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
      req.on('end', () => {
        let raw;
        try { raw = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad_json' }); }
        let mod;
        try { mod = typeof raw.json === 'string' ? JSON.parse(raw.json) : raw.module; } catch { return send(400, { ok: false, error: '模组 JSON 解析失败' }); }
        if (!mod || typeof mod !== 'object') return send(400, { ok: false, error: '缺少模组内容' });
        const id = String(mod.id || raw.id || '').trim();
        if (!/^[a-zA-Z0-9_-]{2,40}$/.test(id)) return send(400, { ok: false, error: 'id 只能用字母数字下划线短横，2~40 字' });
        if (!Array.isArray(mod.scenes) || !mod.scenes.length) return send(400, { ok: false, error: 'scenes 必须是非空数组' });
        const scenes = mod.scenes.map((sc, i) => ({
          moduleId: id,
          sceneId: String(sc.sceneId || sc.id || `scene_${i + 1}`),
          title: String(sc.title || sc.sceneId || `第 ${i + 1} 幕`),
          desc: String(sc.desc || sc.public_desc || ''),
          clues: Array.isArray(sc.clues) ? sc.clues : [],
          npcs: Array.isArray(sc.npcs) ? sc.npcs : [],
          exits: Array.isArray(sc.exits) ? sc.exits : [],
        }));
        const entry = { id, title: String(mod.title || id), opening: String(mod.opening || ''), scenes };
        try {
          const dir = join(cfg.dataDir, 'modules');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${id}.json`), JSON.stringify(entry, null, 2));
          for (const sc of scenes) upsertScene(db, sc);
          MODULES[id] = { title: entry.title, scenes, opening: entry.opening };
          if (!MODULE_IDS.includes(id)) MODULE_IDS.push(id);
          log(`已导入模组 ${id}（${scenes.length} 幕）`);
          return send(200, { ok: true, id, scenes: scenes.length, modules: MODULE_IDS.map((m) => ({ id: m, title: MODULES[m].title, scenes: MODULES[m].scenes.length })) });
        } catch (error) {
          return send(500, { ok: false, error: String(error?.message || error) });
        }
      });
      return;
    }

    if (url.pathname === '/trpg/panel/config' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        let patch = {};
        try { patch = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad_json' }); }
        const clean = {};
        if (typeof patch.token === 'string' && patch.token.trim()) clean.token = patch.token.trim();
        if (typeof patch.moduleId === 'string' && MODULES[patch.moduleId]) clean.moduleId = patch.moduleId;
        if (typeof patch.workspaceDir === 'string') clean.workspaceDir = patch.workspaceDir.trim();
        try {
          const saved = saveOverrides(clean);
          // 令牌、模组、工作区都是「用一次读一次」的，所以这里改完立刻生效
          if (clean.token) cfg.token = clean.token;
          warn(`面板更新配置：${Object.keys(clean).join('、')}`);
          /**
           * 令牌必须两边一致。面板只改 DSH 侧的话，转发器会拿旧令牌来投递，
           * 表现就是「群里发什么都没反应」且日志只有 403——今天就踩了一次
           * （我的测试把 config.json 写成 new-token，转发器还是旧值）。
           * 所以顺手把 Roost 侧 trpg-forwarder 的令牌也改掉并重载它。
           */
          if (clean.token) {
            const roostBase = 'http://127.0.0.1:8080';
            fetch(`${roostBase}/api/plugins/trpg-forwarder/config`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: clean.token }),
            })
              .then(() => fetch(`${roostBase}/api/plugins/trpg-forwarder/reload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
              .then(() => warn('已同步转发器令牌并重载'))
              .catch((e) => warn(`同步转发器令牌失败（请手动改 Roost 面板）：${e?.message || e}`));
          }
          return send(200, { ok: true, config: saved });
        } catch (error) {
          return send(500, { ok: false, error: String(error?.message || error) });
        }
      });
      return;
    }

    if (url.pathname === '/trpg/version' && req.method === 'GET') {
      return send(200, { ok: true, build: BUILD, startedAt, uptimeMs: Date.now() - startedAt });
    }

    if (url.pathname === '/trpg/health' && req.method === 'GET') {
      return send(200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        sessions: db.prepare('SELECT COUNT(*) AS n FROM trpg_sessions').get()?.n ?? 0,
        busy: [...activeTurns.keys()].length,
      });
    }

    if (url.pathname !== '/trpg/event' || req.method !== 'POST') return send(404, { ok: false });

    if (rejectUnauthorized(req, send)) return;

    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) req.destroy();
    });
    req.on('end', () => {
      // 设计要点：先回 200，再处理。Roost 那边绝不挂起等结果。
      send(200, { ok: true });
      let evt;
      try { evt = JSON.parse(body || '{}'); } catch { return; }
      handleEvent(evt).catch((e) => warn(`处理事件失败：${e?.message || e}`));
    });
  }

  server.on('error', (e) => warn(`HTTP 服务起不来（端口 ${cfg.port}）：${e.message}`));
  server.listen(cfg.port, cfg.host, () => {
    log(`dsh-trpg 已监听 http://${cfg.host}:${cfg.port}（token ${cfg.token ? '已配置' : '为空'}）`);
    if (!cfg.token) {
      warn(
        '共享令牌为空：/trpg/event 与 /trpg/state 会一律返回 503，Roost 那边会一直投递失败。\n' +
          '  去「设置 → 插件 → dsh-trpg → 共享令牌」填一个，和 trpg-forwarder 的「共享令牌」保持完全一致。',
      );
    }
  });

  ctx.on('dispose', () => {
    try { server.close(); } catch {}
    batcher.dispose();
    turnRunner.dispose();
    closeDb(db);
    log('dsh-trpg 已卸载');
  });

  log(`dsh-trpg 就绪｜preset=${cfg.agentPreset}｜出站=${cfg.roostSendUrl}｜db=${cfg.dbPath}`);
}
