/**
 * B-14 探针：AI 教学区文件树的「新建 / 重命名」= 条目内联输入（2026-09-22）
 *
 * 要证的两件事（旧版做不到，所以是真回归验证而不是复述源码）：
 *   ① 输入框出现在**树里**，不在居中弹窗里 —— 运行期判据：输入框的祖先链里没有 `position: fixed`
 *      （旧实现是 `fixed inset-0 z-[90] flex items-center justify-center`，输入框必然是 fixed 的后代）。
 *   ② 内联行的**签名**：默认值「新目录」+ placeholder「名称…」（共享 InlineCreateRow 的字面量）；
 *      旧弹窗是空值 + placeholder「名称（含扩展名）」—— 两者在 DOM 上可区分。
 *   ③ 重命名是**原地替换该行**（旧实现保留行、另弹一窗）：重命名时该 relPath 的 title 行必须消失。
 *
 * ★ 零副作用：全程只用 **Esc 取消**，不按 Enter、不提交 —— 不往用户仓库写任何文件/目录。
 *   每次取消后都回读条目数与条目名，证明确实没落盘。
 *
 * 用法（必须先 electron-vite build）：
 *   KNOWBASE_PROBE_PORT=9333 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b14-teach-inline.mjs
 * 前置：dev 仓库的 AI教学 产物根里有内容（本机 = 生活与记录 / E:\生活与记录\AI教学）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join(process.cwd(), 'tmp', 'probe-shots')

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
async function shot(name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'))
    return join(SHOT_DIR, name + '.png')
  } catch (e) { return 'shot 失败 ' + e.message }
}
/** 真键盘（InlineCreateRow 的 onKeyDown 挂在 input 上，必须真事件 + 焦点在它身上） */
async function realKey(key, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
}
/** 真左键（展开目录用） */
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}
/** 真右键（Chromium 输入管线会生成 contextmenu） */
async function realRightClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1, buttons: 2 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1, buttons: 0 })
}
/** 合成 contextmenu（真右键没生成事件时的退路，结果里会注明用了哪条路） */
const synthCtx = (title) => evalJs(`(() => {
  const row = document.querySelector('div[draggable][title=' + JSON.stringify(${JSON.stringify(title)}) + ']')
  if (!row) return false
  const r = row.getBoundingClientRect()
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 8), clientY: Math.round(r.top + 4) }))
  return true
})()`)

const results = []
function ok(cond, label, detail = '') {
  results.push({ pass: !!cond, label, detail })
  return !!cond
}

/** 可见的树条目（AI 教学左栏；opacity:0 / 0 高度 = 栏目收起，不算） */
const JS_ROWS = `(() => {
  const rows = [...document.querySelectorAll('div[draggable][title]')].filter(el => {
    const r = el.getBoundingClientRect()
    return r.width > 40 && r.height > 8
  })
  return rows.map(el => ({
    rel: el.getAttribute('title'),
    name: (el.textContent || '').trim(),
    x: Math.round(el.getBoundingClientRect().left),
    y: Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
    padLeft: el.style.paddingLeft,
  }))
})()`

/** 内联输入行的取证：值 / placeholder / 祖先链里有没有 fixed / 是否落在树内 / 是否已聚焦 */
const JS_INLINE = `(() => {
  const inputs = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio])')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 8 })
  const inp = inputs[0] ?? null
  if (!inp) return { present: false }
  const r = inp.getBoundingClientRect()
  const chain = []
  for (let el = inp.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el)
    if (cs.position === 'fixed' || cs.position === 'absolute') {
      chain.push({ pos: cs.position, inset: cs.inset, z: cs.zIndex, cls: (el.className || '').toString().slice(0, 48) })
    }
  }
  const rowBox = inp.closest('div[style*="padding-left"]')
  // 旧弹窗签名：居中（左右近似相等）+ 输入框宽 ≈ 288（w-80 减 p-4）
  const centered = Math.abs((window.innerWidth / 2) - (r.left + r.width / 2)) < 6
  return {
    present: true,
    count: inputs.length,
    value: inp.value,
    placeholder: inp.placeholder,
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    fixedAncestors: chain,
    centeredInWindow: centered && r.width > 240,
    rowPadLeft: rowBox ? rowBox.style.paddingLeft : null,
    focused: document.activeElement === inp,
  }
})()`

async function menuLabels() {
  return await evalJs(`[...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(t => t.startsWith('＋') || t === '重命名')`)
}
const clickMenuItem = (label) => evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === ${JSON.stringify(label)})
  if (!b) return false
  b.click()
  return true
})()`)

async function main() {
  const page = await waitPage()
  console.log('page target:', page.url?.slice(0, 60), '|', page.title?.slice(0, 40))
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
    const n = await evalJs(`document.querySelector('#root')?.children.length ?? 0`)
    if (n > 0) break
    await sleep(500)
  }
  // 仓库选择浮层：只跳过，绝不点「打开」（原生对话框会卡死探针）
  const pickerAct = await evalJs(`(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const pick = (label) => {
      const c = [...document.querySelectorAll('button,a,div,span')].filter(el => (el.textContent || '').trim() === label)
      const t = c.find(el => el.tagName === 'BUTTON') || c[c.length - 1]
      if (t) { t.click(); return true }
      return false
    }
    if (pick('跳过，直接进入上次使用的仓库')) return 'skip'
    return 'picker-no-action'
  })()`)
  if (pickerAct !== 'no-picker') console.log('[前置] 仓库选择浮层:', pickerAct)
  await sleep(1500)

  // ---------- Q0 前置：进 AI 教学 → 左栏资源管理器树可见 ----------
  const intoAi = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button[title]')].find(x => x.title === 'AI 教学')
    if (!b) return false
    b.click()
    return true
  })()`)
  ok(intoAi, 'Q0a 活动栏「AI 教学」可点（探针导航前置）', `clicked=${intoAi}`)
  await sleep(1800)

  let rows = await evalJs(JS_ROWS)
  if (rows.length === 0) {
    // 「资源管理器」栏目可能收起（grid-rows 0fr + opacity 0）→ 展开
    const expanded = await evalJs(`(() => {
      const head = [...document.querySelectorAll('div,button')].find(el => (el.textContent || '').trim().startsWith('资源管理器') && el.children.length <= 3)
      if (!head) return false
      head.click()
      return true
    })()`)
    await sleep(1000)
    rows = await evalJs(JS_ROWS)
    console.log('[前置] 资源管理器栏目展开:', expanded)
  }
  const dirRow = rows.find(r => !/\.[a-z0-9]{2,4}$/i.test(r.rel))
  const fileRow = rows.find(r => /\.md$/i.test(r.rel))
  console.log('[前置] 树条目', rows.length, '| 目录样例 =', JSON.stringify(dirRow), '| 文件样例 =', JSON.stringify(fileRow))
  // 注意（首跑踩到）：教学区树的根 = **当前工作区段**（subRel = wsTreeSeg），不是 AI教学 产物根本身，
  // 所以条目数天然少（本机该层只有 2 个目录）。断言只要求「有可右键的目录」，不假设条目多。
  ok(rows.length >= 1 && !!dirRow,
    'Q0b 教学区左栏树可见且含目录条目（真机验证的前提）',
    `rows=${rows.length} dir=${dirRow ? dirRow.rel : 'none'} :: ${rows.slice(0, 4).map(r => r.rel).join(' | ')}`)
  if (!dirRow) { console.log('\n[中止] 教学区产物根无可右键的目录 → 无法验证'); process.exit(3) }

  // 负向观察器：旧居中弹窗（fixed inset-0 后代含 input）若复活必须被抓住
  await evalJs(`(() => {
    window.__b14 = { modal: 0 }
    window.__b14obs = new MutationObserver(() => {
      for (const el of document.querySelectorAll('div')) {
        const cs = getComputedStyle(el)
        if (cs.position === 'fixed' && parseFloat(cs.top) === 0 && parseFloat(cs.left) === 0 && el.querySelector('input') && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)') {
          window.__b14.modal++
        }
      }
    })
    window.__b14obs.observe(document.body, { childList: true, subtree: true })
    return true
  })()`)

  const baseline = await evalJs(JS_ROWS)

  // ---------- Q1 右键目录 → 菜单（新建 / 重命名） ----------
  await realRightClick(dirRow.x + 30, dirRow.y)
  await sleep(700)
  let labels = await menuLabels()
  let ctxPath = '真右键'
  if (labels.length === 0) {
    ctxPath = '合成 contextmenu（真右键未生成）'
    await synthCtx(dirRow.rel)
    await sleep(600)
    labels = await menuLabels()
  }
  ok(labels.includes('＋ 新建文件夹') && labels.includes('＋ 新建文件') && labels.includes('重命名'),
    'Q1 ★ 右键目录出现操作菜单（含「＋ 新建文件夹」「＋ 新建文件」「重命名」）',
    `路径=${ctxPath} labels=${JSON.stringify(labels)}`)
  await shot('b14-q1-ctx-menu')

  // ---------- Q2/Q3/Q4 「＋ 新建文件夹」→ 树内联输入行 ----------
  const clickedNew = await clickMenuItem('＋ 新建文件夹')
  await sleep(700)
  const inline = await evalJs(JS_INLINE)
  ok(clickedNew && inline.present,
    'Q2 ★★ 点「＋ 新建文件夹」→ 出现可编辑输入框（旧实现是居中弹窗，此处即分水岭）',
    `clicked=${clickedNew} present=${inline.present} count=${inline.count ?? 0}`)
  ok(inline.present && inline.fixedAncestors.length === 0 && !inline.centeredInWindow,
    'Q3 ★★ 该输入框**在树里、不在居中弹窗里**（祖先链零 fixed/absolute；不居中）',
    `fixed祖先=${JSON.stringify(inline.fixedAncestors)} 居中=${inline.centeredInWindow} rect=${JSON.stringify(inline.rect)}`)
  ok(inline.value === '新目录' && inline.placeholder === '名称…',
    'Q4 ★ 内联行签名：默认名「新目录」+ placeholder「名称…」（旧弹窗是空值 +「名称（含扩展名）」）',
    `value=${JSON.stringify(inline.value)} placeholder=${JSON.stringify(inline.placeholder)}`)
  ok(inline.focused === true,
    'Q5 ★ 输入框已自动聚焦（无需再点一次，与知识库同体感）',
    `focused=${inline.focused} rowPadLeft=${inline.rowPadLeft}`)
  ok(inline.rowPadLeft && inline.rowPadLeft !== '6px',
    'Q6 ★ 输入行按目标目录缩进（在目录子级里，不是根层）',
    `rowPadLeft=${inline.rowPadLeft}（目标目录 = ${dirRow.rel}）`)
  await shot('b14-q2-inline-create')

  // ---------- Q7 Esc 取消：输入框消失 + 未写盘 ----------
  await realKey('Escape', 'Escape', 27)
  await sleep(600)
  const afterEsc = await evalJs(JS_INLINE)
  const rowsAfterEsc = await evalJs(JS_ROWS)
  ok(!afterEsc.present,
    'Q7 ★ Esc 取消 → 输入行退场（B-14 验收口径：Esc 行为与笔记区一致）',
    `present=${afterEsc.present}`)
  ok(rowsAfterEsc.length === baseline.length,
    'Q8 ★ Esc 取消未落盘：条目数不变（探针零副作用）',
    `before=${baseline.length} after=${rowsAfterEsc.length}`)

  // ---------- Q9/Q10/Q11 重命名 = 原地替换该行 ----------
  // 当前树层往往全是目录（本机 = 2 个），需要先展开一层才看得到文件行。
  // 展开是只读操作（ws:listDir），且不改变任何落盘数据。
  let fileRowNow = fileRow
  if (!fileRowNow) {
    for (const d of rows.filter(r => !/\.[a-z0-9]{2,4}$/i.test(r.rel)).slice(0, 2)) {
      await realClick(d.x + 30, d.y) // 点目录行 = 展开（onToggleDir）
      await sleep(900)
      const rs = await evalJs(JS_ROWS)
      fileRowNow = rs.find(r => /\.[a-z0-9]{2,4}$/i.test(r.rel))
      if (fileRowNow) { console.log('[前置] 展开', d.rel, '→ 文件行', fileRowNow.rel); break }
    }
  }
  const base2 = await evalJs(JS_ROWS)
  if (fileRowNow) {
    await realRightClick(fileRowNow.x + 30, fileRowNow.y)
    await sleep(700)
    let labels2 = await menuLabels()
    if (labels2.length === 0) { await synthCtx(fileRowNow.rel); await sleep(600); labels2 = await menuLabels() }
    const clickedRename = await clickMenuItem('重命名')
    await sleep(700)
    const ren = await evalJs(JS_INLINE)
    // 该行是否已被内联行替换（原 title 行消失）
    const rowGone = await evalJs(`!document.querySelector('div[draggable][title=${JSON.stringify(fileRowNow.rel)}]')`)
    ok(clickedRename && ren.present && ren.value === fileRowNow.rel.split('/').pop(),
      'Q9 ★ 右键文件「重命名」→ 原地换成内联输入行，预填原名',
      `clicked=${clickedRename} present=${ren.present} value=${JSON.stringify(ren.value)} 期望=${JSON.stringify(fileRowNow.rel.split('/').pop())}`)
    ok(rowGone === true && ren.fixedAncestors.length === 0,
      'Q10 ★★ 该条目行**被内联行替换**（旧实现是行留在原地、另弹居中窗）',
      `原行消失=${rowGone} fixed祖先=${JSON.stringify(ren.fixedAncestors)} placeholder=${JSON.stringify(ren.placeholder)}`)
    await shot('b14-q9-inline-rename')

    await realKey('Escape', 'Escape', 27)
    await sleep(600)
    const rowsAfterRenameEsc = await evalJs(JS_ROWS)
    // base2 = 展开目标目录**之后**的条目数（展开会引入新行，不能拿展开前的 baseline 比）
    ok(!rowsAfterRenameEsc.some(r => r.rel === '__b14_new_name__') && rowsAfterRenameEsc.length === base2.length,
      'Q11 ★ Esc 取消重命名：名字未变、条目数不变（零写盘）',
      `rows=${rowsAfterRenameEsc.length}/${base2.length} 仍含原名=${rowsAfterRenameEsc.some(r => r.rel === fileRowNow.rel)}`)
  } else {
    ok(false, 'Q9/Q10/Q11 重命名三连', '展开两层后仍无文件行 → 无法验证（教学区产物根内容不符）')
  }

  // ---------- Q12 负向：旧居中弹窗（z-[90]）全程未复活 ----------
  await evalJs(`(() => { try { window.__b14obs.disconnect() } catch {} ; return true })()`)
  const modalHits = await evalJs(`window.__b14 ? window.__b14.modal : -1`)
  ok(modalHits === 0,
    'Q12 ★★ 负向：全程零「fixed inset-0 居中弹窗」出现（旧 z-[90] 通道未复活）',
    `hits=${modalHits}`)

  const realErrors = consoleErrors.filter((e) => !/favicon|Autofill|DevTools|ResizeObserver/i.test(e))
  ok(realErrors.length === 0, 'Q13 console 零 error', realErrors.slice(0, 3).join(' | ') || 'clean')

  const fail = results.filter((r) => !r.pass)
  console.log('\n===== B-14 结果 =====')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n通过 ${results.length - fail.length}/${results.length}`)
  process.exit(fail.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
