// 6 个确定性工具。每个都：算 → 写库 →（公开时）当场直发播报卡 → 返回给模型。
// 版本戳：由 host.js 每次 apply 时刷新，用来让子模块绕开 ESM 缓存
const STAMP = globalThis.__TRPG_STAMP__ || '0';
const R = await import('./rules-coc7.js?t=' + STAMP);
import {
  listInvestigators, getInvestigator, getSession, updateSession, updateInvestigator,
  getScene, tx, ensureSnapshot, appendSummary, getSnapshot, restoreSnapshot, deleteSnapshot,
} from './db.js';

const HARD = { maxHpGain: 10, maxHpLoss: 30, maxSanDelta: 20, maxLuckDelta: 30 };

const cleanName = (n) => String(n ?? '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim();

function resolveTarget(party, input, primarySlot = '') {
  const raw = String(input ?? '').trim();
  if (!party.length) return { ok: false, error: '还没有角色卡，先让玩家发 /st 录卡。', candidates: [] };
  if (!raw || /^(sender|self|me|我|自己)$/i.test(raw)) {
    const self = party.find((i) => i.slot === primarySlot) || (party.length === 1 ? party[0] : null);
    if (self) return { ok: true, inv: self };
    return { ok: false, error: '没指定行动者，请传 P1/P2 或角色名。', candidates: party.map((i) => ({ id: i.slot, charName: i.charName })) };
  }
  const slotLike = /^p?\d+$/i.test(raw) ? `P${raw.replace(/^p/i, '')}` : '';
  const bySlot = party.filter((i) => (slotLike && i.slot.toUpperCase() === slotLike.toUpperCase()) || i.openid === raw || (i.uin && i.uin === raw));
  if (bySlot.length === 1) return { ok: true, inv: bySlot[0] };
  const byName = party.filter((i) => i.charName === raw || i.nickname === raw);
  if (byName.length === 1) return { ok: true, inv: byName[0] };
  const lc = raw.toLowerCase();
  const fuzzy = party.filter((i) => {
    const c = cleanName(i.charName).toLowerCase();
    return c && (c.includes(lc) || lc.includes(c));
  });
  if (fuzzy.length === 1) return { ok: true, inv: fuzzy[0] };
  const list = fuzzy.length ? fuzzy : party;
  return {
    ok: false,
    error: `找不到「${raw}」的唯一角色，请从 candidates 里选 id（如 P1）重试。`,
    candidates: list.map((i) => ({ id: i.slot, charName: i.charName, nickname: i.nickname })),
  };
}

export function createTools({ db, cfg, outbound, log = () => {}, groupKey, getTurn }) {
  const party = () => listInvestigators(db, groupKey);
  const sceneOf = (s) => (s ? getScene(db, s.moduleId, s.currentScene) : null);

  const withTurn = (summary, fn) => {
    const s = getSession(db, groupKey);
    if (!s) throw new Error('本群还没有跑团会话，管理员先发 /trpg start。');
    const out = tx(db, () => {
      ensureSnapshot(db, groupKey, s.turnId);
      const r = fn(s);
      if (summary) appendSummary(db, groupKey, s.turnId, summary);
      return r;
    });
    const t = getTurn();
    if (t) t.expiresAt = Date.now() + cfg.turnTimeoutMs;
    return out;
  };

  const director = () => Boolean(getTurn()?.isDirector);
  const card = (target) => {
    const hit = resolveTarget(party(), target, getTurn()?.primarySlot);
    if (!hit.ok) return { error: hit };
    return { inv: hit.inv };
  };
  const cardText = (inv) => `[${inv.slot}] ${inv.charName}`;

  const tools = [];

  /* ① 技能检定 */
  tools.push({
    name: 'trpg_roll_check',
    description: '为调查员掷 D100 技能检定（CoC 7e 成功等级）。需要判定时调用。公开检定会把点数当场发进群里；hidden=true 的侦查/聆听/心理学只回给你。普通失败会挂起「可花幸运 / 可孤注一掷」。',
    parameters: {
      targetPlayer: { type: 'string', required: true, description: 'P1/P2，或角色名、群昵称' },
      skillName: { type: 'string', required: true, description: '技能名，如 侦查 / 锁匠 / 斗殴' },
      difficulty: { type: 'string', enum: ['regular', 'hard', 'extreme'], description: '难度，默认 regular' },
      bonusPenalty: { type: 'number', description: '奖励骰 +1/+2，惩罚骰 -1/-2，默认 0' },
      hidden: { type: 'boolean', description: '隐藏检定：结果只给你，不发群' },
      reason: { type: 'string', description: '一句话说明为什么检定' },
    },
    async execute(args = {}) {
      /**
       * 没有角色卡也要能掷 —— 否则新手开局第一步就卡死：
       * 工具拒绝、群里什么都不显示，玩家以为骰子坏了。
       * 这里退化成「按技能基础值判定的临时检定」，并在播报里注明未录卡。
       */
      const got = card(args.targetPlayer);
      const ghost = got.error
        ? { slot: 'NPC', charName: String(args.targetPlayer || '临时'), stats: {}, skills: {}, statusTags: [], items: [] }
        : null;
      const inv = ghost || got.inv;
      const sv = R.skillValue(inv.skills, args.skillName);
      const difficulty = ['regular', 'hard', 'extreme'].includes(args.difficulty) ? args.difficulty : 'regular';
      const threshold = R.thresholdOf(sv.value, difficulty);
      const roll = R.rollWithBonus(Number(args.bonusPenalty) || 0);
      const houseRule = Number(getSession(db, groupKey)?.houseRule ?? R.DEFAULT_HOUSE_RULE);
      const level = R.successLevel(roll.roll, threshold, houseRule);
      const success = R.isSuccess(level);
      const luck = Number(inv.stats?.luck) || 0;
      const luckCost = success ? 0 : Math.max(1, roll.roll - threshold);
      const canSpendLuck = !success && level !== 'fumble' && luck >= luckCost;
      const canPush = !success && level !== 'fumble';

      if (!args.hidden) {
        const diffTag = difficulty === 'regular' ? '' : `（${R.DIFFICULTY_CN[difficulty]}）`;
        outbound.broadcast(
          `🎲 ${inv.charName} 的【${sv.name}】检定${diffTag}：1d100=${roll.roll}/${threshold} 【${R.LEVEL_CN[level]}】` +
            (roll.mode && roll.mode !== 'normal' ? `\n（${roll.detail}）` : '') +
            (args.reason ? `\n· ${args.reason}` : ''),
          { groupId: getTurn()?.groupOpenid },
        );
      }

      const payload = {
        ok: true, character: cardText(inv), skill: sv.name, skillValue: sv.value, difficulty,
        threshold, roll: roll.roll, outcome: level, outcomeCn: R.LEVEL_CN[level], success, hidden: Boolean(args.hidden),
        canSpendLuck, luckCostToSucceed: canSpendLuck ? luckCost : 0, currentLuck: luck, canPushRoll: canPush,
      };

      if ((canSpendLuck || canPush) && !ghost) {
        const checkId = `chk_${Date.now().toString(36)}`;
        withTurn(`${inv.slot} 检定 ${sv.name} ${roll.roll}/${threshold} ${R.LEVEL_CN[level]}（挂起）`, (s) => {
          updateSession(db, groupKey, {
            pendingChecks: { ...(s.pendingChecks || {}), [inv.slot]: { checkId, skill: sv.name, roll: roll.roll, threshold, difficulty, luckCost, at: Date.now() } },
          });
        });
        payload.checkId = checkId;
        payload.kpInstruction =
          `本次检定${R.LEVEL_CN[level]}。` +
          (canSpendLuck ? `玩家花 ${luckCost} 点幸运可改判成功（现有 ${luck}）。` : `幸运不足（需 ${luckCost}，只有 ${luck}）。`) +
          (canPush ? '也可孤注一掷重投（再失败强制大失败）。' : '') +
          '先把后果悬置，末尾提示可发 /luck 或说明理由孤注一掷。';
      } else if (!ghost) {
        withTurn(`${inv.slot} 检定 ${sv.name} ${roll.roll}/${threshold} ${R.LEVEL_CN[level]}`, () => null);
      } else {
        payload.noSheet = true;
        payload.kpInstruction = `这次是按技能基础值做的临时检定（该玩家还没有角色卡）。叙述后提醒他发 /st 录卡。`;
      }
      return payload;
    },
  });

  /* ② 花幸运 / 孤注一掷 */
  tools.push({
    name: 'trpg_resolve_followup',
    description: '玩家要求花幸运改判或孤注一掷时调用。spend_luck 按失败差额扣幸运；push_roll 重投，再失败强制大失败且不能再花幸运。结果当场发进群里。',
    parameters: {
      targetPlayer: { type: 'string', required: true },
      mode: { type: 'string', required: true, enum: ['spend_luck', 'push_roll'] },
      justification: { type: 'string', description: '玩家的理由（仅叙事用）' },
    },
    async execute(args = {}) {
      const got = card(args.targetPlayer);
      if (got.error) return got.error;
      const inv = got.inv;
      const s = getSession(db, groupKey);
      const pending = (s?.pendingChecks || {})[inv.slot];
      if (!pending) return { ok: false, error: 'ERR_NO_PENDING', message: '没有待挽回的检定（可能已经用过了）。' };
      const mode = args.mode === 'push_roll' ? 'push_roll' : 'spend_luck';

      let out;
      if (mode === 'spend_luck') {
        const luck = Number(inv.stats?.luck) || 0;
        const cost = Math.max(1, Number(pending.luckCost) || 0);
        if (luck < cost) return { ok: false, error: 'ERR_NOT_ENOUGH_LUCK', message: `幸运不足：需要 ${cost}，只有 ${luck}。` };
        const stats = { ...inv.stats, luck: luck - cost };
        const nextPending = { ...(s.pendingChecks || {}) };
        delete nextPending[inv.slot];
        withTurn(`${inv.slot} 花 ${cost} 幸运改判 ${pending.skill}`, () => {
          updateInvestigator(db, groupKey, inv.slot, { stats });
          updateSession(db, groupKey, { pendingChecks: nextPending });
        });
        outbound.broadcast(`✨ 【幸运改判】${inv.charName}：花费 ${cost} 点幸运（剩 ${stats.luck}），${pending.skill} 改判为【常规成功】`, { groupId: getTurn()?.groupOpenid });
        out = { ok: true, mode, character: cardText(inv), skill: pending.skill, roll: pending.roll, threshold: pending.threshold, luckCost: cost, luckLeft: stats.luck, outcomeCn: '常规成功（幸运改判）' };
      } else {
        const roll = R.rollWithBonus(0);
        const level = R.successLevel(roll.roll, pending.threshold);
        const fumbled = !R.isSuccess(level);
        const nextPending = { ...(s.pendingChecks || {}) };
        delete nextPending[inv.slot];
        withTurn(`${inv.slot} 孤注一掷 ${pending.skill} → ${fumbled ? '大失败' : R.LEVEL_CN[level]}`, () => {
          updateSession(db, groupKey, { pendingChecks: nextPending });
        });
        outbound.broadcast(`🎲 【孤注一掷】${inv.charName}：重投 ${pending.skill}，D100 = ${roll.roll} / ${pending.threshold} → ${fumbled ? '大失败！' : R.LEVEL_CN[level]}`, { groupId: getTurn()?.groupOpenid });
        out = {
          ok: true, mode, character: cardText(inv), skill: pending.skill, roll: roll.roll, threshold: pending.threshold,
          outcome: fumbled ? 'fumble' : level, outcomeCn: fumbled ? '大失败（孤注一掷失败）' : R.LEVEL_CN[level], canSpendLuck: false,
          consequenceHint: fumbled ? '孤注一掷失败：立刻让后果升级（受伤、暴露、线索被毁），不允许再花幸运。' : '成功，但让代价更具体（时间、声响、体力）。',
        };
      }
      return out;
    },
  });

  /* ③ SAN 检定 */
  tools.push({
    name: 'trpg_san_check',
    description: '理智检定：按「成功损失/失败损失」表达式（如 0/1d6）掷 D100 对抗当前 SAN 并原子扣减。单次掉 5+ 自动追加 INT 检定抽临时疯狂。结果当场发群。',
    parameters: {
      targetPlayer: { type: 'string', required: true },
      successLoss: { type: 'string', required: true, description: '成功时损失，如 0 或 1' },
      failLoss: { type: 'string', required: true, description: '失败时损失，如 1d6' },
      source: { type: 'string', description: '触发源' },
    },
    async execute(args = {}) {
      const got = card(args.targetPlayer);
      if (got.error) return got.error;
      const inv = got.inv;
      const san = Number(inv.stats?.san) || 0;
      const maxSan = Number(inv.stats?.maxSan) || san;
      const roll = R.rollD100();
      const passed = roll <= san;
      const loss = R.parseDice(passed ? args.successLoss || '0' : args.failLoss || '1d6').total;
      const nextSan = Math.max(0, Math.min(maxSan, san - loss));
      const stats = { ...inv.stats, san: nextSan };
      let madness = '';
      if (loss >= 5) {
        const intRoll = R.rollD100();
        if (intRoll <= (Number(inv.stats?.int) || 50)) madness = R.pickMadness();
      }
      const tags = new Set(inv.statusTags || []);
      if (madness) tags.add(`临时疯狂:${madness}`);
      if (nextSan === 0) tags.add('永久性疯狂');
      withTurn(`${inv.slot} SAN ${san}→${nextSan}（-${loss}）${madness ? `，${madness}` : ''}`, () => {
        updateInvestigator(db, groupKey, inv.slot, { stats, statusTags: [...tags] });
      });
      outbound.broadcast(
        `💀 【理智检定】${inv.charName}：D100 = ${roll} / ${san} → ${passed ? '成功' : '失败'}\n` +
          `SAN -${Math.min(loss, san)}（${nextSan}/${maxSan}）${madness ? `\n⚠️ 临时疯狂：${madness}` : ''}`,
        { groupId: getTurn()?.groupOpenid },
      );
      return {
        ok: true, character: cardText(inv), roll, passed, loss: Math.min(loss, san), sanBefore: san, sanAfter: nextSan,
        madness: madness || null, statusTags: [...tags],
        kpInstruction: madness ? `立刻在叙事里体现「${madness}」，并提示这是临时状态。` : '按损失幅度描写精神冲击，不要报数字。',
      };
    },
  });

  /* ④ 状态变更 */
  tools.push({
    name: 'trpg_mutate_state',
    description: '改 HP/MP/SAN/幸运、增删道具、解锁线索、增删状态。非导演单次加血 ≤10、扣血 ≤30；跨角色需要战斗轮或 assist=true。',
    parameters: {
      targetPlayer: { type: 'string', required: true },
      hpDelta: { type: 'number' }, mpDelta: { type: 'number' }, sanDelta: { type: 'number' }, luckDelta: { type: 'number' },
      addItems: { type: 'array', items: { type: 'string' } },
      removeItems: { type: 'array', items: { type: 'string' } },
      unlockClues: { type: 'array', items: { type: 'string' } },
      addStatus: { type: 'array', items: { type: 'string' } },
      removeStatus: { type: 'array', items: { type: 'string' } },
      assist: { type: 'boolean' },
      note: { type: 'string' },
    },
    async execute(args = {}) {
      const got = card(args.targetPlayer);
      if (got.error) return got.error;
      const inv = got.inv;
      const s = getSession(db, groupKey);
      const active = getTurn();
      const combatActive = Boolean(s?.combat?.active);
      const cross = inv.slot !== active?.primarySlot && !active?.slots?.has(inv.slot);
      if (!director() && !combatActive && !args.assist && cross) {
        return { ok: false, error: 'ERR_CROSS_TARGET', message: `本回合只有 ${[...(active?.slots || [])].join('/') || '（无）'} 在行动，改 ${inv.slot} 需 assist=true。` };
      }
      const hp = Number(args.hpDelta) || 0;
      const mp = Number(args.mpDelta) || 0;
      const san = Number(args.sanDelta) || 0;
      const luck = Number(args.luckDelta) || 0;
      if (!director()) {
        if (hp > HARD.maxHpGain || hp < -HARD.maxHpLoss) return { ok: false, error: 'ERR_OUT_OF_BOUNDS', message: `单次 HP 变动必须在 -${HARD.maxHpLoss} ~ +${HARD.maxHpGain}，收到 ${hp}。` };
        if (Math.abs(san) > HARD.maxSanDelta) return { ok: false, error: 'ERR_OUT_OF_BOUNDS', message: `单次 SAN 变动不得超过 ±${HARD.maxSanDelta}。` };
        if (Math.abs(luck) > HARD.maxLuckDelta) return { ok: false, error: 'ERR_OUT_OF_BOUNDS', message: `单次幸运变动不得超过 ±${HARD.maxLuckDelta}。` };
      }
      const stats = { ...inv.stats };
      if (hp) stats.hp = R.clamp((stats.hp || 0) + hp, 0, stats.maxHp ?? 10);
      if (mp) stats.mp = R.clamp((stats.mp || 0) + mp, 0, stats.maxMp ?? 10);
      if (san) stats.san = R.clamp((stats.san || 0) + san, 0, stats.maxSan ?? 99);
      if (luck) stats.luck = R.clamp((stats.luck || 0) + luck, 0, 99);
      const items = new Set(inv.items || []);
      for (const x of args.addItems || []) if (x) items.add(String(x));
      for (const x of args.removeItems || []) items.delete(String(x));
      const tags = new Set(inv.statusTags || []);
      for (const x of args.addStatus || []) if (x) tags.add(String(x));
      for (const x of args.removeStatus || []) tags.delete(String(x));
      if (stats.hp === 0) tags.add('濒死');

      const unlocked = new Set(s?.unlockedClues || []);
      const scene = sceneOf(s);
      const valid = new Set((scene?.clues || []).map((c) => c.id));
      const bad = (args.unlockClues || []).map(String).filter((id) => !valid.has(id));
      if (bad.length) return { ok: false, error: 'ERR_UNKNOWN_CLUE', message: `当前场景没有这些线索：${bad.join('、')}`, validClues: [...valid] };
      for (const id of args.unlockClues || []) unlocked.add(String(id));

      withTurn(`${inv.slot} HP${hp >= 0 ? '+' : ''}${hp} MP${mp} SAN${san} 幸运${luck}${(args.unlockClues || []).length ? ` 解锁 ${args.unlockClues.join('/')}` : ''}`, () => {
        updateInvestigator(db, groupKey, inv.slot, { stats, items: [...items], statusTags: [...tags] });
        if (unlocked.size !== (s?.unlockedClues || []).length) updateSession(db, groupKey, { unlockedClues: [...unlocked] });
      });

      if (hp || san) {
        outbound.broadcast(
          `📋 【状态变更】${inv.charName}：` +
            [hp ? `HP ${hp > 0 ? '+' : ''}${hp}` : '', san ? `SAN ${san > 0 ? '+' : ''}${san}` : ''].filter(Boolean).join(' · ') +
            ` → HP ${stats.hp}/${stats.maxHp} SAN ${stats.san}/${stats.maxSan}（${R.injuryLabel(stats.hp, stats.maxHp)}）`,
          { groupId: getTurn()?.groupOpenid },
        );
      }
      return { ok: true, character: cardText(inv), stats, items: [...items], statusTags: [...tags], unlockedClues: [...unlocked], injury: R.injuryLabel(stats.hp, stats.maxHp), note: args.note || '' };
    },
  });

  /* ⑤ 场景 */
  tools.push({
    name: 'trpg_scene_action',
    description: '看当前场景/出口，或把队伍移动到相邻房间。move 会校验连通性（导演可强制）。返回新房间的完整信息。',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'move'] },
      targetSceneId: { type: 'string', description: 'move 的目标场景 id' },
    },
    async execute(args = {}) {
      const s = getSession(db, groupKey);
      if (!s) return { ok: false, error: 'ERR_NO_SESSION', message: '本群没有跑团会话。' };
      const scene = sceneOf(s);
      if (args.action !== 'move') {
        return { ok: true, sceneId: s.currentScene, title: scene?.title, desc: scene?.desc, clues: scene?.clues || [], unlockedClues: s.unlockedClues, exits: scene?.exits || [] };
      }
      const targetId = String(args.targetSceneId || '').trim();
      if (!targetId) return { ok: false, error: 'ERR_NO_TARGET', message: 'move 需要 targetSceneId。' };
      const allowed = (scene?.exits || []).some((e) => e.sceneId === targetId);
      if (!allowed && !director()) return { ok: false, error: 'ERR_NOT_CONNECTED', message: `「${scene?.title || s.currentScene}」没有通往 ${targetId} 的出口`, exits: scene?.exits || [] };
      const target = getScene(db, s.moduleId, targetId);
      if (!target) return { ok: false, error: 'ERR_NO_SCENE', message: `模组里没有场景 ${targetId}。` };
      withTurn(`移动到 ${targetId}${allowed ? '' : '（导演强制）'}`, () => updateSession(db, groupKey, { currentScene: targetId }));
      outbound.broadcast(`🚪 【场景切换】${target.title}\n${target.desc}`, { groupId: getTurn()?.groupOpenid });
      return { ok: true, sceneId: target.sceneId, title: target.title, desc: target.desc, clues: target.clues, npcs: target.npcs, exits: target.exits };
    },
  });

  /* ⑥ 战斗 */
  tools.push({
    name: 'trpg_combat_tracker',
    description: '战斗轮：start 按 DEX 排先攻；pc_attack 处理玩家攻击；npc_attack 处理怪物攻击（危急时悬置）；pc_react 结算抉择；end 结束。返回值里怪物只有伤势词，没有血量。',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'pc_attack', 'npc_attack', 'pc_react', 'status', 'end'] },
      enemies: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, dex: { type: 'number' }, hp: { type: 'number' }, attackSkill: { type: 'number' }, dodgeSkill: { type: 'number' }, damage: { type: 'string' }, armor: { type: 'number' } } } },
      attacker: { type: 'string' }, target: { type: 'string' },
      maneuver: { type: 'string', enum: ['fight', 'firearm'] },
      weapon: { type: 'string' },
      choice: { type: 'string', enum: ['dodge', 'fight_back'] },
    },
    async execute(args = {}) {
      const s = getSession(db, groupKey);
      if (!s) return { ok: false, error: 'ERR_NO_SESSION', message: '本群没有跑团会话。' };
      const combat = { active: false, round: 1, order: [], pendingReaction: null, ...(s.combat || {}) };
      const save = (summary, write) => withTurn(summary, () => { if (write) write(); updateSession(db, groupKey, { combat }); });
      const action = String(args.action || 'status');

      if (action === 'start') {
        const enemies = Array.isArray(args.enemies) ? args.enemies : [];
        if (!enemies.length) return { ok: false, error: 'ERR_NO_ENEMIES', message: 'start 需要 enemies。' };
        combat.order = [
          ...party().map((i) => ({ id: i.slot, type: 'pc', name: i.charName, dex: Number(i.stats?.dex) || 50 })),
          ...enemies.map((e, i) => ({
            id: e.id || `E${i + 1}`, type: 'npc', name: e.name || `敌人${i + 1}`,
            dex: Number(e.dex) || 50, hp: Number(e.hp) || 10, maxHp: Number(e.hp) || 10,
            attackSkill: Number(e.attackSkill) || 50, dodgeSkill: Number(e.dodgeSkill) || 30,
            damage: e.damage || '1d4', armor: Number(e.armor) || 0,
          })),
        ].sort((a, b) => b.dex - a.dex).map((u) => (u.type === 'npc' ? { ...u, injury: R.injuryLabel(u.hp, u.maxHp) } : u));
        combat.active = true; combat.round = 1; combat.pendingReaction = null;
        save('战斗开始');
        outbound.broadcast(`⚔️ 【战斗开始】先攻：${combat.order.map((u) => `${u.name}(DEX${u.dex})`).join(' → ')}`, { groupId: getTurn()?.groupOpenid });
        return { ok: true, round: 1, order: combat.order.map((u) => ({ id: u.id, name: u.name, dex: u.dex, ...(u.type === 'npc' ? { injury: u.injury } : {}) })) };
      }
      if (action === 'end') { combat.active = false; combat.pendingReaction = null; save('战斗结束'); return { ok: true, ended: true }; }
      if (action === 'status') return { ok: true, active: combat.active, round: combat.round, order: combat.order.map((u) => ({ id: u.id, name: u.name, ...(u.type === 'npc' ? { injury: u.injury } : {}) })), pendingReaction: combat.pendingReaction };
      if (!combat.active) return { ok: false, error: 'ERR_NO_COMBAT', message: '当前不在战斗中。' };

      const unit = (key) => combat.order.find((u) => u.id === key || u.name === key);

      if (action === 'pc_attack') {
        const got = card(args.attacker);
        if (got.error) return got.error;
        const inv = got.inv;
        const enemy = unit(String(args.target || ''));
        if (!enemy || enemy.type !== 'npc') return { ok: false, error: 'ERR_NO_TARGET', message: `找不到敌人「${args.target}」。` };
        const sv = R.skillValue(inv.skills, args.maneuver === 'firearm' ? '手枪' : '斗殴');
        const ar = R.rollWithBonus(0);
        const al = R.successLevel(ar.roll, sv.value);
        const dr = R.rollWithBonus(0);
        const dl = R.successLevel(dr.roll, enemy.dodgeSkill ?? 30);
        const win = R.LEVEL_RANK[al] > R.LEVEL_RANK[dl];
        let damage = 0;
        if (win) {
          const dbon = R.damageBonus(inv.stats?.str, inv.stats?.siz);
          const expr = args.weapon || (args.maneuver === 'firearm' ? '1d10' : dbon === '0' ? '1d3' : `1d3+${dbon}`);
          let raw = 0;
          try { raw = R.parseDice(expr).total; } catch { raw = R.parseDice('1d3').total; }
          damage = Math.max(0, raw - (enemy.armor || 0));
          enemy.hp = Math.max(0, (enemy.hp || 0) - damage);
          enemy.injury = R.injuryLabel(enemy.hp, enemy.maxHp);
        }
        save(`${inv.slot} 攻击 ${enemy.name}：${damage ? `-${damage}` : '未命中'}`);
        outbound.broadcast(
          `⚔️ 【近战】${inv.charName} → ${enemy.name}\n攻击 D100=${ar.roll}/${sv.value} ${R.LEVEL_CN[al]}｜闪避 D100=${dr.roll}/${enemy.dodgeSkill} ${R.LEVEL_CN[dl]}` +
            `\n${win ? `命中，伤害 ${damage}（${enemy.injury}）` : '被闪开了'}`,
          { groupId: getTurn()?.groupOpenid },
        );
        return { ok: true, attacker: cardText(inv), attack: { roll: ar.roll, skill: sv.value, outcome: R.LEVEL_CN[al] }, defense: { roll: dr.roll, outcome: R.LEVEL_CN[dl] }, hit: win, damage, target: { id: enemy.id, name: enemy.name, injury: enemy.injury, dead: enemy.hp <= 0 } };
      }

      if (action === 'npc_attack') {
        const enemy = unit(String(args.attacker || ''));
        if (!enemy || enemy.type !== 'npc') return { ok: false, error: 'ERR_NO_TARGET', message: `找不到敌人「${args.attacker}」。` };
        const got = card(args.target);
        if (got.error) return got.error;
        const inv = got.inv;
        const ar = R.rollWithBonus(0);
        const al = R.successLevel(ar.roll, enemy.attackSkill ?? 50);
        const critical = R.LEVEL_RANK[al] >= R.LEVEL_RANK.hard;
        const hp = Number(inv.stats?.hp) || 0;
        if (critical || hp <= 5) {
          combat.pendingReaction = { attacker: enemy.id, target: inv.slot, attackRoll: ar.roll, attackLevel: al, at: Date.now() };
          save(`${enemy.name} 攻击 ${inv.slot}（悬置）`);
          return { ok: true, pending: true, attacker: enemy.name, target: cardText(inv), attack: { roll: ar.roll, outcome: R.LEVEL_CN[al] }, kpInstruction: '这一击很危险，别直接结算。描写攻击逼近，让玩家选闪避或反击，随后调用 pc_react。' };
        }
        const choice = inv.tactic === 'fight_back' ? 'fight_back' : 'dodge';
        const rr = R.rollWithBonus(0);
        const rsv = R.skillValue(inv.skills, choice === 'fight_back' ? '斗殴' : '闪避');
        const rl = R.successLevel(rr.roll, rsv.value);
        const dodged = R.LEVEL_RANK[al] <= R.LEVEL_RANK[rl];
        let damage = 0;
        if (!dodged) {
          damage = R.parseDice(enemy.damage || '1d4').total;
          const stats = { ...inv.stats, hp: R.clamp(hp - damage, 0, inv.stats?.maxHp ?? 10) };
          const tags = new Set(inv.statusTags || []);
          if (stats.hp === 0) tags.add('濒死');
          updateInvestigator(db, groupKey, inv.slot, { stats, statusTags: [...tags] });
        }
        save(`${enemy.name} 攻击 ${inv.slot}：${dodged ? '被化解' : `-${damage}`}`);
        outbound.broadcast(
          `⚔️ 【受击】${enemy.name} → ${inv.charName}\n攻击 D100=${ar.roll}/${enemy.attackSkill} ${R.LEVEL_CN[al]}｜${choice === 'fight_back' ? '反击' : '闪避'} D100=${rr.roll}/${rsv.value} ${R.LEVEL_CN[rl]}` +
            `\n${dodged ? '化解了' : `受伤 ${damage}`}`,
          { groupId: getTurn()?.groupOpenid },
        );
        return { ok: true, hit: !dodged, damage, attack: { roll: ar.roll, outcome: R.LEVEL_CN[al] }, reaction: { kind: choice, roll: rr.roll, outcome: R.LEVEL_CN[rl] } };
      }

      if (action === 'pc_react') {
        const pending = combat.pendingReaction;
        if (!pending) return { ok: false, error: 'ERR_NO_PENDING_REACTION', message: '当前没有悬置的受击。' };
        const inv = getInvestigator(db, groupKey, pending.target);
        if (!inv) return { ok: false, error: 'ERR_NO_TARGET', message: '悬置目标不在了。' };
        const choice = args.choice === 'fight_back' ? 'fight_back' : 'dodge';
        const rr = R.rollWithBonus(0);
        const sv = R.skillValue(inv.skills, choice === 'fight_back' ? '斗殴' : '闪避');
        const rl = R.successLevel(rr.roll, sv.value);
        const dodged = R.LEVEL_RANK[pending.attackLevel] <= R.LEVEL_RANK[rl];
        let damage = 0;
        if (!dodged) {
          const enemy = unit(pending.attacker);
          damage = R.parseDice(enemy?.damage || '1d4').total;
          const stats = { ...inv.stats, hp: R.clamp((inv.stats?.hp || 0) - damage, 0, inv.stats?.maxHp ?? 10) };
          updateInvestigator(db, groupKey, inv.slot, { stats });
        }
        combat.pendingReaction = null;
        save(`${inv.slot} ${choice === 'fight_back' ? '反击' : '闪避'}：${dodged ? '化解' : `-${damage}`}`);
        outbound.broadcast(`⚔️ 【抉择】${inv.charName} 选择${choice === 'fight_back' ? '反击' : '闪避'}：D100=${rr.roll}/${sv.value} ${R.LEVEL_CN[rl]}\n${dodged ? '化解了' : `受伤 ${damage}`}`, { groupId: getTurn()?.groupOpenid });
        return { ok: true, choice, reaction: { roll: rr.roll, outcome: R.LEVEL_CN[rl] }, hit: !dodged, damage };
      }
      return { ok: false, error: 'ERR_UNKNOWN_ACTION', message: `不认识的战斗动作：${action}` };
    },
  });

  return tools;
}
