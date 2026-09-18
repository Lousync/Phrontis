/**
 * 模块中栏「贯通行」（顶部冗余头部行）清除验证探针（v3.4.0「中间栏头部层级优化」）
 *
 * 背景：多个模块在中间主体顶部自带一条「贯通行」（图标 + 模块名 / 工具），
 * 与左栏标识、页面条重复。按「纯标题可直接删 / 带工具需讨论」分 A、B 两组逐步清理。
 *
 * 本探针验**已删项**：模块根的直接子元素里**不再有**那条 ~28px 贯通行，
 * 且内容区占满模块容器高（删行后不留空档）。逐项加进 CASES 即可复用。
 *
 * 断言（真实 DOM 几何，不做静态字符串判断）：
 *   G1 找到激活的模块容器
 *   G2 首个子元素不是 ~28px 贯通行（h > 40 或该行本身就是内容层）
 *   G3 容器内不存在「文本恰好等于模块名」的矮行（< 40px）
 *   G4 内容区占满模块容器高（无多余行占位，tol 2px）
 *   G5 console 零 error
 *
 * 用法（必须先 electron-vite build + 跑夹具）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-mod-header.mjs
 *
 * ⚠️ 跑之前先确认没有残留 electron.exe（单实例锁会把新实例静默顶掉，
 *    现象 = 只有「[宿主] electron pid=…」一行、无 DevTools listening → 探针报 CDP 未就绪）：
 *      taskkill /F /IM electron.exe /T
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join('E:/Projects/KnowledgeRecorder', 'tmp', 'probe-shots')

/** 逐项清理清单：id = 左栏书签 id；gone = 被删掉的那条贯通行的精确文本 */
const CASES = [
  { id: 'blog', gone: '博客', note: '原 blog/index.tsx:334 顶部贯通行「文件图标 + 博客」' },
  { id: 'knowledge', gone: '知识库', note: '页面条置顶轮已删（对照：此模块应已无贯通行）' },
]

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
  throw new Error('CDP page target 未出现（先查残留 electron.exe 抢锁，见文件头注释）')
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
    const p = join(SHOT_DIR, name + '.png')
    writeFileSync(p, Buffer.from(r.data, 'base64'))
    return p
  } catch (e) { return 'shot 失败: ' + String(e.message).slice(0, 120) }
}

const results = []
function ok(cond, label, detail = '') {
  results.push({ pass: !!cond, label, detail })
  return !!cond
}

/** 当前激活模块容器（可见的 .kb-view-fade 里第一个）的根节点几何 */
const JS_MODHEAD = `(() => {
  const holders = [...document.querySelectorAll('div.kb-view-fade')]
    .filter((h) => getComputedStyle(h).display !== 'none')
  const holder = holders[0]
  if (!holder) return { found: false }
  const modRoot = holder.firstElementChild
  if (!modRoot) return { found: false, noRoot: true }
  const hr = holder.getBoundingClientRect()
  const rows = [...modRoot.children].map((c) => {
    const r = c.getBoundingClientRect()
    return {
      text: (c.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 36),
      h: Math.round(r.height),
    }
  })
  const first = modRoot.firstElementChild
  const fr = first?.getBoundingClientRect()
  return {
    found: true,
    holderH: Math.round(hr.height),
    rowCount: rows.length,
    rows,
    firstText: (first?.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 36),
    firstH: fr ? Math.round(fr.height) : -1,
  }
})()`

const dismissPicker = `(() => {
  if (!(document.body.textContent || '').includes('选择要进入的仓库')) return 'no-picker'
  const pick = (label) => {
    const cands = [...document.querySelectorAll('button,a,div,span')]
      .filter((el) => (el.textContent || '').trim() === label)
    const target = cands.find((el) => el.tagName === 'BUTTON') || cands[cands.length - 1]
    if (!target) return false
    target.click(); return true
  }
  if (pick('跳过，直接进入上次使用的仓库')) return 'skip'
  if (pick('探针测试仓库')) return 'fixture-row'
  return 'picker-no-action'
})()`

async function main() {
  const page = await waitPage()
  console.log('page target:', page.url?.slice(0, 60))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
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
  await evalJs(dismissPicker)
  await sleep(1200)
  console.log('[前置] 仓库选择浮层已关闭:', await evalJs(`!document.body.textContent.includes('选择要进入的仓库')`))
  await evalJs(`window.api?.setSetting ? window.api.setSetting('workbenchLayout', '') : 'no-api'`)
  await sleep(800)

  for (const c of CASES) {
    console.log(`\n---- ${c.id}（${c.note}）----`)
    // 左栏在模块态时书签区是隐藏的 → 先返回总览再点书签（否则 miss 后会读到上一个模块的容器 → 假通过）
    await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
    await sleep(700)
    const opened = await evalJs(`(() => {
      const b = document.querySelector('[data-wb-bookmark="${c.id}"]')
      if (b) { b.click(); return 'bookmark' }
      return 'miss'
    })()`)
    console.log('  打开方式:', opened)
    await sleep(1600)
    const st = await evalJs(JS_MODHEAD)
    await shot(`modheader-${c.id}`)

    // 硬判据：必须确认切模块成功（左栏模块态 = 目标 id），否则后面读到的几何属于上一个模块
    const modNow = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
    ok(opened === 'bookmark' && modNow === c.id,
      `G0 [${c.id}] 切模块成功（左栏模块态 = ${c.id}）`, `opened=${opened} mod=${modNow}`)
    if (opened !== 'bookmark' || modNow !== c.id) {
      console.log('  ⚠️ 未切换成功，跳过本项几何断言（避免读到上一个模块的容器假通过）')
      continue
    }
    ok(st.found, `G1 [${c.id}] 找到激活的模块容器`)
    if (st.found) {
      console.log('  行数=' + st.rowCount, '首子元素「' + st.firstText + '」h=' + st.firstH)
      console.log('  rows:', JSON.stringify(st.rows.map((r) => ({ t: r.text.slice(0, 10), h: r.h }))))
      ok(st.firstH > 40 || st.firstH < 0,
        `G2 [${c.id}] 首个子元素不是 28px 贯通行`, `firstH=${st.firstH} text="${st.firstText}"`)
      const tall = st.rows.filter((r) => r.text === c.gone && r.h > 0 && r.h < 40)
      ok(tall.length === 0, `G3 [${c.id}] 无「${c.gone}」矮标题行残留`, JSON.stringify(tall))
      const maxRowH = Math.max(0, ...st.rows.map((r) => r.h))
      ok(maxRowH >= st.holderH - 2,
        `G4 [${c.id}] 内容区占满模块容器高`, `maxRow=${maxRowH} holder=${st.holderH}`)
    }
  }

  const errs = consoleErrors.filter((e) => !/Download the React DevTools|DevTools/.test(String(e)))
  ok(errs.length === 0, 'G5 console 零 error', errs.join(' | '))

  console.log('\n========================================')
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '  —— ' + r.detail : ''}`)
  console.log('========================================')
  const fails = results.filter((r) => !r.pass)
  if (fails.length === 0) console.log(`✅ 全部通过：${results.length} 项断言 PASS`)
  else console.log(`❌ ${fails.length}/${results.length} 项 FAIL`)
  ws.close()
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常:', e.message); process.exit(2) })
