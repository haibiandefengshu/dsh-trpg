// [TRPG_HUD] + [TRPG_CAMPAIGN]：每轮注入的状态头。
// 版本戳：由 host.js 每次 apply 时刷新，用来让子模块绕开 ESM 缓存
const STAMP = globalThis.__TRPG_STAMP__ || '0';
const { BASE_SKILLS } = await import('./rules-coc7.js?t=' + STAMP);

const SKILL_LIMIT = 10;

export function skillsLine(inv) {
  const entries = Object.entries(inv.skills || {})
    .map(([name, v]) => ({ name, value: Number(v) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, SKILL_LIMIT);
  if (!entries.length) return '（未录技能，按 CoC 初始值判定）';
  return entries.map((x) => `${x.name}${x.value}`).join(' ');
}

function itemsLine(inv) {
  const items = (inv.items || []).filter(Boolean);
  return items.length ? items.slice(0, 12).join('、') : '（空手）';
}

function combatBlock(combat) {
  if (!combat?.active) return [];
  const order = (combat.order || [])
    .map((u) => (u.type === 'pc' ? `[${u.id}] ${u.name} DEX${u.dex}` : `[${u.id}] ${u.name} DEX${u.dex}（${u.injury || '完好无损'}）`))
    .join(' → ');
  return [`【战斗轮】第 ${combat.round || 1} 轮，先攻：${order}`];
}

export function renderHud({ groupKey, session, party, scene, actions = [], campaign = [], official = {} }) {
  const mode = session?.combat?.active ? 'COMBAT' : 'EXPLORE';
  const lines = [
    `[TRPG_HUD | groupId="${groupKey}" | turnId=${session?.turnId ?? 0} | mode="${mode}"]`,
  ];
  if (campaign.length) {
    lines.push('[TRPG_CAMPAIGN]');
    for (const f of campaign) lines.push(`- ${f.fact}`);
    lines.push('[/TRPG_CAMPAIGN]', '');
  }
  lines.push(`【当前场景】${scene?.title || '（未知）'} (sceneId: ${session?.currentScene || '?'})`);
  if (!scene) lines.push('- 环境概况：（场景未初始化，管理员发 /trpg start）');
  if (scene) {
    lines.push(`- 环境概况：${scene.desc}`);
    const done = new Set(session?.unlockedClues || []);
    const locked = (scene.clues || []).filter((c) => !done.has(c.id));
    const got = (scene.clues || []).filter((c) => done.has(c.id));
    if (locked.length) {
      lines.push('- 未解锁暗线：');
      locked.forEach((c, i) => lines.push(`  ${i + 1}. [${c.id}] ${c.cond} → ${c.secret}`));
    }
    if (got.length) lines.push(`- 已解锁：${got.map((c) => `[${c.id}]`).join(' ')}`);
    const exits = (scene.exits || []).map((e) => `${e.label} (${e.sceneId})`);
    lines.push(`- 相邻出口：${exits.join('、') || '无'}`);
  }
  lines.push('', '【在场调查员状态表】(targetPlayer 传代号 P1/P2)');
  if (!party.length) lines.push('- （还没有人录卡，可用 /st 录入）');
  for (const inv of party) {
    const st = inv.stats || {};
    lines.push(
      `- [${inv.slot}] ${inv.charName}${inv.nickname ? ` (玩家:${inv.nickname})` : ''}` +
      ` | HP:${st.hp ?? 0}/${st.maxHp ?? 0} MP:${st.mp ?? 0}/${st.maxMp ?? 0} SAN:${st.san ?? 0}/${st.maxSan ?? 0} 幸运:${st.luck ?? 0}` +
      ` | 状态:${(inv.statusTags || []).join('、') || '正常'}${inv.afk ? ' | AFK' : ''}`,
    );
    lines.push(`  核心技能：${skillsLine(inv)}`);
    lines.push(`  持有物品：${itemsLine(inv)}`);
  }
  lines.push(...combatBlock(session?.combat));
  if (actions.length) {
    lines.push('', '【本轮调查员行动】');
    for (const a of actions) {
      lines.push(`- [${a.slot || '未录卡'} ${a.charName}${a.nickname ? ` (${a.nickname})` : ''}]: ${a.text}`);
    }
  }
  lines.push('', '【行动引导硬性要求】');
  lines.push('- 叙事演出结尾必须输出【👉 你可以尝试：】引导块，列出 2~4 个可操作的行动分支（结合本场景细节、线索、出口或突发事件），并在最后保留「自由描述你的其他行动」。');
  lines.push('', '【使用须知】只用最新一份 HUD；更早的 [TRPG_HUD] 一律作废。数值以工具返回为准。', '[/TRPG_HUD]');
  return lines.join('\n');
}
