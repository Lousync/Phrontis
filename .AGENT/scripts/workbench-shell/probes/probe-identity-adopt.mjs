/**
 * 身份统一探针（阶段一，2026-09-20，docs/note-identity-unify-design.md §1）
 *
 * 锁两件事：
 *   ① 无 frontmatter id 的 .md **进索引**（旧行为：被跳过 / 需被归档目录覆盖才有 auto id）；
 *   ② 该文件**首次被编辑保存**时自动补真 UUID（旧行为：要用户点「转为正式笔记」）。
 *
 * 断言（真实 DOM + CDP，build 产物）：
 *   A1 前置：fixture README.md 确实**没有** frontmatter id
 *   A2 索引收录它（getKnowledgePages 里存在 path=README.md，id 前缀 auto:）
 *   A3 打开文件进编辑态（Monaco 就位）
 *   A4 键入内容 → 触发自动保存 → 磁盘文件出现 id:（UUID 形态，不是 auto:）
 *   A5 索引刷新后该页 id 变成真 UUID（身份升级完成）
 *   A6 console 零 error
 * 收尾：写回原始内容（无 id），探针不留污染。
 *
 * 用法（必须先 electron-vite build）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-identity-adopt.mjs --no-sandbox --disable-gpu
 * 前置：先跑 seed-probe-vault.mjs（README.md 无 frontmatter → 正是本探针要的样本）。
 */
const DEBUG_PORT = 9222
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
const readFileJs = `(async () => {
  const cur = await window.api.workspaceGetCurrent()
  if (!cur?.rootId) return { err: 'no-root' }
  const r = await window.api.workspaceReadFile(cur.rootId, 'README.md')
  return { rootId: cur.rootId, content: typeof r?.content === 'string' ? r.content : r }
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

  // ---- A1 前置：fixture README.md 无 id ----
  const before = await evalJs(readFileJs)
  const original = before?.content ?? ''
  const hasIdBefore = /^---\r?\n(?:(?!---)[\s\S])*?^id:[ \t]*\S/m.test(original)
  ok(before && !before.err && original.length > 0 && !hasIdBefore,
    'A1 前置：fixture README.md 无 frontmatter id', `len=${original.length} hasId=${hasIdBefore}`)

  // ---- A2 索引收录（身份 auto:） ----
  // 先强制全量刷新：fixture 目录里可能残留上一轮构建的索引缓存（当时无 id 的 md 还被跳过），
  // 不刷新会读到旧结果 → 假 FAIL（本探针首跑实测）。
  await evalJs(`(async () => { try { await window.api.workspaceRefreshVault() } catch {} return 'ok' })()`)
  let pages0 = null
  for (let i = 0; i < 12; i++) {
    pages0 = await evalJs(`(async () => {
      const ps = await window.api.getKnowledgePages()
      const hit = (ps || []).find((p) => p.path === 'README.md')
      return hit ? { id: hit.id, title: hit.title, path: hit.path } : { none: true, total: (ps || []).length }
    })()`)
    if (pages0 && pages0.id) break
    await sleep(700)
  }
  ok(!!pages0 && String(pages0.id).startsWith('auto:'),
    'A2 无 id 的 md 已被索引收录（身份 = auto:<relPath>）', JSON.stringify(pages0))

  // ---- A3 打开进编辑态 ----
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(900)
  await evalJs(`(() => { window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: 'README.md' } })); return 'sent' })()`)
  await sleep(1500)
  const enterEdit = `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith('切换到编辑'))
    if (!b) return 'no-btn'
    b.click()
    return 'clicked'
  })()`
  let ed = await evalJs(`(() => {
    const m = window.__kb_monaco
    if (!m) return { noMonaco: true }
    const eds = m.editor.getEditors()
    const one = eds.find((e) => e.getDomNode()?.offsetParent !== null && e.getModel()?.getLanguageId() === 'markdown')
    return one ? { len: one.getModel().getValueLength() } : { count: eds.length }
  })()`)
  for (let i = 0; i < 6 && (!ed || typeof ed.len !== 'number'); i++) {
    await evalJs(enterEdit)
    await sleep(1200)
    ed = await evalJs(`(() => {
      const m = window.__kb_monaco
      if (!m) return { noMonaco: true }
      const eds = m.editor.getEditors()
      const one = eds.find((e) => e.getDomNode()?.offsetParent !== null && e.getModel()?.getLanguageId() === 'markdown')
      return one ? { len: one.getModel().getValueLength() } : { count: eds.length }
    })()`)
  }
  ok(!!ed && typeof ed.len === 'number', 'A3 文件页进编辑态（Monaco 就位）', JSON.stringify(ed))
  if (!ed || typeof ed.len !== 'number') throw new Error('编辑器未就位，后续断言无法进行')

  // ---- A4 键入 → 自动保存 → 磁盘出现 id ----
  const stamp = 'AUTO-ID-PROBE-' + Date.now()
  await evalJs(`(() => {
    const m = window.__kb_monaco
    const eds = m.editor.getEditors()
    const edp = eds.find((e) => e.getDomNode()?.offsetParent !== null && e.getModel()?.getLanguageId() === 'markdown')
    const model = edp.getModel()
    const end = model.getPositionAt(model.getValueLength())
    edp.executeEdits('probe-type', [{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: '\\n' + ${JSON.stringify(stamp)} + '\\n', forceMoveMarkers: true }])
    return model.getValue().includes(${JSON.stringify(stamp)})
  })()`)
  let after = null
  for (let i = 0; i < 20; i++) {
    await sleep(700)
    after = await evalJs(readFileJs)
    if (after && !after.err && /^---\r?\n(?:(?!---)[\s\S])*?^id:[ \t]*\S/m.test(after.content || '')) break
  }
  const idMatch = (after?.content || '').match(/^id:[ \t]*(\S+)/m)
  const idVal = idMatch ? idMatch[1] : ''
  ok(!!idVal && !idVal.startsWith('auto:') && /^[0-9a-f-]{36}$/i.test(idVal),
    'A4 ★ 首次保存自动补 id（磁盘文件出现真 UUID）', `id=${idVal || '(none)'}`)
  ok((after?.content || '').includes(stamp), 'A4b 本次键入内容已落盘（保存链路正常，非旁路）')

  // ---- A5 索引里身份升级 ----
  let pages1 = null
  for (let i = 0; i < 12; i++) {
    pages1 = await evalJs(`(async () => {
      const ps = await window.api.getKnowledgePages()
      const hit = (ps || []).find((p) => p.path === 'README.md')
      return hit ? { id: hit.id } : null
    })()`)
    if (pages1 && !String(pages1.id).startsWith('auto:')) break
    await sleep(700)
  }
  ok(!!pages1 && String(pages1.id).replace(':', '') !== '' && !String(pages1.id).startsWith('auto:'),
    'A5 ★ 索引中该页身份已升级为真 id（auto: 前缀消失）', JSON.stringify(pages1))

  // ---- 收尾：写回原内容 ----
  await evalJs(`(async () => {
    const cur = await window.api.workspaceGetCurrent()
    if (!cur?.rootId) return 'no-root'
    await window.api.workspaceWriteFile(cur.rootId, 'README.md', ${JSON.stringify(original)})
    return 'restored'
  })()`)
  await sleep(600)
  const restored = await evalJs(readFileJs)
  ok((restored?.content || '') === original, 'A6 收尾：文件已写回原始内容（无 id）')

  ok(consoleErrors.length === 0, 'A7 console 零 error', consoleErrors.slice(0, 3).join(' | '))

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
