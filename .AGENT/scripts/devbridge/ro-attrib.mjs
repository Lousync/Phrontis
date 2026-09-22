/* ResizeObserver 循环归因探针 —— B-19（docs/pending-fixes.md）的复现与归因工具。
 *
 * 前置：一个开着调试桥的 dev 实例（KNOWBASE_DEV_BRIDGE=1 → http://127.0.0.1:7465），
 *      且当前仓库里有书、左栏能列出书目（`seed-probe-vault.mjs --add-books` 的 fixture 即可）。
 * ★ 与 CDP 探针（workbench-shell/probes/run-probe.mjs）**不是一套**：它连的是**你正在跑的实例**，
 *   不去抢单实例锁 —— 所以必须和 dev 实例指向**同一个检出**，否则测的是另一棵树。
 *
 * 判据靠**差量**，不靠肉眼看终端：
 *   `node .AGENT/scripts/devbridge/ro-attrib.mjs allerrs` 在动作前后各读一次，看
 *   ResizeObserver 那条的 `count` 是否停住（Δ=0）；`cycle <i>` 顺带给出按创建点的归因栈。
 *   日志环现在会**折叠紧邻重复**（同消息 count 累加），所以读数看 count、不看行数。
 *
 * 用法：node .AGENT/scripts/devbridge/ro-attrib.mjs health|errors|allerrs|install|dom|summary|log
 *       cycle <i> [waitIn] [waitOut]            —— 按**侧栏第 i 条**开书往返（侧栏 label 会随阅读状态漂，慎用）
 *       cycleby <relPath> [waitIn] [waitOut]    —— 按**relPath 精确指书**开书往返（推荐；对应 B-21 的手法）
 */
const BRIDGE = 'http://127.0.0.1:7465';
const act = process.argv[2] || 'health';

async function call(name, params = {}) {
  const r = await fetch(BRIDGE + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, params }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  // 取值在 data.result.result
  return j.data?.result?.result ?? j.data?.result ?? j;
}
const ev = (code) => call('ui.eval', { code });
const show = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));

const INSTALL = `(() => {
  if (window.__roProbe) return 'already installed';
  const Orig = window.ResizeObserver;
  const recs = []; window.__roRecs = recs;
  class RO {
    constructor(cb) {
      const stack = (new Error()).stack || '';
      this.__stack = stack.split('\\n').slice(1, 5).join(' <- ').replace(/\\s+/g, ' ');
      this.__inner = new Orig((entries, obs) => {
        const el = entries[0] && entries[0].target;
        recs.push({ t: performance.now(), stack: this.__stack,
          tag: el ? (el.tagName || '?').toLowerCase() : null,
          cls: el && el.className ? String(el.className).slice(0, 60) : null,
          w: el ? Math.round(el.getBoundingClientRect().width) : null,
          h: el ? Math.round(el.getBoundingClientRect().height) : null });
        if (recs.length > 8000) recs.splice(0, 2000);
        return cb(entries, obs);
      });
    }
    observe(...a) { return this.__inner.observe(...a) }
    unobserve(...a) { return this.__inner.unobserve(...a) }
    disconnect() { return this.__inner.disconnect() }
  }
  window.ResizeObserver = RO;
  // 同时统计 Chromium 抛的 loop 告警（它是以 error 事件形式投递的）
  window.__roErrors = 0; window.__roErrStacks = [];
  window.addEventListener('error', (e) => {
    if (/ResizeObserver loop/.test(e.message || '')) {
      window.__roErrors++;
      window.__roErrStacks.push({ msg: e.message, file: e.filename, line: e.lineno, t: performance.now() });
    }
  }, true);
  window.__roProbe = true;
  return 'installed';
})()`;

const SUMMARY = `(() => {
  const recs = window.__roRecs || [];
  const byStack = new Map();
  for (const r of recs) {
    const k = r.stack;
    const cur = byStack.get(k) || { n: 0, tags: new Set(), sample: r };
    cur.n++; if (r.tag) cur.tags.add(r.tag + (r.cls ? '.' + r.cls : '') + ' ' + r.w + 'x' + r.h);
    byStack.set(k, cur);
  }
  const top = [...byStack.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
    .map(([k, v], i) => (i + 1) + ') ' + v.n + ' 次 · ' + [...v.tags].slice(0, 3).join(' / ') + '\\n    ← ' + k);
  // 帧内密集度：统计「同一毫秒附近连发」的峰值
  const ts = recs.map(r => r.t);
  let peak = 0, burstStart = 0;
  for (let i = 0; i < ts.length; i++) {
    let j = i; while (j + 1 < ts.length && ts[j + 1] - ts[i] < 100) j++;
    if (j - i + 1 > peak) { peak = j - i + 1; burstStart = ts[i]; }
    i = j;
  }
  const span = ts.length ? Math.round(ts[ts.length - 1] - ts[0]) : 0;
  return '回调总数=' + recs.length + ' · 时间跨度=' + span + 'ms' + ' · 100ms 内最大连发=' + peak +
    '\\nloop 告警计数=' + (window.__roErrors || 0) +
    '\\n告警样本=' + JSON.stringify((window.__roErrStacks || []).slice(-2)) +
    '\\n--- 按创建点归因（Top10）---\\n' + top.join('\\n');
})()`;

const DOM = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 };
  const books = [...document.querySelectorAll('[data-wb-bookshelf] [data-wb-book], .kb-book-card, [data-book]')].filter(vis);
  const btns = [...document.querySelectorAll('button')].filter(vis)
    .map(b => (b.title || b.textContent || '').trim().slice(0, 18)).filter(Boolean);
  return '书卡锚点候选=' + books.length + ' 例:' + books.slice(0, 3).map(b => b.tagName + '[' + b.className.slice(0, 40) + ']').join(' , ') +
    '\\n可见按钮=' + JSON.stringify(btns.slice(0, 30));
})()`;

const LOG = `(() => {
  const recs = window.__roRecs || [];
  return '最近 25 条：\\n' + recs.slice(-25).map(r => Math.round(r.t) + 'ms ' + r.tag + '.' + r.cls + ' ' + r.w + 'x' + r.h + ' ← ' + r.stack.slice(0, 90)).join('\\n');
})()`;

try {
  if (act === 'health') {
    const r = await fetch(BRIDGE + '/health').catch(() => null);
    console.log('GET /health →', r ? r.status + ' ' + (await r.text()).slice(0, 200) : '不可达');
  } else if (act === 'errors') {
    const r = await fetch(BRIDGE + '/errors');
    const t = await r.text();
    const lines = t.split('\n');
    const ro = lines.filter((l) => /ResizeObserver/.test(l));
    console.log('状态 ' + r.status + ' · 总行数 ' + lines.length + ' · 含 ResizeObserver 的行 ' + ro.length);
    console.log(lines.slice(0, 12).join('\n').slice(0, 1200));
  } else if (act === 'scan') {
    const from = Number(process.argv[3] || 0), to = Number(process.argv[4] || 8);
    const roCount = async () => {
      const r = await fetch(BRIDGE + '/errors');
      const j = await r.json();
      const it = (j.data?.items || []).find((x) => /ResizeObserver loop/.test(x.message) && x.scope === 'renderer');
      return it ? it.count : 0;
    };
    for (let i = from; i < to; i++) {
      const before = await roCount();
      const info = await ev(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const bs = [...document.querySelectorAll('[data-wb=bookshelfSideList] button')];
        if (!bs[${i}]) return 'N/A';
        const name = (bs[${i}].title || bs[${i}].textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);
        window.__roRecs.length = 0;
        bs[${i}].click(); await sleep(1000);
        const anchors = [...new Set([...document.querySelectorAll('[data-wb]')].map(e => e.getAttribute('data-wb')))]
          .filter(a => /eader|Host|Canvas|View|pdf|Zoom|epub/i.test(a)).join(',');
        const bk = [...document.querySelectorAll('button')].find(b => /返回书架/.test((b.title || b.textContent || '')))
          || document.querySelector('[data-wb=epubBack]');
        if (!bk) return name + ' · 无返回按钮 · 阅读态锚点=' + anchors;
        bk.click(); await sleep(2000);
        const stacks = new Map();
        for (const r of window.__roRecs) stacks.set(r.stack, (stacks.get(r.stack) || 0) + 1);
        const top = [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => v + '次←' + k.slice(0, 130)).join(' ; ');
        return name + ' · 锚点=' + anchors + ' · 主文档回调=' + window.__roRecs.length + (top ? ' · ' + top : '');
      })()`);
      const after = await roCount();
      console.log(`[${i}] Δ告警=${after - before} (${before}→${after})  ${info}`);
    }
  } else if (act === 'allerrs') {
    const j = await (await fetch(BRIDGE + '/errors')).json();
    const items = j.data?.items || [];
    console.log('共 ' + items.length + ' 类消息：');
    for (const it of items) {
      console.log('  ' + String(it.count).padStart(5) + ' × [' + it.scope + '] ' + (it.firstTs || '').slice(11, 19) + '→' + (it.lastTs || '').slice(11, 19) + '  ' + it.message.replace(/\s+/g, ' ').slice(0, 150));
    }
  } else if (act === 'install') show(await ev(INSTALL));
  else if (act === 'raw') show(await ev(process.argv[3]));
  else if (act === 'shelf') {
    show(await ev(`[...document.querySelectorAll('[data-wb=bookshelfSideList] button')]
      .map((b, i) => i + ' · ' + ((b.title || b.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 46))).join('\\n')`));
  } else if (act === 'cycleby') {
    // 按 **relPath 精确指书**（`cycle` 走侧栏，侧栏书名是按阅读状态算出来的 —— `已读 29%` /
    // `第 1 / 12 页`，第二轮起指的就是别的书；实测踩过。书架**主网格**卡片的 `title` 恒为 relPath）。
    const rel = process.argv[3] || '.books/探针样书.epub';
    const waitIn = Number(process.argv[4] || 1500), waitOut = Number(process.argv[5] || 2500);
    show(await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // 若此刻有书开着，先回书架 —— 否则书卡不在 DOM 里（阅读器是 Tab，点书架锚点不会关掉它）
      const back = [...document.querySelectorAll('button')].find(b => /返回书架/.test(b.title || b.textContent || ''));
      if (back) { back.click(); await sleep(1500); }
      const card = [...document.querySelectorAll('main button')]
        .find(b => (b.getAttribute('title') || '') === ${JSON.stringify(rel)});
      if (!card) return '未找到卡片 ' + ${JSON.stringify(rel)} + ' · 现有：' +
        [...document.querySelectorAll('main button')].map(b => b.getAttribute('title') || '')
          .filter(Boolean).slice(0, 10).join(' / ');
      window.__roRecs.length = 0; window.__roErrors = 0;
      card.click(); await sleep(${waitIn});
      const eng = document.querySelector('[data-wb=epubReader]') ? 'foliate'
        : (document.querySelector('[data-wb=pdfReader]') ? 'pdf'
        : (document.querySelector('[data-wb=txtReader]') ? 'txt' : '未挂上'));
      const bk = [...document.querySelectorAll('button')].find(b => /返回书架/.test(b.title || b.textContent || ''));
      if (!bk) return ${JSON.stringify(rel)} + ' · 引擎=' + eng + ' · 无返回按钮';
      bk.click(); await sleep(${waitOut});
      return ${JSON.stringify(rel)} + ' · 引擎=' + eng + ' · 主文档RO回调=' + window.__roRecs.length
        + ' · 页内loop告警=' + window.__roErrors;
    })()`));
  } else if (act === 'cycle') {
    const i = Number(process.argv[3] || 0);
    const waitIn = Number(process.argv[4] || 900), waitOut = Number(process.argv[5] || 1800);
    show(await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const bs = [...document.querySelectorAll('[data-wb=bookshelfSideList] button')];
      if (!bs[${i}]) return '无此条目 ' + ${i};
      const name = (bs[${i}].title || bs[${i}].textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      window.__roRecs.length = 0; window.__roErrors = 0;
      bs[${i}].click(); await sleep(${waitIn});
      const eng = document.querySelector('[data-wb=epubReader]') ? 'epub' : (document.querySelector('[data-wb=pdfReader]') ? 'pdf' : (document.querySelector('[data-wb=txtReader]') ? 'txt' : '未知'));
      const bk = [...document.querySelectorAll('button')].find(b => /返回书架/.test((b.title || b.textContent || '')))
        || document.querySelector('[data-wb=epubBack]');
      if (!bk) return name + ' → ' + eng + ' · 无返回按钮';
      bk.click(); await sleep(${waitOut});
      const stacks = new Map();
      for (const r of window.__roRecs) stacks.set(r.stack, (stacks.get(r.stack) || 0) + 1);
      const top = [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v], n) => (n + 1) + ') ' + v + '次 ← ' + k.slice(0, 150)).join('\\n   ');
      return name + ' → 引擎=' + eng + ' · 主文档RO回调=' + window.__roRecs.length + ' · 页内loop告警=' + window.__roErrors +
        (top ? '\\n   归因:\\n   ' + top : '');
    })()`));
  }
  else if (act === 'dom') show(await ev(DOM));
  else if (act === 'summary') show(await ev(SUMMARY));
  else if (act === 'log') show(await ev(LOG));
  else console.log('未知动作');
} catch (e) {
  console.log('FAIL: ' + e.message);
  process.exit(1);
}
