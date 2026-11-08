// 驱动 DSH 会话：投一句话，等 turn/end，拿到这一轮的正文。
export function createTurnRunner({ ctx, cfg, log = () => {} }) {
  const waiters = new Map();

  const textOf = (message) => {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  };

  const off = ctx.on('session/event', (session, event) => {
    const sid = session?.id;
    if (!sid || !waiters.has(sid) || !event) return;
    const w = waiters.get(sid);
    if (event.type === 'assistant/message') {
      const d = event.data || {};
      if (d.interrupted) return;
      const t = textOf(d.message);
      if (!t) return;
      w.turn = d.turn;
      w.text = t;
      return;
    }
    if (event.type === 'turn/end') {
      const d = event.data || {};
      const text = w.turn === d.turn ? w.text : '';
      if (!w.settled) {
        w.settled = true;
        clearTimeout(w.timer);
        waiters.delete(sid);
        if (d.reason?.kind === 'completed' && text) w.resolve(text);
        else w.reject(Object.assign(new Error(`这一轮没正常结束（${d.reason?.kind || 'unknown'}）`), { kind: d.reason?.kind }));
      }
    }
  });

  async function run(agent, text) {
    const sid = agent?.session?.id ?? agent?.sessionId;
    if (!sid) throw new Error('拿不到 DSH 会话 id');
    if (waiters.has(sid)) throw Object.assign(new Error('这个会话上一轮还没结束'), { kind: 'busy' });

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const w = waiters.get(sid);
        if (!w || w.settled) return;
        w.settled = true;
        clearTimeout(timer);
        waiters.delete(sid);
        reject(Object.assign(new Error('DSH 这一轮超时'), { kind: 'timeout' }));
      }, cfg.turnTimeoutMs);
      timer.unref?.();
      waiters.set(sid, { turn: -1, text: '', resolve, reject, timer, settled: false });
    });

    try {
      await agent.followup({
        id: `trpg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'trpg' },
      });
      await ctx.sessions?.flush?.(agent.session);
    } catch (error) {
      const w = waiters.get(sid);
      if (w && !w.settled) {
        w.settled = true;
        clearTimeout(w.timer);
        waiters.delete(sid);
        w.reject(error);
      }
      throw error;
    }
    return promise;
  }

  return {
    run,
    dispose() {
      off?.();
      for (const [, w] of waiters) {
        clearTimeout(w.timer);
        if (!w.settled) {
          w.settled = true;
          w.reject(Object.assign(new Error('插件已卸载'), { name: 'AbortError' }));
        }
      }
      waiters.clear();
    },
  };
}
