// CoC 7e 纯函数规则库：不碰 db、不碰 ctx，单测全靠它。
export const LEVEL_RANK = { fumble: -1, fail: 0, regular: 1, hard: 2, extreme: 3, critical: 4 };
export const LEVEL_CN = { critical: '大成功', extreme: '极难成功', hard: '困难成功', regular: '常规成功', fail: '失败', fumble: '大失败' };
export const DIFFICULTY_CN = { regular: '常规', hard: '困难', extreme: '极难' };

export function clamp(n, lo, hi) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;
}

export function rollD100() {
  return 1 + Math.floor(Math.random() * 100);
}

/**
 * 百分骰 + 奖励/惩罚骰。
 *
 * COC7 原规则：个位骰只骰一次，十位骰按奖惩数多骰、奖励取**较小**、惩罚取**较大**；
 * 奖励与惩罚互相抵消（b2p1 等价于净 b1）。十位与个位同时为 0 视为 100。
 * 返回的 `detail` 直接进播报，玩家能对着牌桌核账。
 */
export function rollWithBonus(bonus = 0) {
  const b = clamp(bonus, -2, 2);
  const extra = Math.abs(b);
  const units = Math.floor(Math.random() * 10);
  const tensRolls = [];
  for (let i = 0; i <= extra; i += 1) tensRolls.push(Math.floor(Math.random() * 10));

  let tens;
  let mode;
  if (b > 0) { tens = Math.min(...tensRolls); mode = 'bonus'; }
  else if (b < 0) { tens = Math.max(...tensRolls); mode = 'penalty'; }
  else { tens = tensRolls[0]; mode = 'normal'; }

  let roll = tens * 10 + units;
  if (roll === 0) roll = 100;

  const tensText = tensRolls.map((x) => (x === 0 ? '00' : String(x * 10))).join(',');
  const unitsText = String(units);
  const detail = mode === 'normal'
    ? `${roll}`
    : `${mode === 'bonus' ? '奖励' : '惩罚'}${extra}（十位[${tensText}] 个位${unitsText}）→ ${roll}`;

  return { roll, tens, units, tensRolls, bonus: b, mode, detail };
}

/**
 * 成功等级。
 *
 * 中点（极难=五分之一、困难=一半）是规则书硬规定；大成功/大失败按房规。
 * 默认房规 3（出 1~5 大成功、96~100 大失败）—— 大多数桌的约定，
 * 和 trpg-dice 的 setcoc 表一致，玩家拿两处结果对照不会打架。
 */
export const DEFAULT_HOUSE_RULE = 3;

export function successLevel(roll, skill, houseRule = DEFAULT_HOUSE_RULE) {
  const s = Math.max(0, Number(skill) || 0);
  const c = Number.isInteger(houseRule) && houseRule >= 0 && houseRule <= 5 ? houseRule : DEFAULT_HOUSE_RULE;
  const tenth = Math.floor(s / 10);

  let critical = false;
  let fumble = false;
  switch (c) {
    case 0: critical = roll === 1; fumble = s < 50 ? roll >= 96 : roll === 100; break;
    case 1: critical = s < 50 ? roll === 1 : roll <= 5; fumble = s < 50 ? roll >= 96 : roll === 100; break;
    case 2: critical = roll <= 5 && roll <= s; fumble = roll === 100 || (roll >= 96 && roll <= 99 && roll > s); break;
    case 4: critical = roll <= 5 && roll <= tenth; fumble = s < 50 ? roll >= 96 + tenth : roll === 100; break;
    case 5: critical = roll <= 2 && roll < Math.floor(s / 5); fumble = s < 50 ? roll >= 96 : roll >= 99; break;
    default: critical = roll >= 1 && roll <= 5; fumble = roll >= 96; break;
  }

  if (critical) return 'critical';
  if (roll <= Math.floor(s / 5)) return 'extreme';
  if (roll <= Math.floor(s / 2)) return 'hard';
  if (roll <= s) return 'regular';
  if (fumble) return 'fumble';
  return 'fail';
}

export function isSuccess(level) {
  return LEVEL_RANK[level] >= LEVEL_RANK.regular;
}

export function thresholdOf(skill, difficulty = 'regular') {
  const div = difficulty === 'hard' ? 2 : difficulty === 'extreme' ? 5 : 1;
  return Math.max(1, Math.floor((Number(skill) || 0) / div));
}

/**
 * 解析「掷骰表达式」并返回一次结果。
 * 完整表达式实现在 ./dice.js（XdY、kq 取最值、dh/dl 弃最值、四则运算、括号）。
 */
export async function parseDiceAsync(expr, opts = {}) {
  const { rollExpression } = await import('./dice.js?t=' + (globalThis.__TRPG_STAMP__ || '0'));
  return rollExpression(expr, opts);
}

/** 同步版：只取合计，给不想 await 的调用点用 */
export function parseDice(expr) {
  const src = String(expr ?? "").replace(/\s+/g, "");
  const m = /^(\d*)d(\d+)([+-]\d+)?$/.exec(src);
  if (!m) {
    const n = Number(src);
    if (Number.isFinite(n)) return { total: n, rolls: [] };
    throw new Error(`看不懂的骰子表达式：${expr}`);
  }
  const count = Math.max(1, Math.min(100, Number(m[1] || 1)));
  const sides = Math.max(2, Number(m[2]));
  let total = 0;
  const rolls = [];
  for (let i = 0; i < count; i += 1) {
    const v = 1 + Math.floor(Math.random() * sides);
    rolls.push(v);
    total += v;
  }
  if (m[3]) total += Number(m[3]);
  return { total, rolls };
}
export function parseSanExpr(expr) {
  const raw = String(expr ?? '').trim();
  const m = /^([^/]+)\/(.+)$/.exec(raw);
  if (!m) throw new Error(`SAN 表达式要写成「成功/失败」，例如 0/1d6`);
  return { onSuccess: m[1].trim() || '0', onFail: m[2].trim() || '0' };
}

export function damageBonus(str, siz) {
  const t = (Number(str) || 0) + (Number(siz) || 0);
  if (t <= 64) return '-2';
  if (t <= 84) return '-1';
  if (t <= 124) return '0';
  if (t <= 164) return '1d4';
  if (t <= 204) return '1d6';
  return '2d6';
}

export function injuryLabel(hp, maxHp) {
  const max = Math.max(1, Number(maxHp) || 1);
  const cur = Math.max(0, Number(hp) || 0);
  if (cur <= 0) return '倒地毙命';
  const r = cur / max;
  if (r >= 0.999) return '完好无损';
  if (r >= 0.75) return '轻伤挂彩';
  if (r >= 0.4) return '重伤踉跄';
  return '濒死挣扎';
}

export const MADNESS = ['幽闭恐惧', '被害妄想', '幻听', '失语', '强迫计数', '恐惧黑暗', '短暂失忆', '手部震颤'];
export function pickMadness() {
  return MADNESS[Math.floor(Math.random() * MADNESS.length)];
}

export const BASE_SKILLS = {
  会计: 5, 人类学: 1, 估价: 5, 考古学: 1, 取悦: 15, 攀爬: 20, 信用评级: 0, 克苏鲁神话: 0,
  乔装: 5, 闪避: 0, 汽车驾驶: 20, 电气维修: 10, 话术: 5, 格斗: 25, 射击: 20, 急救: 30,
  历史: 5, 恐吓: 15, 跳跃: 20, 外语: 1, 母语: 0, 法律: 5, 图书馆: 20, 聆听: 20,
  锁匠: 1, 机械维修: 10, 医学: 1, 博物学: 10, 导航: 10, 神秘学: 5, 重型操作: 1,
  说服: 10, 精神分析: 1, 心理学: 10, 骑术: 5, 科学: 1, 妙手: 10, 侦查: 25, 潜行: 20,
  生存: 10, 游泳: 20, 投掷: 20, 追踪: 10, 斗殴: 25, 手枪: 20, 步枪: 25, 霰弹枪: 25,
};

const SKILL_ALIASES = { 图书馆使用: '图书馆', 开锁: '锁匠', 撬锁: '锁匠', 肉搏: '斗殴', 格斗斗殴: '斗殴', 枪械: '射击' };

export function skillValue(skills, name) {
  const raw = String(name ?? '').trim();
  const key = SKILL_ALIASES[raw] ?? raw;
  const bag = skills && typeof skills === 'object' ? skills : {};
  if (Object.prototype.hasOwnProperty.call(bag, key)) return { value: Number(bag[key]) || 0, name: key, source: 'sheet' };
  if (Object.prototype.hasOwnProperty.call(BASE_SKILLS, key)) return { value: BASE_SKILLS[key], name: key, source: 'base' };
  return { value: 5, name: key, source: 'unknown' };
}

/* ── COC7 派生值（与 trpg-dice 的 coc.js 同表，两处对外输出不能打架）──── */

export function hitPoints(con, siz) { return Math.floor(((Number(con) || 0) + (Number(siz) || 0)) / 10); }
export function magicPoints(pow) { return Math.floor((Number(pow) || 0) / 5); }

export function moveRate(str, dex, siz, age = null) {
  const s = Number(str) || 0; const d = Number(dex) || 0; const z = Number(siz) || 0;
  let mov;
  if (s > z && d > z) mov = 9;
  else if (s >= z || d >= z) mov = 8;
  else mov = 7;
  if (Number.isFinite(age) && age >= 40) mov -= Math.min(5, 1 + Math.floor((age - 40) / 10));
  return Math.max(1, mov);
}

/** 体格与伤害加值同表：2-64 → -2/-2；65-84 → -1/-1；85-124 → 0/0；125-164 → +1/+1D4；165-204 → +2/+1D6 */
export function buildAndDamageBonus(str, siz) {
  const t = (Number(str) || 0) + (Number(siz) || 0);
  if (t <= 64) return { build: -2, db: '-2' };
  if (t <= 84) return { build: -1, db: '-1' };
  if (t <= 124) return { build: 0, db: '0' };
  if (t <= 164) return { build: 1, db: '+1D4' };
  if (t <= 204) return { build: 2, db: '+1D6' };
  const build = 3 + Math.floor((t - 205) / 80);
  return { build, db: `+${build}D6` };
}

/** 一张卡的派生值摘要，给 /pc 与 HUD 共用 */
export function derivedOf(stats = {}) {
  const s = stats || {};
  const { build, db } = buildAndDamageBonus(s.str, s.siz);
  return {
    hp: hitPoints(s.con, s.siz) || Number(s.maxHp) || 0,
    mp: magicPoints(s.pow) || Number(s.maxMp) || 0,
    mov: moveRate(s.str, s.dex, s.siz),
    build,
    db,
  };
}
