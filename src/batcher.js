// Per-Group 合批：6 秒防抖 + timestamp 排序 + msgId 池 + INFERRING 互斥锁。
export function createBatcher({ cfg, log = () => {}, onRelease }) {
  const groups = new Map();
  const stateOf = (gk) => {
    let st = groups.get(gk);
    if (!st) {
      st = { events: [], timer: null, busy: false, queued: [] };
      groups.set(gk, st);
    }
    return st;
  };

  async function release(gk) {
    const st = stateOf(gk);
    if (st.busy || !st.events.length) return false;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    // 按 timestamp 升序；同一毫秒按 msgId 字典序，保证可复现
    const events = st.events
      .slice()
      .sort((a, b) => (a.timestamp - b.timestamp) || String(a.msgId).localeCompare(String(b.msgId)));
    st.events = [];
    st.busy = true;
    const ctxTurn = {
      groupKey: gk,
      groupOpenid: events[0]?.groupId || '',
      events,
      msgIdPool: [...new Set(events.map((e) => e.msgId).filter(Boolean))].reverse(),
      isDirector: events.some((e) => /^\[导演\]/.test(e.text)),
    };
    try {
      await onRelease(ctxTurn);
    } catch (error) {
      log(`回合执行失败（${gk}）：${error?.message || error}`);
    } finally {
      st.busy = false;
      if (st.events.length) {
        // 结算期间攒下的行动，立刻进入下一轮
        release(gk).catch(() => {});
      }
    }
    return true;
  }

  function push(evt) {
    const st = stateOf(evt.groupKey);
    if (st.busy) {
      // 推演中：压入下一轮，并让玩家知道收到了
      st.events.push(evt);
      return { accepted: true, queued: true };
    }
    st.events.push(evt);
    if (st.events.length >= cfg.maxBatch) {
      release(evt.groupKey).catch(() => {});
      return { accepted: true, released: true };
    }
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      release(evt.groupKey).catch(() => {});
    }, cfg.batchWindowMs);
    st.timer.unref?.();
    return { accepted: true };
  }

  return {
    push,
    release,
    isBusy: (gk) => Boolean(groups.get(gk)?.busy),
    pending: (gk) => groups.get(gk)?.events.length ?? 0,
    dispose() {
      for (const st of groups.values()) if (st.timer) clearTimeout(st.timer);
      groups.clear();
    },
  };
}
