// dsh-trpg 入口：起 17322 收事件、管会话、合批、驱动 DSH、直发群聊。
// 版本戳：由 host.js 每次 apply 时刷新，用来让子模块绕开 ESM 缓存
const STAMP = globalThis.__TRPG_STAMP__ || '0';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const { readConfig } = await import('./config.js?t=' + STAMP);
const { openDb, closeDb, ensureSession, getSession, updateSession, listInvestigators, getInvestigator, findByOpenid, getScene, campaignFacts, upsertScene, purgeCampaign } = await import('./db.js?t=' + STAMP);
const { createOutbound } = await import('./outbound.js?t=' + STAMP);
const { createBatcher } = await import('./batcher.js?t=' + STAMP);
const { createTurnRunner } = await import('./turn.js?t=' + STAMP);
const { createTools } = await import('./tools.js?t=' + STAMP);
const R = await import('./rules-coc7.js?t=' + STAMP);
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
      helpText: z
        .string()
        .default('')
        .description('指令提示文本（/help 或 /帮助 回复的内容）。留空用内置版本；管理页可编辑'),
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
  // 启动时先跟 Roost 对一次令牌（异步，不阻塞监听）
  setTimeout(() => { pullForwarderToken({ force: true }).catch(() => {}); }, 1200);

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

  /**
   * F1：出站按群实例化。
   *
   * 以前全局只有一个 outbound，beginTurn/endTurn 改的是模块级 turn，
   * 却按群使用 —— 两个群同时跑团就会串台：
   * A 群结算完 endTurn()，B 群后续的 broadcast() 因为 turn === null 直接 return，
   * 骰子静默消失；turnBudget=8 也被两群共享。
   * 现在 Map<groupKey, outbound>，每个群一份 turn 与预算。
   */
  const outbounds = new Map();
  function outboundOf(groupKey) {
    let o = outbounds.get(groupKey);
    if (!o) {
      o = createOutbound({ cfg, log: warn });
      outbounds.set(groupKey, o);
      if (outbounds.size > 200) {
        // 群多起来之后旧实例没有任何用处，清一批防止无限增长
        const oldest = outbounds.keys().next().value;
        if (oldest !== groupKey) outbounds.delete(oldest);
      }
    }
    return o;
  }
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
  /**
   * 递归补 additionalProperties（F9）。
   *
   * DSH 的严格子集校验要求**每一个** `type: 'object'` 节点都显式写这个字段。
   * 以前只给顶层加，`trpg_combat_tracker` 的 `enemies.items`（一个 object）
   * 就漏了，注册时被拒：
   *   unsupported JSON schema: parameters.enemies.items.additionalProperties …
   * 结果是「挂工具 成功 5/6」，战斗工具永远装不上 —— AI 想打也打不了。
   */
  function deepFixSchema(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(deepFixSchema);
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepFixSchema(v);
    if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = true;
    if (out.properties && typeof out.properties === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(out.properties).map(([k, v]) => [k, deepFixSchema(v)]),
      );
    }
    if (out.items) out.items = deepFixSchema(out.items);
    return out;
  }

  function toJsonSchema(params) {
    const properties = {};
    const required = [];
    for (const [name, spec] of Object.entries(params || {})) {
      const { required: req, ...rest } = spec || {};
      properties[name] = deepFixSchema(rest);
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
    const defs = createTools({ db, cfg, outbound: outboundOf(gk), log: warn, groupKey: gk, getTurn: () => activeTurns.get(gk) });
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
    const out = outboundOf(gk);
    out.beginTurn(turnCtx.msgIdPool);

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
      await out.send({
        groupId: turnCtx.groupOpenid,
        content: String(text).slice(0, 1800),
        direct: Boolean(turnCtx.direct),
      });
      const fresh = getSession(db, gk);
      updateSession(db, gk, { turnId: (fresh?.turnId || 1) + 1 });
    } catch (error) {
      warn(`第 ${s.turnId} 回合失败：${error?.message || error}`);
      logFile(`回合失败 turn=${s.turnId} kind=${error?.kind || ''} msg=${error?.message || error}`);
      await out.send({
        groupId: turnCtx.groupOpenid,
        content: '⚠️ 守密人这边出了点问题，本轮状态已保留，行动可以重发。',
        direct: Boolean(turnCtx.direct),
      });
    } finally {
      out.endTurn();
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
    // 单聊：groupId 就是对方 openid，回复要走 sendC2C 而不是 sendGroup
    const direct = Boolean(evt.direct);

    if (isCmd) {
      let r;
      try {
        r = handleCommand({ text, evt: normalized, db, cfg });
      } catch (error) {
        warn(`指令执行失败（${text.slice(0, 20)}）：${error?.message || error}`);
        const oc = outboundOf(gk);
        oc.beginTurn([evt.msgId]);
        await oc.send({ groupId: evt.groupId, content: '⚠️ 指令执行出错，已记录到 plugin.log。', replyMsgId: evt.msgId, direct });
        oc.endTurn();
        return;
      }
      if (!r.handled) return;
      const oc = outboundOf(gk);
      oc.beginTurn([evt.msgId]);
      if (r.reply) {
        await oc.send({ groupId: evt.groupId, content: r.reply, replyMsgId: evt.msgId, direct });
      }
      if (r.instant) {
        await runTurn({
          groupKey: gk,
          groupOpenid: evt.groupId,
          direct,
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
      oc.endTurn();
      return;
    }

    if (!s || s.status !== 'running') return;
    const res = batcher.push(normalized);
    if (res?.queued) {
      // 结算中：告诉玩家收到了，别让他以为消息丢了
      const oj = outboundOf(gk);
      oj.beginTurn([evt.msgId]);
      await oj.send({ groupId: evt.groupId, content: '⏳ 守密人正在结算上一轮，你这条已记入下一轮。', replyMsgId: evt.msgId });
      oj.endTurn();
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
    /**
     * handleRequest 现在是 async（事件路径要先跟 Roost 对令牌）。
     * 这里必须接住 promise 的 reject —— 宿主把 uncaughtException 当 fatal，
     * 一个未处理的 rejection 就能让整个插件宿主退出。
     */
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
      handleRequest(req, res, send).catch((e) => warn('处理请求失败：' + (e?.message || e)));
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
  /** HTML 转义：页面里所有来自配置/数据库的值都要过一遍 */
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /**
   * 管理页（0.14 版）。
   *
   * 三件事：填令牌、选模组、导入模组。样式跟系统配色走，不引用任何外部资源。
   * 表单提交走 `/trpg/panel/config`，和 Client 面板同一个接口。
   */
  /**
   * 指令清单。管理页用来列表展示。
   *
   * ⚠️ 改动 `commands.js` 的 CN_ALIASES 时同步这张表，否则管理页会和实际行为对不上。
   * 单独维护一份是因为这里要中文说明，而别名表只有映射关系。
   */
  const COMMAND_TABLE = [
    { g: '开局与进度' },
    { cn: '/开始 · /开局 · /继续', en: '/trpg start', desc: '开一场，或接着上次继续' },
    { cn: '/暂停', en: '/trpg pause', desc: '暂停，状态都保留' },
    { cn: '/结束 · /结团', en: '/trpg end', desc: '结束这一场' },
    { cn: '/重开', en: '/trpg restart', desc: '重开当前模组' },
    { cn: '/重置', en: '/trpg reset', desc: '清空本群跑团数据' },
    { cn: '/模组 <id>', en: '/trpg module <id>', desc: '切换模组' },
    { cn: '/状态 · /团', en: '/trpg status', desc: '看当前回合与场景' },
    { g: '角色卡' },
    { cn: '/录卡 亚瑟 hp12 san65 侦查70', en: '/st …', desc: '录入角色卡（同名覆盖）' },
    { cn: '/建卡', en: '/st new', desc: '再建一张新卡' },
    { cn: '/角色卡 · /卡', en: '/pc', desc: '看自己的卡' },
    { cn: '/切换角色 P2', en: '/pc use P2', desc: '换成另一张卡行动' },
    { cn: '/解绑', en: '/pc release', desc: '解除当前绑定' },
    { g: '检定与骰子' },
    { cn: '/检定 侦查', en: '/ra 侦查', desc: '技能检定' },
    { cn: '/检定 侦查 困难', en: '/ra 侦查 困难', desc: '困难 / 奖励1 / 惩罚1 都可加' },
    { cn: '/理智 0/1d6', en: '/sc 0/1d6', desc: '理智检定' },
    { cn: '/骰 3d6', en: '/r 3d6', desc: '自由掷骰：3d6、1d100+5、4d6k3' },
    { cn: '/幸运', en: '/luck', desc: '花幸运改判' },
    { cn: '/房规 <0-5>', en: '/setcoc <0-5>', desc: '大成功 / 大失败边界' },
    { g: '其他' },
    { cn: '/战术 /暂离', en: '/tactic /afk', desc: '战斗姿态 / 暂时离线' },
    { cn: '/撤销', en: '/undo', desc: '回滚上一个回合' },
    { cn: '/记录 <内容>', en: '/note <内容>', desc: '记一条战役事实' },
    { cn: '/帮助 · /指令', en: '/help', desc: '看提示（内容可在「设置」里改）' },
  ];

  function renderAdminPage() {
    const live = readOverrides();
    const token = String(live.token ?? cfg.token ?? '');
    const moduleId = String(live.moduleId ?? cfg.moduleId ?? cfg.defaultModule ?? 'mist-harbor');
    const workspaceDir = String(live.workspaceDir ?? cfg.workspaceDir ?? '');
    const helpText = String(live.helpText ?? cfg.helpText ?? '');
    const opts = MODULE_IDS.map((id) => {
      const sel = id === moduleId ? ' selected' : '';
      return `<option value="${esc(id)}"${sel}>${esc(MODULES[id].title)}（${esc(id)}，${MODULES[id].scenes.length} 幕）</option>`;
    }).join('');
    const rows = db.prepare('SELECT * FROM trpg_sessions ORDER BY updated_at DESC').all();
    const fmtTime = (ms) => (ms ? new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) : '—');
    const bar = (cur, max, color) => {
      const c = Number(cur) || 0;
      const m = Number(max) || 0;
      const pct = m > 0 ? Math.min(100, Math.round((c / m) * 100)) : 0;
      return `<div class="bar"><i style="width:${pct}%;background:${color}"></i></div><span class="num">${c}/${m}</span>`;
    };

    /** 每个团一张卡：模组/回合/场景 + 调查员数值 + 剧情进度 + 战役记忆 */
    const list = rows.length
      ? rows.map((row) => {
          const gk = row.group_key;
          const session = getSession(db, gk);
          const party = listInvestigators(db, gk);
          const scene = getScene(db, session.moduleId, session.currentScene);
          const done = new Set(session.unlockedClues || []);
          const clues = scene?.clues || [];
          const facts = campaignFacts(db, gk);

          const cards = party.length
            ? party.map((inv) => {
                const st = inv.stats || {};
                const dv = R.derivedOf(st);
                const skills = Object.entries(inv.skills || {})
                  .sort((x, y) => (Number(y[1]) || 0) - (Number(x[1]) || 0))
                  .slice(0, 8)
                  .map(([k, v]) => `<span class="tag">${esc(k)} <b>${esc(v)}</b></span>`)
                  .join('');
                const items = (inv.items || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('') || '<span class="muted">—</span>';
                const tags = (inv.statusTags || []).map((x) => `<span class="tag warn">${esc(x)}</span>`).join('');
                return `<div class="inv">
                  <div class="invhead"><b>[${esc(inv.slot)}] ${esc(inv.charName)}</b>
                    <span class="muted">${inv.nickname ? '玩家：' + esc(inv.nickname) : '未绑定玩家'}${inv.afk ? ' · AFK' : ''}</span></div>
                  <table class="stats">
                    <tr><th>HP</th><td>${bar(st.hp, st.maxHp, '#dc2626')}</td>
                        <th>MP</th><td>${bar(st.mp, st.maxMp, '#2563eb')}</td></tr>
                    <tr><th>SAN</th><td>${bar(st.san, st.maxSan, '#7c3aed')}</td>
                        <th>幸运</th><td>${bar(st.luck, 99, '#ca8a04')}</td></tr>
                  </table>
                  <div class="line"><span class="muted">移动</span> ${esc(dv.mov)}　<span class="muted">体格</span> ${esc(dv.build)}　<span class="muted">伤害加值</span> ${esc(dv.db)}</div>
                  <div class="line">${tags || '<span class="tag ok">正常</span>'}</div>
                  <div class="line">${skills || '<span class="muted">未录技能</span>'}</div>
                  <div class="line">${items}</div>
                </div>`;
              }).join('')
            : '<div class="muted">还没有角色卡。群里发 <code>/st 名字 hp12 san65 侦查70</code> 录一张。</div>';

          const clueLines = clues.length
            ? clues.map((c) => {
                const got = done.has(c.id);
                return `<li class="${got ? 'got' : ''}"><b>${got ? '✔' : '○'} ${esc(c.id)}</b>
                  <span class="muted">${esc(c.cond)}</span>
                  <div class="secret">${got ? '' : '<span class="spoiler">剧透</span> '}${esc(c.secret)}</div></li>`;
              }).join('')
            : '<li class="muted">这个场景没有线索</li>';

          const factLines = facts.length
            ? facts.map((f) => `<li>[${'★'.repeat(Math.max(1, Number(f.importance) || 1))}] ${esc(f.fact)}</li>`).join('')
            : '<li class="muted">还没有战役记忆（/note 可记一条）</li>';

          /**
           * 每个团默认折叠 —— 展开就是剧透。
           * summary 只放「一眼就能公开」的概要（群名、状态、模组、回合、场景名），
           * 场景描述、线索、战役记忆全在展开之后。删除按钮也放进展开区，
           * 免得收起状态下手滑点到。
           */
          return `<details class="camp fold-camp" id="camp-${esc(gk)}">
            <summary>
              <b>${esc(row.group_name || gk.slice(0, 12))}</b>
              <span class="badge ${esc(row.status)}">${esc(row.status)}</span>
              <span class="muted small">${esc(gk)}</span>
              <span class="sm">${esc(MODULES[session.moduleId]?.title || session.moduleId)} · 第 ${esc(session.turnId)} 回合 · ${party.length} 名调查员</span>
            </summary>
            <div class="meta">模组 <b>${esc(MODULES[session.moduleId]?.title || session.moduleId)}</b> ·
              第 <b>${esc(session.turnId)}</b> 回合 ·
              场景 <b>${esc(scene?.title || session.currentScene)}</b> ·
              更新 ${esc(fmtTime(row.updated_at))}
              <button class="del" data-gk="${esc(gk)}" data-name="${esc(row.group_name || gk.slice(0, 12))}"
                title="删掉这个团的全部记录">删除</button></div>
            ${scene ? `<p class="desc">${esc(scene.desc)}</p>` : ''}
            <h3>调查员（${party.length}）</h3>
            <div class="cards">${cards}</div>
            <h3>剧情进度</h3>
            <ul class="clues">${clueLines}</ul>
            <h3>战役记忆</h3>
            <ul class="facts">${factLines}</ul>
          </details>`;
        }).join('')
      : '<div class="muted">还没有团。在群里发 <code>/trpg start</code> 开一场。</div>';

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-trpg 设置</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .muted { opacity: .6; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; padding: 16px; margin-top: 16px; }
  label { display: block; margin-top: 12px; font-weight: 600; }
  .hint { font-weight: 400; opacity: .65; font-size: 12px; margin-top: 2px; }
  input, select { width: 100%; box-sizing: border-box; padding: 7px 9px; margin-top: 5px; border-radius: 7px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Field; color: FieldText; font: inherit; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  button { padding: 7px 16px; border-radius: 7px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: ButtonFace; color: ButtonText; font: inherit; cursor: pointer; }
  button.primary { background: AccentColor; color: AccentColorText; border-color: transparent; }
  #msg { font-size: 13px; }
  .ok { color: #15803d; } .err { color: #b91c1c; }
  ul { padding-left: 18px; } li { margin: 4px 0; }
  code { background: color-mix(in srgb, CanvasText 8%, transparent); padding: 1px 5px; border-radius: 4px; }
  .camp { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 16px; margin-top: 16px; }
  h2 { font-size: 16px; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h3 { font-size: 13px; margin: 18px 0 8px; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
  .meta { font-size: 13px; opacity: .85; }
  .desc { font-size: 13px; opacity: .8; border-left: 3px solid color-mix(in srgb, CanvasText 15%, transparent); padding-left: 10px; margin: 10px 0; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  .badge.running { color: #15803d; border-color: #15803d55; }
  .badge.paused { color: #b45309; border-color: #b4530955; }
  .small { font-size: 11px; font-family: ui-monospace, monospace; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .inv { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; padding: 12px; }
  .invhead { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  table.stats { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
  table.stats th { text-align: left; width: 34px; font-weight: 600; opacity: .7; }
  table.stats td { padding: 2px 6px 2px 0; }
  .bar { display: inline-block; width: 64px; height: 6px; border-radius: 3px; background: color-mix(in srgb, CanvasText 12%, transparent); vertical-align: middle; overflow: hidden; }
  .bar i { display: block; height: 100%; }
  .num { font-size: 11px; margin-left: 6px; opacity: .8; font-variant-numeric: tabular-nums; }
  .line { font-size: 12px; margin-top: 6px; }
  .tag { display: inline-block; font-size: 11px; padding: 0 6px; margin: 2px 4px 2px 0; border-radius: 5px; background: color-mix(in srgb, CanvasText 8%, transparent); }
  .tag b { font-variant-numeric: tabular-nums; }
  .tag.warn { background: #b4530922; color: #b45309; }
  .tag.ok { background: #15803d22; color: #15803d; }
  ul.clues, ul.facts { margin: 0; padding-left: 18px; font-size: 13px; }
  ul.clues li, ul.facts li { margin: 6px 0; }
  .secret { font-size: 12px; opacity: .75; margin-top: 2px; }
  .spoiler { font-size: 10px; padding: 0 5px; border-radius: 4px; background: #b91c1c22; color: #b91c1c; margin-right: 4px; }
  footer { margin-top: 20px; font-size: 11px; opacity: .5; }
  details.fold { margin-top: 4px; }
  details.fold > summary { cursor: pointer; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  details.fold > summary::-webkit-details-marker { display: none; }
  details.fold > summary::before { content: '▸'; font-size: 11px; opacity: .6; }
  details.fold[open] > summary::before { content: '▾'; }
  details.fold > summary:hover { opacity: .85; }
  .tagx { font-size: 11px; font-weight: 400; padding: 0 7px; border-radius: 999px; border: 1px solid currentColor; }
  .tagx.on { color: #15803d; }
  .tagx.off { color: #b45309; }
  details.fold-card { padding: 12px 16px; }
  details.fold-card > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 10px;
    font-size: 15px; font-weight: 600; padding: 2px 0; }
  details.fold-card > summary::-webkit-details-marker { display: none; }
  details.fold-card > summary::before { content: '▸'; font-size: 11px; opacity: .6; }
  details.fold-card[open] > summary::before { content: '▾'; }
  details.fold-card[open] > summary { margin-bottom: 6px; }
  details.fold-card > summary:hover { opacity: .85; }
  .sm { font-size: 12px; font-weight: 400; opacity: .6; margin-left: auto; }
  textarea { width: 100%; box-sizing: border-box; margin-top: 5px; padding: 8px 9px; border-radius: 7px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Field; color: FieldText;
    font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
  button.del { margin-left: auto; font-size: 12px; padding: 2px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid color-mix(in srgb, #b91c1c 45%, transparent); background: transparent; color: #b91c1c; }
  button.del:hover { background: #b91c1c14; }
  button.del:disabled { opacity: .5; cursor: default; }
  table.cmds { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  table.cmds td { padding: 5px 8px; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); vertical-align: top; }
  table.cmds tr:last-child td { border-bottom: 0; }
  table.cmds tr.grp td { padding-top: 14px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
    opacity: .55; border-bottom: 0; }
  table.cmds td.cn { white-space: nowrap; font-weight: 600; }
  table.cmds td.en { white-space: nowrap; opacity: .6; font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
  table.cmds td.desc { opacity: .85; }
  details.fold-camp { padding: 14px 16px; }
  details.fold-camp > summary { cursor: pointer; list-style: none; display: flex; align-items: center;
    gap: 8px; flex-wrap: wrap; font-size: 16px; padding: 2px 0; }
  details.fold-camp > summary::-webkit-details-marker { display: none; }
  details.fold-camp > summary::before { content: '▸'; font-size: 11px; opacity: .6; }
  details.fold-camp[open] > summary::before { content: '▾'; }
  details.fold-camp > summary:hover { opacity: .85; }
  details.fold-camp[open] > summary { margin-bottom: 8px; }
  details.fold-camp .meta .del { margin-left: 12px; float: right; }
</style></head>
<body><main>
  <h1>dsh-trpg 设置</h1>
  <div class="muted">跑团插件的宿主半边。本机浏览器直接打开就能改，不依赖 DSH 前端。</div>

  <!--
    整个「设置」默认折叠。
    这张页面有两块内容：一块是低频的配置表单，一块是常看的跑团数据。
    默认把配置摊开，等于每次打开都先看一堆输入框；收进一个 details 元素里，
    一眼就能看到团和角色卡，要改的时候点一下。
    折叠不影响保存：input 仍在 DOM 里，保存时照样读得到当前值。
  -->
  <details class="card fold-card">
    <summary>
      设置
      <span class="tagx ${token ? 'on' : 'off'}">${token ? '令牌已配置' : '未配令牌'}</span>
      <span class="sm">模组 ${esc(MODULES[moduleId]?.title || moduleId)}</span>
    </summary>

    <div class="hint" style="margin-top:2px">必须与 Roost 插件 trpg-forwarder 的「共享令牌」完全一致。改完立即生效，并会自动同步到 Roost 侧。</div>
    <input id="token" value="${esc(token)}" placeholder="共享令牌，例如 trpg-shared-secret" autocomplete="off">

    <label>默认模组
      <div class="hint">下一次 <code>/trpg start</code> 用这个；跑团中可随时 <code>/trpg module &lt;id&gt;</code> 切换。</div>
    </label>
    <div style="display:flex;gap:8px;align-items:center">
      <select id="moduleId" style="flex:1">${opts}</select>
      <button id="importBtn" title="导入一个模组 JSON 文件">导入模组</button>
      <input id="importFile" type="file" accept=".json,application/json" style="display:none">
    </div>
    <div id="importMsg" class="hint" style="margin-top:6px"></div>

    <label>工作区目录
      <div class="hint">留空＝<code>~/.dsh/dsh-trpg/workspace</code>。对之后新建的会话生效。</div>
    </label>
    <input id="workspaceDir" value="${esc(workspaceDir)}" placeholder="留空使用默认目录">

    <label>指令提示
      <div class="hint">群里发 <code>/帮助</code> 时回的内容。留空用内置版本；改完保存即生效（下一句 <code>/帮助</code> 就能看到）。</div>
    </label>
    <textarea id="helpText" rows="10" placeholder="留空使用内置提示">${esc(helpText)}</textarea>

    <div class="row">
      <button class="primary" id="save">保存</button>
      <button id="reload">刷新</button>
      <span id="msg"></span>
    </div>
  </details>

  <!--
    指令清单默认折叠。
    它是「查一次就够」的内容，常驻会挤掉真正的跑团数据；放在设置下面，
    要查的时候点开。中文写法在前、英文在后 —— 群里用中文那列就够。
  -->
  <details class="card fold-card">
    <summary>
      指令
      <span class="sm">共 ${COMMAND_TABLE.filter((r) => r.cn).length} 条</span>
    </summary>
    <table class="cmds">
      ${COMMAND_TABLE.map((r) => (r.g
        ? `<tr class="grp"><td colspan="3">${esc(r.g)}</td></tr>`
        : `<tr><td class="cn">${esc(r.cn)}</td><td class="en">${esc(r.en)}</td><td class="desc">${esc(r.desc)}</td></tr>`)).join('')}
    </table>
    <div class="hint" style="margin-top:8px">/ 或 . 开头都行，中英文都可以。提示文本可在上面「设置 → 指令提示」里改。</div>
  </details>

  ${list}
  <footer>数据只读。改模组/工作区、导入模组用上面那块表单。</footer>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const msg = $('msg');
  function say(text, ok) { msg.textContent = text; msg.className = ok ? 'ok' : 'err'; }
  const tok = () => $('token').value.trim();
  const H = () => ({ 'content-type': 'application/json', 'x-trpg-token': tok() });

  $('save').onclick = async () => {
    try {
      const res = await fetch('/trpg/panel/config', {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({
          token: tok(),
          moduleId: $('moduleId').value,
          workspaceDir: $('workspaceDir').value.trim(),
          helpText: $('helpText').value,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        /**
         * 令牌同步的结果要如实说。
         * 以前不管同步成没成功都显示「已保存」，Roost 没在跑时用户
         * 以为改好了，结果群里照旧没反应 —— 那是最难查的一种状态。
         */
        if (j.tokenChanged && j.forwarder && !j.forwarder.ok) {
          const f = j.forwarder;
          const why = f.step === 'network'
            ? '连不上 Roost（' + f.base + '）——机器人没启动，或端口不对'
            : f.step === 'config'
              ? 'Roost 拒绝了配置写入（HTTP ' + f.status + '）' + (f.message ? '：' + f.message : '')
              : 'Roost 重载失败（HTTP ' + f.status + '）';
          say('令牌已存到 DSH 侧，但没能同步给 Roost：' + why + '。请到 Roost 面板 → 插件 → 跑团转发器里手动改成同一个值。', false);
        } else if (j.tokenChanged) {
          say('已保存：令牌已更新，并已同步给 Roost 侧的转发器（' + (j.forwarder ? j.forwarder.base : '') + '）', true);
        } else {
          say('已保存', true);
        }
      } else say('保存失败：' + (j.error || res.status), false);
    } catch (e) { say('保存失败：' + e.message, false); }
  };
  $('reload').onclick = () => location.reload();

  /**
   * 删除一个团的记录。
   * 二次确认用原生 confirm —— 这个动作不可撤销，值得多问一句；
   * 确认文案里带上角色卡和快照数量，删之前能看清代价。
   */
  document.querySelectorAll('button.del').forEach((btn) => {
    btn.onclick = async () => {
      const gk = btn.dataset.gk;
      const name = btn.dataset.name || gk.slice(0, 8);
      const NL = String.fromCharCode(10);
      const tip = ['删除「' + name + '」的全部跑团记录？', '', '会一并删掉角色卡、回合快照、战役记忆，且无法恢复。', '（模组文件不受影响）'].join(NL);
      if (!confirm(tip)) return;
      btn.disabled = true;
      btn.textContent = '删除中…';
      try {
        const res = await fetch('/trpg/panel/delete', {
          method: 'POST',
          headers: H(),
          body: JSON.stringify({ groupKey: gk }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.ok) {
          const r = j.removed || {};
          const sec = document.getElementById('camp-' + gk);
          if (sec) sec.remove();
          say('已删除「' + name + '」：角色卡 ' + (r.investigators ?? 0) + ' 张、快照 ' + (r.snapshots ?? 0) + ' 份、记忆 ' + (r.facts ?? 0) + ' 条', true);
        } else {
          say('删除失败：' + (j.error || res.status), false);
          btn.disabled = false;
          btn.textContent = '删除';
        }
      } catch (e) {
        say('删除失败：' + e.message, false);
        btn.disabled = false;
        btn.textContent = '删除';
      }
    };
  });

  const importBtn = $('importBtn');
  const importFile = $('importFile');
  const importMsg = $('importMsg');
  importBtn.onclick = () => importFile.click();
  importFile.onchange = async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    importMsg.className = 'hint';
    importMsg.textContent = '正在导入 ' + file.name + ' …';
    try {
      const text = await file.text();
      JSON.parse(text);
      const res = await fetch('/trpg/panel/module', {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ json: text }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        importMsg.className = 'hint ok';
        importMsg.textContent = '已导入 ' + j.id + '（' + j.scenes + ' 幕），下拉框已更新';
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.textContent = j.id + '（' + j.scenes + ' 幕）';
        $('moduleId').appendChild(opt);
        $('moduleId').value = j.id;
      } else if (res.status === 403) {
        importMsg.className = 'hint err';
        importMsg.textContent = '导入被拒：共享令牌不对。先把上面「共享令牌」填对并保存。';
      } else {
        importMsg.className = 'hint err';
        importMsg.textContent = '导入失败：' + (j.error || res.status);
      }
    } catch (e) {
      importMsg.className = 'hint err';
      importMsg.textContent = '导入失败：' + (e && e.message ? e.message : e);
    } finally {
      importFile.value = '';
    }
  };
</script>
</body></html>`;
  }

  /**
   * 把新令牌推给 Roost 侧的 trpg-forwarder 并重载它。
   *
   * 为什么必须做：面板只改 DSH 侧的话，转发器仍拿旧令牌来投递，
   * 表现是「群里发什么都没反应」而日志只有 403 —— 很难联想到是两边不一致。
   *
   * 两处以前的毛病：
   *   · base 写死 `http://127.0.0.1:8080`，Roost 换端口就永远静默失败
   *   · 不带 x-access-key，面板设了访问密钥就 401
   * 现在 base 从 `cfg.roostSendUrl` 推导（那是同一个面板的地址，只是路径不同），
   * 并返回结果给前端，管理页能把「同步失败」直接显示出来。
   */
  /**
   * 从 Roost 侧**拉取**令牌（反向同步）。
   *
   * 推（PATCH）只解决「DSH 改 → Roost 跟上」。反方向一直缺：
   * 用户在 Roost 面板里改了令牌，DSH 不知道，于是转发器用新令牌投递、
   * 这边用旧令牌校验 —— 一律 403，群里没反应，而两边各自看都「配置正常」。
   *
   * 拉取时机：启动时、每次保存后、以及面板读取前（10 秒缓存）。
   * 不一致就更新本地的 `cfg.token` 并写回 config.json。
   */
  let lastPullAt = 0;
  let lastPullOk = null;
  let lastPullWarned = false;
  async function pullForwarderToken({ force = false, override = false } = {}) {
    const now = Date.now();
    if (!force && now - lastPullAt < 10000) return lastPullOk;
    lastPullAt = now;
    let base = '';
    try { base = new URL(cfg.roostSendUrl).origin; } catch { base = 'http://127.0.0.1:8080'; }
    try {
      const res = await fetch(base + '/api/plugins/trpg-forwarder/r/token', {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) { lastPullOk = { ok: false, status: res.status }; return lastPullOk; }
      const data = await res.json();
      const remote = String(data.token || '');
      if (!remote) { lastPullOk = { ok: true, changed: false, reason: 'roost_empty' }; return lastPullOk; }
      if (safeEqualLocal(remote, String(cfg.token || ''))) {
        lastPullOk = { ok: true, changed: false };
        return lastPullOk;
      }
      /**
       * 不一致时的处理分两种，**默认不覆盖**：
       *
       *   · `override`（事件投递路径）：以 Roost 为准更新。
       *     那条请求本身就是 Roost 用它的令牌发来的 —— 它能发出来就说明
       *     Roost 是活的、那个值才是群里在用的，DSH 必须跟上，
       *     否则每一条事件都会被自己的鉴权挡在门外。
       *
       *   · 其它路径（启动、保存后）：只记日志。
       *     否则「DSH 刚改成新值、推送失败」的情况下，重启会被 Roost 的旧值
       *     悄悄盖回去，用户看到的是「改了又变回去了」。
       */
      if (!override) {
        lastPullOk = { ok: true, changed: false, mismatch: true, remote };
        if (!lastPullWarned) {
          lastPullWarned = true;
          warn('DSH 与 Roost 的共享令牌不一致（Roost 侧为旧值）。改一次令牌会自动对齐。');
        }
        return lastPullOk;
      }
      const before = String(cfg.token || '');
      cfg.token = remote;
      try { saveOverrides({ token: remote }); } catch { /* 写不进去也不影响本次运行 */ }
      logFile(`令牌已从 Roost 同步过来（本地 ${before ? '有旧值' : '为空'} → 已更新）`);
      warn('令牌已从 Roost 侧同步（检测到两边不一致，以 Roost 为准）');
      lastPullOk = { ok: true, changed: true };
      return lastPullOk;
    } catch (error) {
      lastPullOk = { ok: false, status: 0, message: String(error?.message || error) };
      return lastPullOk;
    }
  }

  /** 恒定时间比较（这个基线里还没有 safeEqual，单独给拉取逻辑用） */
  function safeEqualLocal(a, b) {
    const x = Buffer.from(String(a), 'utf8');
    const y = Buffer.from(String(b), 'utf8');
    const len = Math.max(x.length, y.length);
    let diff = x.length ^ y.length;
    for (let i = 0; i < len; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
  }

  async function syncForwarderToken(token, previous) {
    let base = '';
    try { base = new URL(cfg.roostSendUrl).origin; } catch { base = 'http://127.0.0.1:8080'; }
    const headers = { 'content-type': 'application/json' };
    if (cfg.roostAccessKey) headers['x-access-key'] = cfg.roostAccessKey;
    try {
      /**
       * `/r` 是 Roost 的插件路由前缀，不能省：
       * `ctx.registerRoute('PATCH', '/config')` 实际挂在
       * `/api/plugins/trpg-forwarder/r/config` 上。
       * 少写这个 r 就是 404「接口不存在」—— 看起来像「对方没这个接口」，
       * 实际是路径拼错。`/send` 之所以一直正常，是因为 roostSendUrl 里本来就有 /r/。
       */
      const c1 = await fetch(base + '/api/plugins/trpg-forwarder/r/config', {
        method: 'PATCH',
        headers,
        // from = 旧令牌：桥用它自证，避免任意本地进程随便改令牌
        body: JSON.stringify({ token, from: String(previous || '') }),
        signal: AbortSignal.timeout(4000),
      });
      if (!c1.ok) {
        const txt = await c1.text().catch(() => '');
        return { ok: false, base, step: 'config', status: c1.status, message: txt.slice(0, 120) };
      }
      const c2 = await fetch(base + '/api/plugins/trpg-forwarder/r/reload', {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(6000),
      });
      if (!c2.ok) return { ok: false, base, step: 'reload', status: c2.status, message: '' };
      warn('已同步转发器令牌并重载（' + base + '）');
      return { ok: true, base };
    } catch (error) {
      const message = String(error?.message || error);
      warn(`同步转发器令牌失败（${base}）：${message}`);
      return { ok: false, base, step: 'network', status: 0, message };
    }
  }

  function rejectUnauthorized(req, send) {
    /**
     * 每次鉴权前都试着跟 Roost 对一次（内部有 10 秒缓存，不会频繁打）。
     * 这是异步的，不能 await —— 那会把不需要网络的老路径也拖慢。
     * 用 fire-and-forget：这一轮可能仍用旧值，下一轮就对上了。
     */
    pullForwarderToken().catch(() => {});
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

  async function handleRequest(req, res, send) {
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
      /**
       * `/trpg/panel/config` 不走通用校验：令牌还没配或配错时，
       * 用户得能把它改回来，否则死循环。自定义规则见该 handler。
       */
      if (url.pathname !== '/trpg/panel/config' && rejectUnauthorized(req, send)) return;
    }

    /**
     * 模组清单（公开，无需令牌）。
     *
     * 只回 id / 标题 / 幕数，不含剧情线索 —— 但足以让 Client 面板把下拉框填满。
     * 之前面板只从 /trpg/panel 取模组，那个端点令牌不对就 403，
     * 于是下拉框永远是空的、点开什么都没有。
     */
    if (url.pathname === '/trpg/modules' && req.method === 'GET') {
      res.setHeader('access-control-allow-origin', '*');
      return send(200, {
        ok: true,
        modules: MODULE_IDS.map((id) => ({ id, title: MODULES[id].title, scenes: MODULES[id].scenes.length })),
      });
    }

    /**
     * 浏览器管理页：http://127.0.0.1:17322/trpg/admin
     *
     * 为什么要有它：Client 半边依赖 DSH 收集 bundle 的 dsh.client 清单，
     * link 安装时不一定成功；一旦没收集到，插件页里就只有介绍文字，
     * 改令牌只能手动编辑 config.json。这个页面由宿主直接渲染，绕开整条前端链路。
     */
    if ((url.pathname === '/trpg/admin' || url.pathname === '/') && req.method === 'GET') {
      try {
        const html = renderAdminPage();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch (error) {
        /**
         * 渲染失败不能只回一个 {"ok":false,"error":"internal"} —— 这个页面是排障入口，
         * 它自己坏了就没别的办法看状态。把错误原文和栈首行一起打出来。
         */
        warn('管理页渲染失败：' + (error?.stack || error));
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<pre style="font:13px/1.6 ui-monospace,monospace;padding:24px;white-space:pre-wrap">管理页渲染失败：\n'
          + String(error?.stack || error).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))
          + '</pre>');
      }
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
      /**
       * 自证规则（本端点不走通用校验，所以自己判）：
       *   · 当前没配令牌 → 允许设置（首次配置）
       *   · 带了正确的**当前**令牌 → 允许
       *
       * 只认当前令牌。曾经还有一条「带的令牌等于要写入的新值就放行」，
       * 那条等于没有鉴权：任何人 POST {token:"hacked"} + 头 x-trpg-token: hacked
       * 就能改掉令牌，还会顺手把 Roost 侧 trpg-forwarder 的令牌同步成同一个值
       * —— 攻击者不需要知道旧令牌，一次请求就完成接管（本机任意网页也能做，
       * 因为这里 CORS 放开 * 且允许 x-trpg-token 头）。
       * 忘记令牌的正路是手工改 ~/.dsh/dsh-trpg/config.json，不是开个后门。
       */
      const given = String(req.headers['x-trpg-token'] || '');
      const current = String(cfg.token || '');
      const seenAsCurrent = !current || given === current;
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', async () => {
        let patch = {};
        try { patch = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad_json' }); }
        const clean = {};
        if (typeof patch.token === 'string' && patch.token.trim()) clean.token = patch.token.trim();
        if (typeof patch.moduleId === 'string' && MODULES[patch.moduleId]) clean.moduleId = patch.moduleId;
        if (typeof patch.workspaceDir === 'string') clean.workspaceDir = patch.workspaceDir.trim();
        // 指令提示：允许写空（空 = 用内置版本），所以不判 truthy
        if (typeof patch.helpText === 'string') clean.helpText = patch.helpText;
        /**
         * F5：出站端点写死在 bundle 配置里时，用户只能去 DSH 设置页改。
         * 允许多一条覆盖路径，端口变了不用动代码。
         */
        if (typeof patch.roostSendUrl === 'string' && /^https?:\/\//.test(patch.roostSendUrl.trim())) {
          clean.roostSendUrl = patch.roostSendUrl.trim();
        }
        if (!seenAsCurrent) return send(403, { ok: false, error: 'bad_token' });
        try {
          const saved = saveOverrides(clean);
          // 令牌、模组、工作区都是「用一次读一次」的，所以这里改完立刻生效
          const oldToken = cfg.token;
          if (clean.token) cfg.token = clean.token;
          if (typeof clean.helpText === 'string') cfg.helpText = clean.helpText;
          if (clean.roostSendUrl) cfg.roostSendUrl = clean.roostSendUrl;
          warn(`面板更新配置：${Object.keys(clean).join('、')}`);
          /**
           * 令牌必须两边一致。面板只改 DSH 侧的话，转发器会拿旧令牌来投递，
           * 表现就是「群里发什么都没反应」且日志只有 403——今天就踩了一次
           * （我的测试把 config.json 写成 new-token，转发器还是旧值）。
           * 所以顺手把 Roost 侧 trpg-forwarder 的令牌也改掉并重载它。
           */
          /**
           * 同步结果**回传给前端**。
           * 以前是「发出去就不管」，Roost 没在跑时前端仍显示「已保存」，
           * 而群里照旧没反应 —— 用户完全不知道是哪一步断的。
           */
          let forwarder = null;
          if (clean.token) {
            forwarder = await syncForwarderToken(clean.token, oldToken);
            // 推完再把 Roost 的实际值拉回来核一次：推失败时本地会跟它保持一致
            await pullForwarderToken({ force: true });
          }
          return send(200, { ok: true, config: saved, tokenChanged: Boolean(clean.token), forwarder });
        } catch (error) {
          return send(500, { ok: false, error: String(error?.message || error) });
        }
      });
      return;
    }

    /**
     * 删掉一个团的记录。
     * 走 POST 而不是 DELETE：面板用的是简单请求，DELETE 会触发预检。
     */
    if (url.pathname === '/trpg/panel/delete' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
      req.on('end', () => {
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad_json' }); }
        const group = String(p.groupKey || '');
        if (!group) return send(400, { ok: false, error: 'missing_groupKey' });
        if (!getSession(db, group)) return send(404, { ok: false, error: 'no_campaign' });
        try {
          const removed = purgeCampaign(db, group);
          log(`已删除跑团记录 ${group.slice(0, 8)}（角色卡 ${removed.investigators}、快照 ${removed.snapshots}、记忆 ${removed.facts}）`);
          return send(200, { ok: true, groupKey: group, removed });
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

    /**
     * 事件是「Roost 用**它那边的**令牌投递过来的」。
     *
     * 如果用户在 Roost 面板里改了令牌，DSH 这边还停在旧值 —— 那么每一次投递
     * 都会被自己的鉴权挡成 403，群里彻底没反应，而两边各自看配置都正常。
     * 所以在校验之前先跟 Roost 对一次（内部 10 秒缓存，命中时零开销），
     * 不一致就以 Roost 为准更新本地令牌，之后再校验这一条。
     */
    // 事件是 Roost 发来的：它能发出来就说明 Roost 的令牌才是活的，以它为准
    await pullForwarderToken({ override: true }).catch(() => {});
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
    /**
     * F7：热重载时 host.js 会带新的 `?t=` 重新导入整张依赖图，
     * **旧模块图本身无法回收**（ESM 缓存只增不减）。这里能做的是把
     * 旧实例持有的资源放掉：HTTP 监听、定时器、SQLite 句柄、每个群的出站实例。
     * 不做这一步的话，每热重载一次就多一份活着的 server 与连接。
     */
    try { server.close(); } catch { /* 已关 */ }
    try { batcher.dispose(); } catch { /* 已停 */ }
    try { turnRunner.dispose(); } catch { /* 已停 */ }
    outbounds.clear();
    try { closeDb(db); } catch { /* 已关 */ }
    log('dsh-trpg 已卸载');
  });

  log(`dsh-trpg 就绪｜preset=${cfg.agentPreset}｜出站=${cfg.roostSendUrl}｜db=${cfg.dbPath}`);
}
