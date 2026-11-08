// 出站客户端：msgId 池轮转 + 300ms 播报排序 + 幂等 + 单回合预算。
//
// 真正发消息的是 Roost 的 trpg-forwarder（它复用 roost 的 msg_seq / 过期降级）。
// 这里只负责：什么时候发、用哪个 msg_id、发失败了怎么办。
import { randomUUID } from 'node:crypto';

export function createOutbound({ cfg, log = () => {} }) {
  const sent = new Map();
  /** 当前回合：{ pool:[msgId], idx, budget, seq } */
  let turn = null;
  let queue = [];
  let timer = null;

  function beginTurn(msgIdPool = []) {
    // 保留上一段的已用计数：命令回复 + 同一轮的 AI 播报共用同一批 msg_id，
    // 各自从 0 数会让「一轮 5 次」被偷偷翻倍。
    const used = turn?.used ?? new Map();
    turn = { pool: [...new Set(msgIdPool.filter(Boolean))], used, idx: 0, budget: cfg.turnBudget, seq: 0 };
    queue = [];
  }
  function endTurn() {
    turn = null;
  }

  /**
   * 拿一条还能用的 msg_id。
   *
   * QQ 限制「同一条 msg_id 最多被动回复 5 次」。以前池用完就一直返回最后一条，
   * 于是第 6 条开始必然 seq_exhausted，消息发不出去（2026-11-07 23:00 连挂 9 条）。
   * 现在：每条最多用 4 次，用满换下一条；池空返回空串 → 按主动消息发。
   */
  const PASSIVE_MAX = 4;
  const nextMsgId = () => {
    if (!turn?.pool.length) return '';
    for (let i = turn.idx; i < turn.pool.length; i += 1) {
      const id = turn.pool[i];
      if ((turn.used.get(id) || 0) < PASSIVE_MAX) {
        turn.idx = i;
        return id;
      }
    }
    return '';
  };
  const markUsed = (msgId) => {
    if (!msgId || !turn) return;
    turn.used.set(msgId, (turn.used.get(msgId) || 0) + 1);
  };

  async function post(body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(cfg.roostSendUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          /**
           * Roost 面板设了 webui.accessKey 之后，所有 /api/* 都要认证，
           * /send 也在里面。不带这个头会收到 401「访问密钥无效」，
           * 而那和 bad_token 是两回事，很容易误判成令牌写错了。
           */
          ...(cfg.roostAccessKey ? { 'x-access-key': cfg.roostAccessKey } : {}),
        },
        body: JSON.stringify({ ...body, token: cfg.token }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: Boolean(res.ok && data?.ok), code: data?.error || '', message: data?.message || '' };
    } catch (error) {
      return { ok: false, code: 'network', message: String(error?.message || error) };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * 发一条。失败重试一次；msg_id 用满（seq_exhausted）就换池里的下一个。
   */
  /**
   * 发一条纯文本。
   *
   * **不要默认走 markdown**：markdown 会把 msg_type 置为 2，群里实测被腾讯
   * 回 500「系统繁忙，请稍后重试」（2026-11-07 20:45 连挂三条）。
   * @ 人同理：qqbot-at-user 标签只在 markdown 消息里渲染，纯文本会露出标签，
   * 所以先不 @，等 markdown 权限确认后再打开。
   */
  async function send({ groupId, replyMsgId, content, requestId = '' }) {
    const markdown = false;
    const atOpenid = '';
    if (!turn) turn = { pool: replyMsgId ? [replyMsgId] : [], idx: 0, budget: cfg.turnBudget, seq: 0 };
    if (turn.budget <= 0) {
      log(`出站预算用完，丢弃一条：${String(content).slice(0, 20)}`);
      return { ok: false, code: 'budget' };
    }
    turn.budget -= 1;
    const rid = requestId || `out_${randomUUID()}`;
    if (sent.has(rid)) return { ok: true, dup: true };

    let msgId = replyMsgId || nextMsgId();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const r = await post({ requestId: rid, groupId, replyMsgId: msgId, content, markdown, atOpenid, type: 'text' });
      if (r.ok) {
        markUsed(msgId);
        sent.set(rid, Date.now());
        if (sent.size > 500) sent.delete(sent.keys().next().value);
        return { ok: true };
      }
      if (r.code === 'seq_exhausted') {
        // 这条用满了：标满、换下一条；池空则 msgId 置空走主动消息
        if (msgId) turn.used.set(msgId, PASSIVE_MAX);
        const next = nextMsgId();
        if (!next && !msgId) break;
        msgId = next;
        continue;
      }
      if (attempt === 0) await new Promise((r2) => setTimeout(r2, 600));
    }
    log(`出站失败：${content.slice(0, 20)}`);
    return { ok: false, code: 'send_failed' };
  }

  /**
   * 播报卡：进 300ms 排序器，按调用顺序发（模型并行调工具时不会乱序）。
   */
  function broadcast(content, { groupId, atOpenid = '', markdown = false } = {}) {
    if (!turn) return;
    turn.seq += 1;
    queue.push({ seq: turn.seq, content, groupId, atOpenid, markdown });
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const batch = queue.sort((a, b) => a.seq - b.seq);
      queue = [];
      (async () => {
        for (const item of batch) {
          await send({ groupId: item.groupId || '', content: item.content, markdown: item.markdown, atOpenid: item.atOpenid });
        }
      })().catch(() => {});
    }, 300);
    timer.unref?.();
  }

  return { beginTurn, endTurn, send, broadcast, get budgetLeft() { return turn?.budget ?? 0; } };
}
