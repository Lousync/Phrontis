/**
 * 光标同步探针（2026-09-20，修「打中文停顿时光标跳到文末」）
 *
 * 缺陷链（取证结论）：笔记页每次自动保存成功 → 主进程广播 → 模块重读页面 → 回灌 content →
 * @monaco-editor/react 的 `value` prop 一变就 `executeEdits(整模型范围)` → 光标落文末、
 * 输入法组合态被打断。用户症状：敲中文、停顿一下（正是 debounce 触发点）准备按空格，光标自己跑去末尾。
 *
 * 修法（本次）：① MonacoPane 只喂 defaultValue，外部文本由 applyTextDiff 按**最小 diff** 落进模型
 * 并显式恢复光标；② 组合输入期间不落外部文本，compositionend 后再对齐；
 * ③ 笔记页加「自写广播不回灌」守卫（保存后 2s 内忽略 kb-reload-detail）。
 *
 * 断言（真实 DOM + CDP，build 产物）：
 *   C1 知识库编辑态 Monaco 就位（window.__kb_monaco 可达 + markdown 模型 + 可见）
 *   C2 光标置正文中段（非文末），记录偏移
 *   C3 外部改盘（真实 workspaceWriteFile 追加一行）→ 内容真同步进模型（标记行出现）
 *   C4 ★ 光标仍停在中段原偏移（未被甩到文末）—— 回归主断言
 *   C5 原正文中段文本完整（同步不是「整篇重写」而是最小 diff）
 *   C6 console 零 error
 * 收尾：把文件写回原始内容（探针不留污染）。
 *
 * 用法（必须先 electron-vite build）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-caret-sync.mjs --no-sandbox --disable-gpu
 * 前置：先跑 seed-probe-vault.mjs 造 fixture 仓库（README.md 无 frontmatter → draft 页签）。
 */
const DEBUG_PORT = Number(process.env.KB_CDP_PORT || 9222) // 端口可覆盖（见 run-probe.mjs）：默认 9222 不变
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* electron 未起，继续等 */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
const consoleErrors = []
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}
const results = []
function ok(cond, label, detail = '') {
  results.push({ pass: !!cond, label, detail })
  return !!cond
}

/** 取「可见的 markdown 编辑器」——keep-alive 下可能同时挂着编辑器/笔记两个宿主 */
const JS_EDITOR = `(() => {
  const m = window.__kb_monaco
  if (!m) return { noMonaco: true }
  const eds = m.editor.getEditors()
  const ed = eds.find((e) => {
    const node = e.getDomNode()
    const model = e.getModel()
    return !!node && node.offsetParent !== null && !!model && model.getLanguageId() === 'markdown'
  })
  if (!ed) return { count: eds.length, langs: eds.map((e) => e.getModel()?.getLanguageId() ?? '') }
  const model = ed.getModel()
  return { len: model.getValueLength(), text: model.getValue() }
})()`

const dismissPicker = `(() => {
  const txt = document.body.textContent || ''
  if (!txt.includes('选择要进入的仓库')) return 'no-picker'
  const pick = (label) => {
    const cands = [...document.querySelectorAll('button,a,div,span')]
      .filter((el) => (el.textContent || '').trim() === label)
    const target = cands.find((el) => el.tagName === 'BUTTON') || cands[cands.length - 1]
    if (!target) return false
    target.click()
    return true
  }
  if (pick('跳过，直接进入上次使用的仓库')) return 'skip'
  if (pick('探针测试仓库')) return 'fixture-row'
  return 'no-match'
})()`

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(m.params.exceptionDetails?.exception?.value ?? m.params.exceptionDetails?.text ?? '').slice(0, 200))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  for (let i = 0; i < 30; i++) {
    const st = await evalJs(`(() => ({ n: document.querySelector('#root')?.children.length ?? 0 }))()`)
    if (st.n > 0) break
    await sleep(500)
  }
  await evalJs(dismissPicker)
  await sleep(800)

  // ---- 打开 fixture README.md（走 App 自己的 kb-open-note 通道；无 frontmatter → draft 页签）----
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(900)
  await evalJs(`(() => { window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: 'README.md' } })); return 'sent' })()`)
  await sleep(1500)
  // md 页默认进「阅读态」→ Monaco 不挂载；点浮动栏的切换钮进编辑态（title 前缀 = 切换到编辑）
  const enterEdit = `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith('切换到编辑'))
    if (!b) return 'no-btn'
    b.click()
    return 'clicked'
  })()`
  let ed0 = await evalJs(JS_EDITOR)
  for (let i = 0; i < 6 && (!ed0 || ed0.noMonaco || typeof ed0.len !== 'number'); i++) {
    await evalJs(enterEdit)
    await sleep(1200)
    ed0 = await evalJs(JS_EDITOR)
    if (!ed0 || typeof ed0.len !== 'number') {
      await evalJs(`(() => { window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: 'README.md' } })); return 'sent' })()`)
    }
  }
  ok(!!ed0 && !ed0.noMonaco && typeof ed0.len === 'number',
    'C1 知识库编辑态 Monaco 就位（markdown 模型可见）', JSON.stringify(ed0).slice(0, 160))
  if (!ed0 || typeof ed0.len !== 'number') throw new Error('编辑器未就位，后续断言无法进行')

  const original = ed0.text
  const marker = `\n\n<!-- caret-sync-probe ${Date.now()} -->\n`
  const caretTarget = Math.max(1, Math.floor(ed0.len / 2))

  // ---- 光标置中段 ----
  const caretBefore = await evalJs(`(() => {
    const eds = window.__kb_monaco.editor.getEditors()
    const ed = eds.find((e) => e.getDomNode()?.offsetParent !== null && e.getModel()?.getLanguageId() === 'markdown')
    const model = ed.getModel()
    ed.focus()
    ed.setPosition(model.getPositionAt(${caretTarget}))
    return model.getOffsetAt(ed.getPosition())
  })()`)
  ok(caretBefore === caretTarget && caretBefore < ed0.len,
    'C2 光标置正文中段（非文末）', `caret=${caretBefore} len=${ed0.len}`)

  // ---- 外部改盘：真实 IPC 写文件（追加一行标记），再派发 App 自己的重读事件 ----
  const wrote = await evalJs(`(async () => {
    const cur = await window.api.workspaceGetCurrent()
    if (!cur?.rootId) return { err: 'no-root' }
    const read = await window.api.workspaceReadFile(cur.rootId, 'README.md')
    const text = typeof read?.content === 'string' ? read.content : read
    const res = await window.api.workspaceWriteFile(cur.rootId, 'README.md', text + ${JSON.stringify(marker)})
    return { ok: !!(res?.ok ?? true), root: cur.rootId }
  })()`)
  await sleep(600)
  await evalJs(`(() => { window.dispatchEvent(new CustomEvent('kb-reload-detail')); return 'sent' })()`)

  // ---- 等模型同步（标记行落进模型）----
  let after = null
  for (let i = 0; i < 12; i++) {
    after = await evalJs(JS_EDITOR)
    if (after && typeof after.text === 'string' && after.text.includes('caret-sync-probe')) break
    await sleep(500)
  }
  ok(!!wrote && !wrote.err, 'C3a 外部改盘成功（workspaceWriteFile）', JSON.stringify(wrote))
  ok(!!after && after.text.includes('caret-sync-probe'),
    'C3b 外部内容真同步进模型（追加的标记行出现在编辑器中）',
    `len=${after?.len} hasMarker=${!!after?.text?.includes('caret-sync-probe')}`)

  const caretAfter = await evalJs(`(() => {
    const eds = window.__kb_monaco.editor.getEditors()
    const ed = eds.find((e) => e.getDomNode()?.offsetParent !== null && e.getModel()?.getLanguageId() === 'markdown')
    const model = ed.getModel()
    return { caret: model.getOffsetAt(ed.getPosition()), len: model.getValueLength() }
  })()`)
  ok(caretAfter?.caret === caretBefore,
    'C4 ★ 光标仍停在中段原偏移（未被甩到文末）',
    `before=${caretBefore} after=${caretAfter?.caret} docLen=${caretAfter?.len}`)
  ok((caretAfter?.caret ?? -1) !== (caretAfter?.len ?? -2),
    'C4b 光标不在文末（旧行为的典型落点）', `caret=${caretAfter?.caret} len=${caretAfter?.len}`)

  const midOk = !!after?.text && after.text.length >= caretTarget &&
    after.text.slice(0, caretTarget) === original.slice(0, caretTarget)
  ok(midOk, 'C5 原正文中段文本完整（最小 diff，非整篇重写）', `midOk=${midOk}`)

  // ---- 收尾：写回原始内容 ----
  await evalJs(`(async () => {
    const cur = await window.api.workspaceGetCurrent()
    if (!cur?.rootId) return 'no-root'
    await window.api.workspaceWriteFile(cur.rootId, 'README.md', ${JSON.stringify(original)})
    return 'restored'
  })()`)
  await sleep(400)

  ok(consoleErrors.length === 0, 'C6 console 零 error', consoleErrors.slice(0, 3).join(' | '))

  console.log('\n========================================')
  const fails = results.filter((r) => !r.pass)
  const pass = results.length - fails.length
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.pass ? '' : '   → ' + r.detail}`)
  console.log('========================================')
  if (fails.length === 0) console.log(`✅ 全部通过：${pass} 项断言 PASS`)
  else console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  try { ws.close() } catch { /* 收尾 */ }
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常:', e.message); process.exit(2) })
