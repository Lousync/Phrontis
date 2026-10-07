/**
 * B-8 探针：AI 教学区「AI 助手快捷键全禁 + 进区自动收起浮层」（2026-09-22 拍板）
 *
 * 拍板口径（三条）：
 *   ① 禁用范围**只** AI 教学（aiTeaching）—— 其它整窗模块（设置/插件市场/回收站/动态/工具箱）Ctrl+J、
 *      Ctrl+Shift+J 一律照旧；
 *   ② 「完全无反应」—— 不把 Ctrl+J 改派成别的东西，不 preventDefault；
 *   ③ 只禁快捷键不够：进 AI 教学区时**自动收掉**已开着的悬浮助手（fixed z-40、切 Tab 不自收）。
 *
 * 断言（真实 DOM + 真 keydown，build 产物 + CDP）：
 *   P1 设置页（整窗非禁用模块）Ctrl+J 唤出悬浮助手 #assistant-panel-root
 *   P2 设置页 Ctrl+Shift+J 进全屏学堂（面板 width 变 calc(100% - Npx)）——第二分支未被误伤
 *   P3 ★ 从「浮层全屏开着」点活动栏「AI 教学」→ 浮层自动收起（P3 是本次拍板③的直接证据）
 *   P4 ★ AI 教学区内 Ctrl+J 零响应（MutationObserver 计次 = 0，不是「闪一下又收」）
 *   P5 ★ AI 教学区内 Ctrl+Shift+J 零响应（全屏学堂也不得起）
 *   P6 工作台 Ctrl+J 仍路由到右栏 AI 侧栏（先归一到收起态，再验开 / 再验关）——工作台链路未被误伤
 *   P7/P8 回到设置页，两条快捷键仍可用（幂等复核：禁用跟着模块走，不是一次性关闭）
 *   P9 console 零 error
 *
 * 用法（必须先 electron-vite build）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b8-ai-shortcuts.mjs --no-sandbox --disable-gpu
 * 前置（可选）：seed-probe-vault.mjs —— 未开仓库也能跑（本探针只碰活动栏与整窗模块）。
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

/** 派一次真 keydown（AssistantPanel / App 都监听 window） */
const key = (k, opts) => evalJs(`(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ${opts} bubbles: true, cancelable: true }))
  return true
})()`)

/** 点活动栏按钮（title= 是 ActivityBar 唯一的可见锚点） */
const clickRail = (label) => evalJs(`(() => {
  const btn = [...document.querySelectorAll('button[title]')].find(b => b.title === ${JSON.stringify(label)})
  if (!btn) return false
  btn.click()
  return true
})()`)

const PANEL = `document.querySelector('#assistant-panel-root')`

/** 浮层状态：存在性 + 全屏态（full 时 width 走 calc）+ 工作台右栏指标 */
const JS_STATE = `(() => {
  const p = ${PANEL}
  return {
    panel: !!p,
    width: p ? (p.style.width || '') : '',
    // 供交叉核对：工作台右栏 AI 侧栏（ChatBody variant="page"）在场与否
    pageChat: !!document.querySelector('[data-assistant-variant="page"]'),
  }
})()`

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
    const st = await evalJs(`(() => ({ n: document.querySelector('#root')?.children.length ?? 0 }))()`)
    if (st.n > 0) break
    await sleep(500)
  }

  // 仓库选择浮层会吞掉所有点击 → 先在场地先跳过（绝不点「打开」＝原生对话框，会卡死探针）
  const pickerAct = await evalJs(`(() => {
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
    return 'picker-no-action'
  })()`)
  if (pickerAct !== 'no-picker') console.log('[前置] 仓库选择浮层:', pickerAct)
  await sleep(1200)

  // ---------- P1/P2 基准：设置页（整窗非禁用模块）两条快捷键都该照旧 ----------
  const toSettings = await clickRail('设置')
  ok(toSettings, 'P0 活动栏「设置」可点（探针导航前置）', `clicked=${toSettings}`)
  await sleep(1200)
  // 只读确认活动栏在（不写设置：探针不该改用户的 dev 设置；false 时后续 clickRail 会明确 FAIL）
  const railOk = await evalJs(`(() => ({ bar: !!document.querySelector('button[title="工作台"]'), iconStyle: null }))()`)
  if (!railOk.bar) console.log('[警告] 活动栏不可见 —— 后续导航会失败（settings.activityBarVisible=false？）')
  const beforeP1 = await evalJs(`(() => ({ panel: !!${PANEL} }))()`)
  await key('j', 'ctrlKey: true,')
  await sleep(500)
  const p1 = await evalJs(JS_STATE)
  ok(!beforeP1.panel && p1.panel,
    'P1 设置页（整窗非禁用）Ctrl+J 唤出悬浮助手 —— 禁用范围没扩散到别的模块',
    `before=${beforeP1.panel} after=${p1.panel}`)
  await shot('b8-p1-settings-ctrlj')

  await key('j', 'ctrlKey: true, shiftKey: true,')
  await sleep(700)
  const p2 = await evalJs(JS_STATE)
  ok(p2.panel && /calc\(100%/.test(p2.width),
    'P2 设置页 Ctrl+Shift+J 进全屏学堂（第二分支未被误伤）',
    `panel=${p2.panel} width=${p2.width}`)

  // ---------- P3 ★ 自动收起：浮层正全屏开着 → 点「AI 教学」 ----------
  const toAi = await clickRail('AI 教学')
  ok(toAi, 'P3a 活动栏「AI 教学」可点', `clicked=${toAi}`)
  await sleep(1100) // 收起走 closeAll → onTransitionEnd 卸载 DOM，给足动画时间
  const p3 = await evalJs(JS_STATE)
  ok(!p3.panel,
    'P3 ★ 进入 AI 教学区自动收起悬浮助手（拍板③：只禁快捷键不够）',
    `panel=${p3.panel} width=${p3.width}`)
  await shot('b8-p3-ai-teaching-autoclosed')

  // ---------- P4/P5 ★ 区内两条快捷键零响应 ----------
  // 用 MutationObserver 计次而非事后查 DOM：闪一下又收会漏判成 PASS
  await evalJs(`(() => {
    window.__b8 = { hits: 0, at: [] }
    window.__b8obs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue
        if (n.id === 'assistant-panel-root' || (n.querySelector && n.querySelector('#assistant-panel-root'))) {
          window.__b8.hits++; window.__b8.at.push(Date.now())
        }
      }
    })
    window.__b8obs.observe(document.body, { childList: true, subtree: true })
    return true
  })()`)

  await key('j', 'ctrlKey: true,')
  await sleep(800)
  const p4state = await evalJs(JS_STATE)
  const p4hits = await evalJs(`window.__b8.hits`)
  ok(!p4state.panel && p4hits === 0,
    'P4 ★ AI 教学区内 Ctrl+J 完全无反应（未 preventDefault、未改派、也未闪一下）',
    `panel=${p4state.panel} hits=${p4hits}`)

  await key('j', 'ctrlKey: true, shiftKey: true,')
  await sleep(800)
  const p5state = await evalJs(JS_STATE)
  const p5hits = await evalJs(`window.__b8.hits`)
  ok(!p5state.panel && p5hits === 0,
    'P5 ★ AI 教学区内 Ctrl+Shift+J 完全无反应（全屏学堂也不得起）',
    `panel=${p5state.panel} hits=${p5hits}`)
  await evalJs(`(() => { try { window.__b8obs.disconnect() } catch {} ; return true })()`)

  // ---------- P6 工作台：Ctrl+J 仍路由到右栏 AI 侧栏 ----------
  const toWb = await clickRail('工作台')
  ok(toWb, 'P6a 活动栏「工作台」可点', `clicked=${toWb}`)
  await sleep(1400)
  const wbOf = async () => evalJs(`(async () => { try { return await window.api.getSetting('workbenchLayout') } catch { return null } })()`)
  const parseWb = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return null } }
  // 归一化起点：右栏可能**本来就开在 ai**（dev 设置的持久值），先按一次收到「关」，
  // 否则第一次 Ctrl+J 会命中「开→关」分支 —— 那是开关语义正确、却是探针基线错（首跑实测踩到）
  const wbRaw0 = await wbOf() // 收尾复原用（探针不改用户的 dev 设置值）
  const wb0 = parseWb(wbRaw0)
  if (wb0 && wb0.rightTab === 'ai' && wb0.rightCollapsed === false) {
    await key('j', 'ctrlKey: true,')
    await sleep(900)
  }
  const wbBase = parseWb(await wbOf())
  ok(wbBase && wbBase.rightCollapsed === true,
    'P6 工作台基线归一：右栏 AI 收起态（Ctrl+J 的开/关两态都能测）',
    `base=${JSON.stringify(wbBase && { t: wbBase.rightTab, c: wbBase.rightCollapsed })}`)

  await key('j', 'ctrlKey: true,')
  await sleep(900)
  const wb1 = parseWb(await wbOf())
  ok(wb1 && wb1.rightTab === 'ai' && wb1.rightCollapsed === false,
    'P6b 工作台 Ctrl+J 仍唤出右栏 AI 侧栏（工作台链路未被误伤）',
    `after=${JSON.stringify(wb1 && { t: wb1.rightTab, c: wb1.rightCollapsed })}`)

  await key('j', 'ctrlKey: true,')
  await sleep(900)
  const wb2 = parseWb(await wbOf())
  ok(wb2 && wb2.rightCollapsed === true,
    'P6c 工作台 Ctrl+J 再按 → 收起右栏（开关语义保持）',
    `collapsed=${wb2 && wb2.rightCollapsed}`)
  await evalJs(`(() => { window.__b8 = null; return true })()`)

  // 复原工作台布局（P6 把右栏开了又关，与用户原值可能不同）
  if (typeof wbRaw0 === 'string') {
    await evalJs(`(async () => {
      try { await window.api.setSetting('workbenchLayout', ${JSON.stringify(wbRaw0)}) } catch {}
      window.dispatchEvent(new Event('settings-imported'))
      return true
    })()`)
    await sleep(600)
    const wbBack = await evalJs(`(async () => { try { return await window.api.getSetting('workbenchLayout') } catch { return null } })()`)
    ok(wbBack === wbRaw0, 'P6d 收尾复原 workbenchLayout（不给用户 dev 环境留副作用）', `restored=${wbBack === wbRaw0}`)
  }

  // ---------- P7/P8 幂等复核：回设置页，两条快捷键仍可用 ----------
  await clickRail('设置')
  await sleep(1200)
  await key('j', 'ctrlKey: true,')
  await sleep(600)
  const p7 = await evalJs(JS_STATE)
  ok(p7.panel, 'P7 ★ 回设置页 Ctrl+J 仍唤出浮层（禁用跟着模块走，不是一次性关闭）', `panel=${p7.panel}`)
  await key('j', 'ctrlKey: true, shiftKey: true,')
  await sleep(700)
  const p8 = await evalJs(JS_STATE)
  ok(p8.panel && /calc\(100%/.test(p8.width),
    'P8 ★ 回设置页 Ctrl+Shift+J 仍进全屏学堂', `panel=${p8.panel} width=${p8.width}`)
  await shot('b8-p8-settings-refull')

  // ---------- P9 console 零 error ----------
  const realErrors = consoleErrors.filter((e) => !/favicon|Autofill|DevTools/i.test(e))
  ok(realErrors.length === 0, 'P9 console 零 error', realErrors.slice(0, 3).join(' | ') || 'clean')

  // ---------- 汇总 ----------
  const fail = results.filter((r) => !r.pass)
  console.log('\n===== B-8 结果 =====')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n通过 ${results.length - fail.length}/${results.length}`)
  process.exit(fail.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
