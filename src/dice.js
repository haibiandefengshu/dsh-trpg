// 骰子表达式引擎。
//
// 参考了 QQ Agent 的 trpg-dice 插件（dice.js）的成熟做法：
//   · 全角字符先规范化（群里输入法经常打出 ３ｄ６）
//   · 递归下降解析，支持 + - * / 和括号
//   · XdY 后接 k/q 取最值（kh/kl 同义），dh/dl 弃最值
//   · 骰子数与面数都设硬上限，`99999d99999` 不能把进程卡死
// 汇报格式也照它：给群里看的是「明细 + 合计」，不是一段 JSON。

const MAX_DICE = 100;
const MAX_SIDES = 10000;

export function normalize(input) {
  return String(input ?? '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ｄｄ]/g, 'd')
    .replace(/[＋]/g, '+')
    .replace(/[－ー—]/g, '-')
    .replace(/[＊×]/g, '*')
    .replace(/[／÷]/g, '/')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function tokenize(src) {
  const out = [];
  let i = 0;
  const num = () => {
    const j = i;
    while (i < src.length && /[0-9]/.test(src[i])) i += 1;
    return Number(src.slice(j, i));
  };
  while (i < src.length) {
    const c = src[i];
    if (/[0-9]/.test(c)) { out.push({ t: 'num', v: num() }); continue; }
    if (c === 'd') {
      const nxt = src[i + 1];
      if (nxt === 'h' || nxt === 'l') {
        i += 2;
        const k = num();
        if (!k) throw new Error(`「d${nxt}」后面要跟数字，比如 3d6dh2`);
        out.push({ t: 'op', v: nxt === 'h' ? 'dh' : 'dl' }, { t: 'num', v: k });
        continue;
      }
      out.push({ t: 'op', v: 'd' });
      i += 1;
      continue;
    }
    if ('+-*/()'.includes(c)) { out.push({ t: 'op', v: c }); i += 1; continue; }
    if (c === 'k' || c === 'q') {
      let low = c === 'q';
      i += 1;
      if (src[i] === 'h') { low = false; i += 1; }
      else if (src[i] === 'l') { low = true; i += 1; }
      const k = num();
      if (!k) throw new Error(`「${c}」后面要跟数字，比如 3d6k2`);
      out.push({ t: 'op', v: low ? 'q' : 'k' }, { t: 'num', v: k });
      continue;
    }
    throw new Error(`看不懂的符号「${src[i]}」`);
  }
  return out;
}

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (v) => (peek() && peek().t === 'op' && peek().v === v ? (p += 1, true) : false);
  const isNum = (tok) => tok && tok.t === 'num';

  function expr() {
    let node = term();
    for (;;) {
      if (eat('+')) node = { t: 'add', a: node, b: term() };
      else if (eat('-')) node = { t: 'sub', a: node, b: term() };
      else return node;
    }
  }
  function term() {
    let node = unary();
    for (;;) {
      if (eat('*')) node = { t: 'mul', a: node, b: unary() };
      else if (eat('/')) node = { t: 'div', a: node, b: unary() };
      else return node;
    }
  }
  function unary() {
    if (eat('-')) return { t: 'neg', a: unary() };
    return primary();
  }
  function primary() {
    if (eat('(')) {
      const node = expr();
      if (!eat(')')) throw new Error('括号没闭合');
      return node;
    }
    if (isNum(peek())) {
      const n = peek().v;
      p += 1;
      if (eat('d')) {
        let sides = 6;
        if (isNum(peek())) { sides = peek().v; p += 1; }
        let count = n || 1;
        let keep = 0;
        let mode = '';
        if (peek() && peek().t === 'op' && ['k', 'q', 'dh', 'dl'].includes(peek().v)) {
          mode = peek().v;
          p += 1;
          keep = isNum(peek()) ? peek().v : 0;
          if (isNum(peek())) p += 1;
        }
        if (count > MAX_DICE) throw new Error(`一次最多 ${MAX_DICE} 个骰子`);
        if (sides > MAX_SIDES) throw new Error(`骰面最多 ${MAX_SIDES}`);
        return { t: 'dice', count, sides, keep, mode };
      }
      return { t: 'num', v: n };
    }
    throw new Error('表达式不完整');
  }

  const node = expr();
  if (p < tokens.length) throw new Error(`多余的符号「${tokens[p].v}」`);
  return node;
}

function evalNode(node, ctx, rng) {
  switch (node.t) {
    case 'num': return node.v;
    case 'neg': return -evalNode(node.a, ctx, rng);
    case 'add': return evalNode(node.a, ctx, rng) + evalNode(node.b, ctx, rng);
    case 'sub': return evalNode(node.a, ctx, rng) - evalNode(node.b, ctx, rng);
    case 'mul': return evalNode(node.a, ctx, rng) * evalNode(node.b, ctx, rng);
    case 'div': {
      const d = evalNode(node.b, ctx, rng);
      if (!d) throw new Error('不能除以 0');
      return Math.floor(evalNode(node.a, ctx, rng) / d);
    }
    case 'dice': {
      const rolls = [];
      for (let i = 0; i < node.count; i += 1) rolls.push(1 + Math.floor(rng() * node.sides));
      let used = rolls.slice();
      let dropped = [];
      if (node.keep && node.keep < rolls.length) {
        const sorted = rolls.slice().sort((a, b) => a - b);
        if (node.mode === 'k') {
          const keep = sorted.slice(-node.keep);
          dropped = sorted.slice(0, sorted.length - node.keep);
          used = keep;
        } else if (node.mode === 'q') {
          used = sorted.slice(0, node.keep);
          dropped = sorted.slice(node.keep);
        } else if (node.mode === 'dh') {
          used = sorted.slice(0, sorted.length - node.keep);
          dropped = sorted.slice(sorted.length - node.keep);
        } else if (node.mode === 'dl') {
          used = sorted.slice(node.keep);
          dropped = sorted.slice(0, node.keep);
        }
      }
      const total = used.reduce((a, b) => a + b, 0);
      ctx.parts.push({
        label: `${node.count}d${node.sides}${node.mode ? node.mode + node.keep : ''}`,
        rolls,
        dropped,
        total,
      });
      return total;
    }
    default:
      throw new Error('未知节点');
  }
}

/**
 * 掷一个表达式。
 * @param {string} input 例如 `3d6`、`1d100+5`、`4d6k3`、`(2d6+1)*2`
 * @returns {{ok: boolean, total: number, text: string, detail: string, parts: Array, error?: string}}
 */
export function rollExpression(input, { rng = Math.random } = {}) {
  const src = normalize(input);
  if (!src) return { ok: false, total: 0, text: '要掷什么？比如 3d6 / 1d100+5', detail: '', parts: [] };
  try {
    const node = parse(tokenize(src));
    const ctx = { parts: [] };
    const total = evalNode(node, ctx, rng);
    const detail = ctx.parts
      .map((p) => `${p.label}=[${p.rolls.join(',')}]${p.dropped.length ? ` 弃[${p.dropped.join(',')}]` : ''}`)
      .join('；');
    const text = detail
      ? `🎲 ${src} → ${total}（${detail}）`
      : `🎲 ${src} → ${total}`;
    return { ok: true, total, text, detail, parts: ctx.parts };
  } catch (error) {
    return { ok: false, total: 0, text: `🎲 ${src}：${error.message}`, detail: '', parts: [] };
  }
}
