// 斜杠快车道：毫秒级直回，不经过 AI。
// 版本戳：由 host.js 每次 apply 时刷新，用来让子模块绕开 ESM 缓存
const STAMP = globalThis.__TRPG_STAMP__ || '0';
const dice = await import('./dice.js?t=' + STAMP);
const rollExpression = dice.rollExpression;
const R = await import('./rules-coc7.js?t=' + STAMP);
import {
  tx, getSession, ensureSession, updateSession, listInvestigators, findByOpenid,
  insertInvestigator, updateInvestigator, getScene, latestSnapshot, restoreSnapshot, deleteSnapshot,
  addCampaignFact, upsertScene,
} from './db.js';
const { MODULE_ID, MODULES, MODULE_IDS, scenesOf, openingOf } = await import('./scenario.js?t=' + STAMP);

const STAT_KEYS = {
  hp: 'hp', maxhp: 'maxHp', hp上限: 'maxHp', mp: 'mp', maxmp: 'maxMp', san: 'san', maxsan: 'maxSan',
  san上限: 'maxSan', luck: 'luck', 幸运: 'luck', dex: 'dex', 敏捷: 'dex', int: 'int', 智力: 'int',
  str: 'str', 力量: 'str', con: 'con', 体质: 'con', pow: 'pow', 意志: 'pow', siz: 'siz', 体型: 'siz',
  edu: 'edu', 教育: 'edu',
};
const NAME_KEYS = /^(name|char|char_name|姓名|名字|角色|角色名)[=:：](.+)$/i;

export function parseSheet(input) {
  const raw = String(input ?? '').trim();
  const out = { name: '', stats: {}, skills: {} };
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const named = NAME_KEYS.exec(token);
    if (named) { out.name = named[2].trim(); continue; }
    const pair = /^([a-zA-Z\u4e00-\u9fa5]+)\s*[=:：]?\s*(\d+)\s*\/\s*(\d+)$/.exec(token);
    if (pair) {
      const key = STAT_KEYS[pair[1].toLowerCase()] ?? STAT_KEYS[pair[1]];
      if (key) {
        out.stats[key] = Number(pair[2]);
        const maxKey = { hp: 'maxHp', mp: 'maxMp', san: 'maxSan' }[key];
        if (maxKey) out.stats[maxKey] = Number(pair[3]);
        continue;
      }
    }
    const m = /^([a-zA-Z\u4e00-\u9fa5·]+?)\s*[=:：]?\s*(\d{1,3})%?$/.exec(token);
    if (m) {
      const key = STAT_KEYS[m[1].toLowerCase()] ?? STAT_KEYS[m[1]];
      if (key) out.stats[key] = Number(m[2]);
      else out.skills[m[1]] = Number(m[2]);
      continue;
    }
    if (!out.name && !/\d/.test(token)) out.name = token;
  }
  if (out.stats.hp != null && out.stats.maxHp == null) out.stats.maxHp = out.stats.hp;
  if (out.stats.mp != null && out.stats.maxMp == null) out.stats.maxMp = out.stats.mp;
  if (out.stats.san != null && out.stats.maxSan == null) out.stats.maxSan = out.stats.san;
  return out;
}

const defaultStats = () => ({ hp: 10, maxHp: 10, mp: 10, maxMp: 10, san: 50, maxSan: 50, luck: 50, dex: 50, int: 50 });

/**
 * 默认指令提示。管理页「指令提示」清空时用它。
 * 中文写法在前、英文在后 —— 群里先学会中文那列就够用了。
 */
export const DEFAULT_HELP = [
  '跑团指令（/ 或 . 开头都行；中英文都可以）',
  '',
  '【开局】',
  '  /开始 · /继续 或 /trpg start　　　　开一场 / 接着上次',
  '  /暂停 或 /trpg pause　　　　　　　 暂停',
  '  /结束 或 /trpg end　　　　　　　　 结团',
  '  /重开 /trpg restart　　　　　　　　重开本模组',
  '  /模组 或 /trpg module <id>　　　　 换模组',
  '  /状态 或 /trpg status　　　　　　　看当前进度',
  '',
  '【角色卡】',
  '  /录卡 亚瑟 hp12 san65 侦查70　　　 录入（/建卡 新建一张）',
  '  /角色卡 或 /pc　　　　　　　　　　 看自己的卡',
  '  /角色卡 P2 或 /pc use P2　　　　　 切换角色',
  '  /解绑 或 /pc release　　　　　　　 解除绑定',
  '',
  '【检定】',
  '  /检定 侦查　　　　　　　　　　　　 技能检定',
  '  /检定 侦查 困难 / 奖励1 / 惩罚1　　带难度或奖惩骰',
  '  /理智 0/1d6　　　　　　　　　　　　理智检定',
  '  /骰 3d6 · /骰 1d100+5 · /骰 4d6k3　自由掷骰',
  '  /幸运　　　　　　　　　　　　　　　花幸运改判',
  '',
  '【其他】',
  '  /战术 /暂离 /撤销 /记录 /房规 /帮助',
].join('\n');

/**
 * 中文命令别名。
 *
 * 群里聊天用中文，命令却是 /trpg start、/ra、/sc 这种缩写，新玩家记不住。
 * 这里把常用动作映射到规范命令，**英文写法全部保留**（老习惯不用改）。
 * 映射值写成 `[规范命令, 附带子命令]`，`/开始` 等价于 `/trpg start`。
 */
const CN_ALIASES = new Map([
  ['/开始', ['/trpg', 'start']],
  ['/开局', ['/trpg', 'start']],
  ['/继续', ['/trpg', 'start']],
  ['/暂停', ['/trpg', 'pause']],
  ['/结束', ['/trpg', 'end']],
  ['/结团', ['/trpg', 'end']],
  ['/重开', ['/trpg', 'restart']],
  ['/重置', ['/trpg', 'reset']],
  ['/模组', ['/trpg', 'module']],
  ['/状态', ['/trpg', 'status']],
  ['/团', ['/trpg', 'status']],
  ['/录卡', ['/st', null]],
  ['/建卡', ['/st', 'new']],
  ['/角色卡', ['/pc', null]],
  ['/卡', ['/pc', null]],
  ['/切换角色', ['/pc', 'use']],
  ['/解绑', ['/pc', 'release']],
  ['/检定', ['/ra', null]],
  ['/骰', ['/r', null]],
  ['/掷骰', ['/r', null]],
  ['/理智', ['/sc', null]],
  ['/疯狂', ['/sc', null]],
  ['/幸运', ['/luck', null]],
  ['/房规', ['/setcoc', null]],
  ['/撤销', ['/undo', null]],
  ['/记录', ['/note', null]],
  ['/战术', ['/tactic', null]],
  ['/暂离', ['/afk', null]],
  ['/帮助', ['/help', null]],
  ['/指令', ['/help', null]],
]);

export function handleCommand({ text: rawText, evt, db, cfg }) {
  const gk = evt.groupKey;
  // 命令前缀 / 和 . 都认（. 是 trpg-dice 插件的习惯，群里更顺手）
  const text = /^[.]/.test(String(rawText || '')) ? '/' + String(rawText).slice(1) : String(rawText || '');
  let arg = text.replace(/^[^\s]+\s*/, '').trim();
  let cmd = String(text.trim().split(/\s+/)[0] || '').toLowerCase();

  // 中文别名 → 规范命令（英文写法原样透传）
  const cn = CN_ALIASES.get(cmd);
  if (cn) {
    cmd = cn[0];
    if (cn[1]) arg = (cn[1] + (arg ? ' ' + arg : '')).trim();
  }
  const session = getSession(db, gk);
  const requireRunning = () => {
    if (!session) return '本群还没有跑团记录。管理员发 /trpg start 开局。';
    if (session.status !== 'running') return '本团已暂停。管理员发 /trpg start 继续。';
    return '';
  };

  if (cmd === '/trpg') {
    const act = (arg.split(/\s+/)[0] || 'status').toLowerCase();
    if (act === 'start') {
      const want = cfg.moduleId || cfg.defaultModule || MODULE_ID;
      const moduleId = MODULES[want] ? want : MODULE_ID;

      // ① 从没开过团：建团 + 念开场白
      if (!session) {
        ensureSession(db, gk, { groupOpenid: evt.groupId, status: 'running', moduleId });
        for (const sc of scenesOf(moduleId)) upsertScene(db, sc);
        const cur = getSession(db, gk);
        return {
          handled: true,
          reply: `【${MODULES[cur.moduleId]?.title || cur.moduleId}】\n${openingOf(cur.moduleId)}`,
        };
      }

      // ② 会话行是占位（模组还是 default）：补模组 + 重念开场白
      if (!MODULES[session.moduleId]) {
        updateSession(db, gk, { status: 'running', moduleId, currentScene: scenesOf(moduleId)[0]?.sceneId || 'start' });
        for (const sc of scenesOf(moduleId)) upsertScene(db, sc);
        const cur = getSession(db, gk);
        return {
          handled: true,
          reply: `【${MODULES[cur.moduleId]?.title || cur.moduleId}】\n${openingOf(cur.moduleId)}`,
        };
      }

      /**
       * ③ 已有团：这是**继续**，不是重开。
       *
       * 以前这里不分情况，一律回开场白 —— 玩家看到「雾港旧宅·门厅」那段
       * 又念一遍，以为团被重开了（2026-11-07 23:08 现场）。
       * 现在：恢复 running、报当前进度，并让守密人接着上一轮往下演。
       */
      const wasRunning = session.status === 'running';
      updateSession(db, gk, { status: 'running', pendingChecks: {} });
      const cur = getSession(db, gk);
      const scene = getScene(db, cur.moduleId, cur.currentScene);
      const where = scene?.title || cur.currentScene;
      if (wasRunning) {
        return {
          handled: true,
          reply: `本团正在跑（第 ${cur.turnId} 回合，${where}）。直接说你要做什么就行；要重来发 /trpg restart。`,
        };
      }
      return {
        handled: true,
        reply: `继续上一局：第 ${cur.turnId} 回合，${where}。`,
        instant: `【系统·继续】守密人回来了。不要重念开场白，也不要重述规则：用两三句把当前处境接上（谁在哪、刚才发生了什么、眼下的紧张点），然后给出 2~4 个行动选项。`,
      };
    }

    if (act === 'restart') {
      if (!session) return { handled: true, reply: '本群还没有跑团记录，直接发 /trpg start 开局。' };
      const moduleId = MODULES[session.moduleId] ? session.moduleId : (cfg.moduleId || MODULE_ID);
      for (const sc of scenesOf(moduleId)) upsertScene(db, sc);
      updateSession(db, gk, {
        status: 'running',
        moduleId,
        currentScene: scenesOf(moduleId)[0]?.sceneId || 'start',
        unlockedClues: [],
        combat: { active: false },
        pendingChecks: {},
        turnId: 1,
      });
      return {
        handled: true,
        reply: `已重开【${MODULES[moduleId]?.title || moduleId}】（角色卡保留）。\n${openingOf(moduleId)}`,
        renameSession: true,
      };
    }
    if (act === 'pause') {
      if (!session) return { handled: true, reply: '本群还没有跑团记录。' };
      updateSession(db, gk, { status: 'paused', combat: { active: false }, pendingChecks: {} });
      return { handled: true, reply: '已暂停。群里的话交回普通聊天（ai-chat），发 /trpg start 继续。' };
    }
    if (act === 'end' || act === 'stop') {
      if (!session) return { handled: true, reply: '本群还没有跑团记录。' };
      updateSession(db, gk, { status: 'idle', combat: { active: false }, pendingChecks: {} });
      return { handled: true, reply: '已结束本团。群里的话不再交给守密人，普通聊天恢复正常。想再开：/trpg start' };
    }

    /**
     * 诊断：工具清单。
     * 这段以前写在 /trpg 分支**外面**，靠 `act` 判断 —— 那个变量出了块就不存在，
     * 于是永远走不到（前面分支已经 return），真跑起来还会 ReferenceError。
     */
    if (act === 'tools') {
      const names = ['trpg_roll_check', 'trpg_resolve_followup', 'trpg_san_check', 'trpg_mutate_state', 'trpg_scene_action', 'trpg_combat_tracker'];
      return {
        handled: true,
        reply: [
          `跑团工具 ${names.length} 个：`,
          ...names.map((n) => `· ${n}`),
          '',
          '注册结果看 ~/.dsh/dsh-trpg/plugin.log 里的「挂工具 …」行（每回合刷新一条）。',
          '若显示「成功 5/6」，看失败那行的具体原因；「0/6」说明工具没挂上，AI 只会纯叙事。',
        ].join('\n'),
      };
    }

    if (act === 'reset' || act === 'rebuild') {
      if (!session) return { handled: true, reply: '本群还没有跑团记录。' };
      const before = session.dshSessionId || '';
      updateSession(db, gk, { dshSessionId: null });
      return { handled: true, reply: `已丢弃 DSH 会话${before ? ` ${before.slice(-8)}` : ''}，下一轮会自动重建。` };
    }

    if (act === 'module' || act === 'modules') {
      const want = (arg.split(/\s+/)[1] || '').trim();
      if (!want) {
        const lines = ['可用模组：'];
        for (const id of MODULE_IDS) lines.push(`- ${id}｜${MODULES[id].title}（${MODULES[id].scenes.length} 幕）${session?.moduleId === id ? ' ← 当前' : ''}`);
        lines.push('切换：/trpg module <id>');
        return { handled: true, reply: lines.join('\n') };
      }
      if (!MODULES[want]) return { handled: true, reply: `没有模组「${want}」。可用：${MODULE_IDS.join('、')}` };
      if (!session) return { handled: true, reply: '本群还没有跑团记录，先发 /trpg start。' };
      for (const sc of scenesOf(want)) upsertScene(db, sc);
      const first = scenesOf(want)[0]?.sceneId || 'start';
      updateSession(db, gk, { moduleId: want, currentScene: first, unlockedClues: [], combat: { active: false }, pendingChecks: {} });
      return {
        handled: true,
        reply: `已切换到【${MODULES[want].title}】（${want}），场景重置为入口。\n${openingOf(want)}`,
        renameSession: true,
      };
    }

    if (act === 'load') {
      const want = (arg.split(/\s+/)[1] || '').trim() || cfg.moduleId || MODULE_ID;
      const moduleId = MODULES[want] ? want : MODULE_ID;
      for (const sc of scenesOf(moduleId)) upsertScene(db, sc);
      ensureSession(db, gk, { groupOpenid: evt.groupId, status: 'running', moduleId });
      updateSession(db, gk, { moduleId, currentScene: scenesOf(moduleId)[0]?.sceneId || 'start', unlockedClues: [], combat: { active: false }, pendingChecks: {} });
      return { handled: true, reply: `已载入【${MODULES[moduleId].title}】。\n${openingOf(moduleId)}` };
    }
    return {
      handled: true,
      reply: session
        ? `模组 ${session.moduleId}（${MODULES[session.moduleId]?.title || '未知'}）｜状态 ${session.status}｜回合 ${session.turnId}｜场景 ${session.currentScene}\n命令：start / pause / end / load / module / status`
        : '本群还没有跑团记录。发 /trpg start 开局。',
    };
  }

  if (cmd === '/st') {
    /**
     * `/st new ...` = 建一张新卡（不覆盖自己已有的那张）。
     *
     * 一个群常常有「上一场留下的卡」「朋友借的卡」，只允许一人一卡的话，
     * 想换人就只能重录技能和物品。新卡默认不绑定，再用 /pc use 指定由谁来演。
     */
    const wantNew = /^new[ \t]+/i.test(arg);
    const body = wantNew ? arg.replace(/^new[ \t]+/i, '') : arg;
    const sheet = parseSheet(body);
    if (!sheet.name && !Object.keys(sheet.stats).length && !Object.keys(sheet.skills).length) {
      return { handled: true, reply: '用法：/st 亚瑟 hp12 san65 侦查70 锁匠45（也支持 hp=10/12）' };
    }
    const existing = wantNew ? null : findByOpenid(db, gk, evt.userId);
    if (existing) {
      const stats = { ...existing.stats, ...sheet.stats };
      const skills = { ...existing.skills, ...sheet.skills };
      updateInvestigator(db, gk, existing.slot, { stats, skills, ...(sheet.name ? { charName: sheet.name } : {}), nickname: evt.nickname || existing.nickname });
      return {
        handled: true,
        reply: `已更新 [${existing.slot}] ${sheet.name || existing.charName}\nHP ${stats.hp}/${stats.maxHp} MP ${stats.mp}/${stats.maxMp} SAN ${stats.san}/${stats.maxSan} 幸运 ${stats.luck}`,
      };
    }
    const used = new Set(listInvestigators(db, gk).map((i) => i.slot));
    let slot = 'P1';
    for (let i = 1; i <= 99; i += 1) { if (!used.has(`P${i}`)) { slot = `P${i}`; break; } }
    const stats = { ...defaultStats(), ...sheet.stats };
    const owner = wantNew ? (findByOpenid(db, gk, evt.userId) ? null : evt.userId) : evt.userId;
    insertInvestigator(db, gk, {
      slot, openid: owner, uin: evt.userUin, nickname: evt.nickname,
      charName: sheet.name || `调查员${slot.slice(1)}`, stats, skills: sheet.skills,
      items: [], statusTags: [], tactic: 'dodge', afk: false,
    });
    return {
      handled: true,
      reply: `录卡成功：[${slot}] ${sheet.name || `调查员${slot.slice(1)}`}\nHP ${stats.hp}/${stats.maxHp} MP ${stats.mp}/${stats.maxMp} SAN ${stats.san}/${stats.maxSan} 幸运 ${stats.luck}\n之后直接在群里说你要做什么就行（不用 @）。`,
    };
  }

  /**
   * /pc —— 角色卡管理。
   *
   * 为什么需要「切换」：一个群里玩家可能有多张卡（自己的、借用的、上一场留下的），
   * 而行动归谁，靠的是 openid → 槽位的绑定。没有切换就只能重新 /st 建一张，
   * 旧卡上的技能和物品全丢。
   */
  if (cmd === '/pc') {
    const sub = (arg.split(/\s+/)[0] || 'list').toLowerCase();
    const target = (arg.split(/\s+/)[1] || '').trim();
    const party = listInvestigators(db, gk);
    const mine = findByOpenid(db, gk, evt.userId);

    if (sub === 'list' || sub === 'ls') {
      if (!party.length) return { handled: true, reply: '本群还没有角色卡。发 /st 亚瑟 hp12 san65 侦查70 建一张。' };
      const lines = ['本群角色卡：'];
      for (const inv of party) {
        const st = inv.stats || {};
        const owner = inv.openid === evt.userId ? ' ← 你' : inv.nickname ? `（${inv.nickname}）` : '（未绑定）';
        const dv = R.derivedOf(st);
        lines.push(`[${inv.slot}] ${inv.charName}${owner}｜HP ${st.hp}/${st.maxHp} SAN ${st.san}/${st.maxSan}｜移动 ${dv.mov} 体格 ${dv.build} DB ${dv.db}`);
      }
      lines.push('切换：/pc use P2　｜　解除绑定：/pc release');
      return { handled: true, reply: lines.join('\n') };
    }

    if (sub === 'use' || sub === 'switch') {
      if (!target) return { handled: true, reply: '用法：/pc use P2（先用 /pc 看列表）' };
      const slot = /^p?\d+$/i.test(target) ? `P${target.replace(/^p/i, '')}` : target;
      const want = party.find((i) => i.slot.toUpperCase() === slot.toUpperCase() || i.charName === target || i.nickname === target);
      if (!want) return { handled: true, reply: `没有这张卡：${target}。发 /pc 看列表。` };
      if (want.openid === evt.userId) return { handled: true, reply: `你现在就是 [${want.slot}] ${want.charName}。` };
      const notes = [];
      /**
       * 一次事务里完成：先把这个 openid 从**所有**槽位上摘下来（一个群一张卡
       * 只绑一个人），再清空目标槽位原来的绑定，最后写新绑定。
       *
       * 早先分三条 UPDATE 写，碰到「目标槽位原先绑着别人」就会撞
       * UNIQUE(group_key, user_openid) 把整条命令打断——2026-11-07 实测踩到。
       */
      tx(db, () => {
        for (const inv of party) {
          if (inv.openid === evt.userId && inv.slot !== want.slot) updateInvestigator(db, gk, inv.slot, { openid: null });
        }
        if (want.openid && want.openid !== evt.userId) {
          notes.push(`⚠️ [${want.slot}] 原本绑在 ${want.nickname || '别人'} 名下，已改绑给你`);
          updateInvestigator(db, gk, want.slot, { openid: null });
        }
        if (mine && mine.slot !== want.slot) {
          notes.push(`已解除你在 [${mine.slot}] ${mine.charName} 上的绑定（卡还在，可用 /pc use ${mine.slot} 切回）`);
        }
        updateInvestigator(db, gk, want.slot, { openid: evt.userId, nickname: evt.nickname || want.nickname, ...(evt.userUin ? { uin: evt.userUin } : {}) });
      });
      const st = want.stats || {};
      return {
        handled: true,
        reply: [
          `已切换到 [${want.slot}] ${want.charName}`,
          `HP ${st.hp}/${st.maxHp} MP ${st.mp}/${st.maxMp} SAN ${st.san}/${st.maxSan} 幸运 ${st.luck}`,
          ...notes,
        ].join('\n'),
      };
    }

    if (sub === 'release') {
      if (!mine) return { handled: true, reply: '你当前没有绑定任何角色卡。' };
      updateInvestigator(db, gk, mine.slot, { openid: null });
      return { handled: true, reply: `已解除 [${mine.slot}] ${mine.charName} 的绑定（卡保留，可用 /pc use ${mine.slot} 切回）。` };
    }

    return { handled: true, reply: '用法：/pc 看列表　/pc use P2 切换　/pc release 解除绑定' };
  }

  if (cmd === '/status') {
    if (!session) return { handled: true, reply: '本群还没有跑团记录。发 /trpg start 开局。' };
    const scene = getScene(db, session.moduleId, session.currentScene);
    const lines = [`【${scene?.title || '未知场景'}】${session.status === 'running' ? '' : '（已暂停）'}`, `回合 ${session.turnId}｜模组 ${session.moduleId}`];
    for (const inv of listInvestigators(db, gk)) {
      const st = inv.stats || {};
      lines.push(`[${inv.slot}] ${inv.charName}${inv.nickname ? `（${inv.nickname}）` : ''} HP ${st.hp}/${st.maxHp} MP ${st.mp}/${st.maxMp} SAN ${st.san}/${st.maxSan} 幸运 ${st.luck}${inv.afk ? ' [AFK]' : ''}`);
    }
    const pend = Object.entries(session.pendingChecks || {});
    if (pend.length) lines.push(`待挽回：${pend.map(([slot, ck]) => `${slot} ${ck.skill}（可发 /luck）`).join('；')}`);
    return { handled: true, reply: lines.join('\n') };
  }

  /** /r 3d6 —— 纯掷骰，当场报数 */
  if (cmd === '/r' || cmd === '/roll') {
    return { handled: true, reply: rollExpression(arg).text };
  }

  /** /jrrp —— 今日人品：同一个人当天恒定 */
  if (cmd === '/jrrp') {
    const seed = `${cfg.jrrpSalt || 'trpg-dsh'}|${new Date().toISOString().slice(0, 10)}|${evt.userId}`;
    let hsh = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hsh ^= seed.charCodeAt(i);
      hsh = Math.imul(hsh, 16777619) >>> 0;
    }
    const v = hsh % 101;
    const face = v >= 95 ? '大吉' : v >= 75 ? '吉' : v >= 50 ? '平' : v >= 25 ? '小凶' : '凶';
    return { handled: true, reply: `🍀 ${evt.nickname || '你'} 的今日人品：${v}/100 —— ${face}` };
  }

  /** /sc 0/1d6 [P1] —— 不经过 AI 的理智检定 */
  if (cmd === '/sc') {
    const parts = arg.split(/\s+/).filter(Boolean);
    const expr = parts.find((x) => x.includes('/'));
    const who = parts.find((x) => !x.includes('/'));
    if (!expr) return { handled: true, reply: '用法：/sc 1/1d6（成功损失/失败损失），可加角色：/sc 0/1d4 P1' };
    const mine = findByOpenid(db, gk, evt.userId);
    const slot = who || mine?.slot || '';
    const inv = slot ? listInvestigators(db, gk).find((i) => i.slot.toUpperCase() === String(slot).toUpperCase()) : null;
    if (!inv) return { handled: true, reply: '找不到角色卡：先 /st 录卡，或用 /sc 1/1d6 P1 指定。' };
    const [okExpr, failExpr] = expr.split('/');
    const san = Number(inv.stats?.san) || 0;
    const roll = rollExpression('1d100');
    const passed = roll.total <= san;
    const loss = rollExpression(passed ? okExpr || '0' : failExpr || '1d6').total;
    const nextSan = Math.max(0, san - loss);
    const tags = new Set(inv.statusTags || []);
    if (nextSan === 0) tags.add('永久性疯狂');
    tx(db, () => updateInvestigator(db, gk, inv.slot, { stats: { ...inv.stats, san: nextSan }, statusTags: [...tags] }));
    return {
      handled: true,
      reply: `💀 【理智检定】${inv.charName}：D100 = ${roll.total} / ${san} → ${passed ? '成功' : '失败'}\nSAN -${Math.min(loss, san)} → ${nextSan}/${inv.stats?.maxSan ?? san}${nextSan === 0 ? '（永久性疯狂）' : ''}`,
    };
  }

  /** /help —— 一屏命令表 */
  if (cmd === '/help' || cmd === '/?') {
    /**
     * 提示文本优先读配置（管理页可编辑）。
     * 没有就用内置那份 —— 用户不折腾也能开团。
     */
    const custom = String(cfg?.helpText || '').trim();
    return {
      handled: true,
      tokens: 0,
      reply: custom || DEFAULT_HELP,
    };
  }

  /** /setcoc N —— 房规 0~5（大成功/大失败边界），默认 3 */
  if (cmd === '/setcoc') {
    const code = Number(arg.trim());
    if (!Number.isInteger(code) || code < 0 || code > 5) {
      return { handled: true, reply: '用法：/setcoc 0~5（默认 3）\n0 只认 1 大成功；1 不满 50 认 1、满 50 认 1-5；2 认 ≤5 且 ≤成功率；3 认 1-5（默认）；4 认 ≤5 且 ≤十分之一；5 认 1-2 且 <五分之一\n大失败同理随房规变化。' };
    }
    if (!session) return { handled: true, reply: '本群还没有跑团记录。' };
    updateSession(db, gk, { houseRule: code });
    return { handled: true, reply: `本群房规已设为 ${code}。` };
  }

  if (cmd === '/ra') {
    const [skillName, diff] = arg.split(/\s+/);
    if (!skillName) return { handled: true, reply: '用法：/ra 侦查 或 /ra 图书馆 困难' };
    const inv = findByOpenid(db, gk, evt.userId);
    const sv = R.skillValue(inv?.skills || {}, skillName);
    const bonus = /奖励/.test(arg) ? Number((/奖励\s*(\d)/.exec(arg) || [])[1] || 1)
      : /惩罚/.test(arg) ? -Number((/惩罚\s*(\d)/.exec(arg) || [])[1] || 1) : 0;
    const difficulty = ['hard', 'extreme'].includes(diff) ? diff : 'regular';
    const threshold = R.thresholdOf(sv.value, difficulty);
    const roll = R.rollWithBonus(bonus).roll;
    // F4：不传 houseRule 时用的是默认值，本群 /setcoc 对 /ra 无效（只有 AI 工具认房规）
    const level = R.successLevel(roll, threshold, Number(session?.houseRule ?? R.DEFAULT_HOUSE_RULE));
    return { handled: true, reply: `[${inv?.slot || '未录卡'}] ${inv?.charName || evt.nickname || '你'} 的【${sv.name}】：D100 = ${roll} / ${threshold}（${R.DIFFICULTY_CN[difficulty]}${bonus ? `，${bonus > 0 ? '奖励' : '惩罚'}${Math.abs(bonus)}` : ''}）→ ${R.LEVEL_CN[level]}` };
  }

  if (cmd === '/tactic') {
    const pick = /反击|fight/i.test(arg) ? 'fight_back' : /闪避|dodge/i.test(arg) ? 'dodge' : '';
    if (!pick) return { handled: true, reply: '用法：/tactic 闪避 或 /tactic 反击' };
    const inv = findByOpenid(db, gk, evt.userId);
    if (!inv) return { handled: true, reply: '你还没有角色卡，先发 /st 录卡。' };
    updateInvestigator(db, gk, inv.slot, { tactic: pick });
    return { handled: true, reply: `[${inv.slot}] ${inv.charName} 的受击反应已设为「${pick === 'dodge' ? '闪避' : '反击'}」。` };
  }

  if (cmd === '/afk') {
    const inv = findByOpenid(db, gk, evt.userId);
    if (!inv) return { handled: true, reply: '你还没有角色卡。' };
    updateInvestigator(db, gk, inv.slot, { afk: !inv.afk });
    return { handled: true, reply: `[${inv.slot}] ${inv.charName} ${inv.afk ? '已回到队伍' : '已进入 AFK 托管'}。` };
  }

  if (cmd === '/go') return { handled: true, go: true };

  if (cmd === '/note') {
    if (!arg) return { handled: true, reply: '用法：/note 这一条要记进战役记忆的事实' };
    addCampaignFact(db, gk, arg, 2);
    return { handled: true, reply: `已记入战役记忆：${arg.slice(0, 80)}` };
  }

  if (cmd === '/undo') {
    if (!session) return { handled: true, reply: '本群还没有跑团记录。' };
    const snap = latestSnapshot(db, gk);
    if (!snap) return { handled: true, reply: '没有可回滚的快照（至少要先结算过一轮）。' };
    restoreSnapshot(db, gk, snap.turnId);
    deleteSnapshot(db, gk, snap.turnId);
    return {
      handled: true,
      reply: `已回滚到第 ${snap.turnId} 回合开始前。被撤销的结算：${snap.summary || '（无记录）'}`,
      instant: `【系统时间线回滚】第 ${snap.turnId} 回合的结算（${snap.summary || '无记录'}）已撤销，数据库恢复到该回合开始前。请完全忽略聊天记录里上述结果，从撤销前的时间点重新推演。`,
    };
  }

  // /luck：待挽回检定存在时，由 host 走「即时叙事」分支；这里只做校验
  if (cmd === '/luck') {
    const inv = findByOpenid(db, gk, evt.userId);
    if (!inv) return { handled: true, reply: '你还没有角色卡。' };
    const check = (session?.pendingChecks || {})[inv.slot];
    if (!check) return { handled: true, reply: '现在没有待挽回的检定。' };
    const luck = Number(inv.stats?.luck) || 0;
    if (luck < check.luckCost) return { handled: true, reply: `幸运不足：需要 ${check.luckCost}，你只有 ${luck}。` };
    const stats = { ...inv.stats, luck: luck - check.luckCost };
    const pending = { ...(session.pendingChecks || {}) };
    delete pending[inv.slot];
    updateInvestigator(db, gk, inv.slot, { stats });
    updateSession(db, gk, { pendingChecks: pending });
    return {
      handled: true,
      instant: `【系统即时结算】${inv.charName} 花费 ${check.luckCost} 点幸运（剩余 ${stats.luck}），把【${check.skill}（${check.roll}/${check.threshold}）】正式改判为【常规成功】。请立刻接续刚才悬置的剧情，描写成功之后看到了什么。`,
      reply: `✨ ${inv.charName} 花费 ${check.luckCost} 点幸运（剩 ${stats.luck}），${check.skill} 改判成功。`,
    };
  }

  return { handled: false, running: !requireRunning() };
}
