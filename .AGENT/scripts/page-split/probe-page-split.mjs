/**
 * 页面级分屏实机验收探针（Step B）。
 *
 * 与仓库既有探针（probe-pagebar.mjs 等）同一套 CDP 手法，两点差异：
 *   ① **宿主内联**（runSelf）：沙箱禁止 pipe stdio（child_process 默认 stdio:'pipe' 报 EPERM），
 *      故不用 run-probe*.mjs，本文件自行 spawn electron（stdio:'ignore'）并常驻父进程；
 *   ② **结果落盘**：不依赖 stdout 回传（父进程日志在沙箱里读不到），断言结果写
 *      `tmp/probe-shots/page-split-report.json`，由调用方读文件取证。
 *
 * 隔离：app 目录 = tmp/probe-app（真实目录 + out/node_modules/build 三个 junction），
 * userData = `knowbase (dev probe-app)` —— 与用户自己的 dev 窗口（knowbase (dev KnowledgeRecorder)）
 * 互不抢单实例锁。前置：`node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"`。
 *
 * 用法：
 *   node .AGENT/scripts/page-split/probe-page-split.mjs            # 全程（含重启恢复段）
 *   RESTART_ONLY=1 node .AGENT/scripts/page-split/probe-page-split.mjs   # 只跑重启恢复段
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..', '..')
// ★ 报告与截图落**仓库根**（临时件，跑完可删）：本机沙箱在 workspace-write 下对 `tmp/` 既不能
//   新建也不能覆盖（`tmp/probe-shots` 写被拒），而仓库根可写。这不是产品行为，只是取证落点。
let ART_DIR = ROOT
try {
  writeFileSync(join(ROOT, '.probe-write-check'), 'x', 'utf8')
  unlinkSync(join(ROOT, '.probe-write-check'))
} catch {
  ART_DIR = process.env.TEMP || ROOT
  console.warn(`[宿主] 仓库根不可写，报告改落 ${ART_DIR}`)
}
if (RESTART_ONLY) { try { unlinkSync(RESTART_MARKER) } catch { /* 已删 */ } }
const APP_DIR = join(ROOT, 'tmp', 'probe-app')
const RESTART_MARKER = join(ART_DIR, '.probe-restart')
const RESTART_ONLY = process.env.RESTART_ONLY === '1' || existsSync(RESTART_MARKER)
const PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9333)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ============================== 宿主 ============================== */
function ensureAppDir() {
  mkdirSync(APP_DIR, { recursive: true })
  for (const sub of ['out', 'node_modules', 'build']) {
    const link = join(APP_DIR, sub)
    if (!existsSync(link)) symlinkSync(join(ROOT, sub), link, 'junction')
  }
  const pkg = join(APP_DIR, 'package.json')
  if (!existsSync(pkg)) {
    try { copyFileSync(join(ROOT, 'package.json'), pkg) } catch (e) { console.error('[宿主] 复制 package.json 失败:', e.message) }
  }
}

function launchElectron() {
  ensureAppDir()
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!existsSync(exe)) { console.error('[宿主] electron.exe 不存在:', exe); process.exit(2) }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    cwd: APP_DIR,
    env,
    stdio: 'ignore', // pipe 在沙箱里 EPERM；输出不需要，证据一律走 CDP + 落盘
  })
  procRef = proc
  return proc
}
let procRef = null

/** 收尾一个实例并**等锁真的释放**（单实例锁未释放时新实例会秒退，表象是重启段假红） */
async function killElectron(proc, maxMs = 20000) {
  try { proc?.kill() } catch { /* 尽力 */ }
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (proc?.exitCode !== null || proc?.killed) break
    const alive = await new Promise((res) => {
      try { proc.once('exit', () => res(false)) } catch { res(false) }
      setTimeout(() => res(true), 500)
    })
    if (!alive) break
  }
  await sleep(1200)
}

async function waitDebugPort(timeoutMs = 60000) {
  const t0 = Date.now()
  let childExited = false
  let childExitCode = null
  if (procRef) procRef.once('exit', (code) => { childExited = true; childExitCode = code })
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
      const targets = await r.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* 未起 */ }
    if (childExited) {
      throw new Error(
        `electron 子进程已退出（code=${childExitCode}），CDP 端口 ${PORT} 未就绪。\n` +
        '最常见原因：DSH 文件沙箱拦住了 electron 对 `%APPDATA%\\knowbase (dev probe-app)` 的写权限 ——\n' +
        '  表象 = process_singleton_win.cc Lock file can not be created! Error code: 5\n' +
        '处置：让探针在**未受限的终端**里跑（你自己的 PowerShell / Git Bash 即可），或对该命令放行沙箱。',
      )
    }
    await sleep(500)
  }
  throw new Error(`CDP page target 未出现（${timeoutMs}ms 超时，端口 ${PORT}）`)
}

/* ============================== CDP 客户端 ============================== */
export async function connect() {
  const page = await waitDebugPort()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let msgId = 0
  const pending = new Map()
  const consoleErrors = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 220))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + String(m.params?.exceptionDetails?.exception?.value ?? m.params?.exceptionDetails?.text ?? '').slice(0, 220))
    }
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result?.value
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('DOM.enable')
  const shot = async (name) => {
    try {
      mkdirSync(ART_DIR, { recursive: true })
      const r = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(ART_DIR, name + '.png'), Buffer.from(r.data, 'base64'))
      return name + '.png'
    } catch (e) { return 'shot-fail: ' + String(e.message).slice(0, 100) }
  }
  const mouse = (type, x, y, button = 'left') => send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button,
    buttons: type === 'mouseReleased' ? 0 : (button === 'right' ? 2 : 1),
    clickCount: 1,
  })
  const click = async (x, y) => {
    await mouse('mouseMoved', x, y, 'none')
    await mouse('mousePressed', x, y)
    await mouse('mouseReleased', x, y)
    await sleep(180)
  }
  const rightClick = async (x, y) => {
    await mouse('mouseMoved', x, y, 'none')
    await mouse('mousePressed', x, y, 'right')
    await mouse('mouseReleased', x, y, 'right')
    await sleep(320)
  }
  const key = async (keyName, code, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
    await sleep(120)
  }
  return { send, evalJs, shot, mouse, click, rightClick, key, consoleErrors, page }
}

/* ============================== 小工具 ============================== */
export function makeRecorder() {
  const results = []
  const ok = (cond, label, detail = '') => { results.push({ pass: !!cond, label, detail: String(detail) }); return !!cond }
  const info = (label, detail = '') => { results.push({ pass: null, label, detail: String(detail) }) }
  return { results, ok, info }
}

export function saveReport(name, payload) {
  mkdirSync(ART_DIR, { recursive: true })
  const p = join(ART_DIR, name)
  writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8')
  return p
}

export function finish(proc, code = 0) {
  try { proc?.kill() } catch { /* 尽力 */ }
  setTimeout(() => {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(proc?.pid ?? 0)], { stdio: 'ignore' }) } catch { /* 尽力 */ }
    process.exit(code)
  }, 250)
}

/* ============================== 前置 ============================== */
/** 仓库选择浮层（覆盖在工作台之上，会吞掉真实指针事件）：只点「跳过」，绝不点原生目录对话框 */
export async function dismissPicker(cdp) {
  const script = `(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const pick = (label) => {
      const cands = [...document.querySelectorAll('button,a,div,span')].filter((el) => (el.textContent || '').trim() === label)
      const t = cands.find((el) => el.tagName === 'BUTTON') || cands[cands.length - 1]
      if (!t) return false
      t.click(); return true
    }
    if (pick('跳过，直接进入上次使用的仓库')) return 'skip'
    if (pick('探针测试仓库')) return 'fixture-row'
    return 'picker-no-action'
  })()`
  const act = await cdp.evalJs(script)
  if (act !== 'no-picker') { await sleep(1500); await cdp.evalJs(script) }
  return act
}

export async function waitShell(cdp, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const okShell = await cdp.evalJs(`!!document.querySelector('[data-wb="pagebar"]') || !!document.querySelector('[data-wb="shell"]')`)
    if (okShell) return true
    await sleep(500)
  }
  return false
}

/** 清工作台布局（左栏锁定/收起/树模式等历史态会干扰前置） */
export async function resetWorkbenchLayout(cdp) {
  await cdp.evalJs(`(async () => { try { await window.api.setSetting('workbenchLayout', '') } catch {} ; window.dispatchEvent(new Event('settings-imported')); return true })()`)
  await sleep(1200)
}

/* ============================== 入口 ============================== */
const proc = launchElectron()
const cdp = await connect()
cdp.evalJs(`(() => { window.__probeErrors = []; const oe = console.error.bind(console); console.error = (...a) => { try { window.__probeErrors.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' ').slice(0, 400)) } catch {} ; oe(...a) }; window.addEventListener('error', e => window.__probeErrors.push('window.error: ' + (e.message || ''))); return true })()`)

const { results, ok, info } = makeRecorder()
const report = { startedAt: new Date().toISOString(), restartOnly: RESTART_ONLY, results, consoleErrors: cdp.consoleErrors, shots: [] }
const shot = async (n) => { const s = await cdp.shot(n); report.shots.push(s); return s }

try {
  const pickerAct = await dismissPicker(cdp)
  const shell = await waitShell(cdp)
  ok(shell, 'P0a 工作台外壳就绪', 'picker=' + pickerAct)
  if (!RESTART_ONLY) await resetWorkbenchLayout(cdp)
  await sleep(1500)

  if (RESTART_ONLY) {
    /* ================= 重启恢复段（进程是刚起的） ================= */
    info('R 段：本次为新起的进程，检查分屏是否从设置恢复')
    await cdp.evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
    await sleep(2500)
    const restored = await cdp.evalJs(`(() => {
      const div = document.querySelector('.kb-pane-divider')
      return {
        split: !!div,
        orientation: div ? (div.classList.contains('is-col') ? 'column' : 'row') : null,
        secondarySlot: !!document.querySelector('[data-pb-slot="secondary"]'),
        secondaryPageEl: !!document.querySelector('[data-pane="g2"]'),
        secondaryTabs: [...document.querySelectorAll('[data-pb-slot="secondary"] [data-pb-item]')].map(e => (e.textContent||'').trim().slice(0,30)),
        rawLayout: (() => { try { return localStorage.getItem('kb.wbLayout.raw') } catch { return null } })(),
      }
    })()`)
    info('R 恢复态 DOM', JSON.stringify(restored))
    ok(restored.split, 'R1 重启后分屏自动恢复（.kb-pane-divider 在场）', JSON.stringify(restored))
    ok(restored.secondarySlot, 'R2 重启后副栏页签槽位在场')
    ok(restored.secondaryPageEl, 'R3 重启后副栏内容槽在场')
    await shot('page-split-restart')
    const settings = await cdp.evalJs(`(async () => { try { return await window.api.getSetting('workbenchLayout') } catch (e) { return 'ERR:' + e.message } })()`)
    info('R 持久化的 workbenchLayout', String(settings).slice(0, 600))
    ok(!!settings && String(settings).includes('pageSplit'), 'R4 设置里真的写入了 pageSplit（持久化不是内存态）')
  } else {
    /* ================= 主段 ================= */
    // ---- 1. 进笔记 + 打开三个页面 ----
    await cdp.evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
    await sleep(2500)
    const pages = await cdp.evalJs(`(async () => {
      try {
        const r = await window.api.getKnowledgePages()
        const arr = Array.isArray(r) ? r : (r?.pages ?? [])
        return arr.filter(p => p && p.path && /\.md$/i.test(p.path)).slice(0, 3).map(p => ({ id: p.id, title: p.title, path: p.path }))
      } catch (e) { return { error: String(e && e.message) } }
    })()`)
    info('前置：fixture 里可打开的 md 页面', JSON.stringify(pages))
    const list = Array.isArray(pages) ? pages : []
    if (list.length < 3) {
      ok(false, 'P0b fixture 里至少有 3 个 md 知识页（分屏需要 2 个以上）', JSON.stringify(pages))
    } else {
      for (const p of list) {
        await cdp.evalJs(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: ${JSON.stringify(p.path)}, from: 'knowledge' } }))`)
        await sleep(2200)
      }
      const tabs = await cdp.evalJs(`(() => [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].map(e => ({ id: e.dataset.tabId, label: (e.textContent||'').trim().slice(0,24), active: e.dataset.wbActive })))()`)
      info('前置：主栏页面页签', JSON.stringify(tabs))
      const tabList = Array.isArray(tabs) ? tabs : []
      ok(tabList.length >= 3, 'P1 主栏已开 ≥3 个页面页签（分屏前置）', `count=${tabList.length}`)
      await shot('split-01-three-tabs')

      // ---- 2. 右键第一个页签 → 拆分菜单 ----
      const tabRect = await cdp.evalJs(`(() => { const e = document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')[0]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`)
      if (tabRect) await cdp.rightClick(tabRect.x, tabRect.y)
      const menu = await cdp.evalJs(`(() => {
        const btns = [...document.querySelectorAll('button')]
        const find = (t) => btns.find(b => (b.textContent||'').trim() === t)
        const r = (t) => { const b = find(t); if (!b) return null; const rr = b.getBoundingClientRect(); return { disabled: b.disabled, x: rr.left + rr.width/2, y: rr.top + rr.height/2 } }
        return { hasRow: !!find('向右拆分'), hasCol: !!find('向下拆分'), row: r('向右拆分'), col: r('向下拆分') }
      })()`)
      info('前置：页签右键菜单', JSON.stringify(menu))
      ok(menu.hasRow && menu.hasCol, 'P2 页签右键菜单含「向右拆分 / 向下拆分」')
      ok(menu.row && !menu.row.disabled, 'P3 单栏时「向右拆分」可用（未置灰）')
      if (menu.row && !menu.row.disabled) {
        await cdp.click(menu.row.x, menu.row.y)
        await sleep(2200)
      }
      const splitState = await cdp.evalJs(`(() => {
        const div = document.querySelector('.kb-pane-divider')
        const sec = document.querySelector('[data-pb-slot="secondary"]')
        const secContent = document.querySelector('[data-pane="g2"]')
        const main = document.querySelector('[data-pane="main"]')
        return {
          divider: !!div,
          isCol: div ? div.classList.contains('is-col') : null,
          secSlot: !!sec,
          secContent: !!secContent,
          secTabs: sec ? [...sec.querySelectorAll('[data-pb-item]')].map(e => ({ id: e.dataset.tabId, label: (e.textContent||'').trim().slice(0,24), active: e.dataset.wbActive })) : null,
          mainTabs: [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].filter(e => !e.closest('[data-pb-slot="secondary"]')).map(e => ({ id: e.dataset.tabId, label: (e.textContent||'').trim().slice(0,24) })),
          monaco: document.querySelectorAll('.monaco-editor').length,
          secMonaco: secContent ? secContent.querySelectorAll('.monaco-editor').length : 0,
          secText: secContent ? (secContent.textContent || '').trim().slice(0, 120) : '',
          mainPaneRect: main ? (() => { const r = main.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width) } })() : null,
          secRect: secContent ? (() => { const r = secContent.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width) } })() : null,
        }
      })()`)
      info('拆分为 row 后 DOM', JSON.stringify(splitState))
      ok(splitState.divider, 'P4 拆分后分隔条 .kb-pane-divider 渲染')
      ok(splitState.isCol === false, 'P5 「向右拆分」= row 方向（分隔条不带 is-col）')
      ok(splitState.secSlot, 'P6 副栏页签槽 [data-pb-slot="secondary"] 在场')
      ok(splitState.secContent, 'P7 副栏内容槽 [data-pane="g2"] 在场')
      ok(splitState.secTabs && splitState.secTabs.length === 1, 'P8 副栏页签条恰有 1 个页签（拆过去的那页）', JSON.stringify(splitState.secTabs))
      ok(splitState.mainTabs.length === 2, 'P9 主栏页签条已排除副栏页签（3 → 2）', `count=${splitState.mainTabs.length}`)
      ok(splitState.secMonaco >= 1, 'P10 副栏渲染出真实编辑器实例（Monaco 在场）', `secMonaco=${splitState.secMonaco}, total=${splitState.monaco}`)
      ok(splitState.secText.length > 0, 'P11 副栏内容非空（渲染了页面正文/骨架）', splitState.secText)
      ok(splitState.mainPaneRect && splitState.secRect && splitState.secRect.x > splitState.mainPaneRect.x, 'P12 副栏在主栏右侧（row 布局几何正确）', JSON.stringify({ main: splitState.mainPaneRect, sec: splitState.secRect }))
      await shot('split-02-row-split')

      // ---- 3. 再拆应置灰 ----
      const tabRect2 = await cdp.evalJs(`(() => { const e = [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].find(x => !x.closest('[data-pb-slot="secondary"]')); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`)
      if (tabRect2) await cdp.rightClick(tabRect2.x, tabRect2.y)
      const menu2 = await cdp.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '向右拆分'); return b ? { found: true, disabled: b.disabled } : { found: false } })()`)
      ok(menu2.found && menu2.disabled === true, 'P13 已在分屏时拆分项置灰（splitDisabled）', JSON.stringify(menu2))
      await cdp.key('Escape', 'Escape', 27)
      await sleep(300)

      // ---- 4. 副栏顶栏（NoteTopBar）与工具栏槽 ----
      const topbar = await cdp.evalJs(`(() => {
        const bars = [...document.querySelectorAll('[data-wb="noteTopBar"]')]
        const slot = document.getElementById('editor-toolbar-slot')
        const secContent = document.querySelector('[data-pane="g2"]')
        return {
          barCount: bars.length,
          inSecondary: secContent ? secContent.querySelectorAll('[data-wb="noteTopBar"]').length : 0,
          backBtns: bars.map(b => !!b.querySelector('[data-wb="noteTopBack"]')),
          slotChildren: slot ? slot.children.length : -1,
          slotInSecondary: !!(secContent && secContent.querySelector('#editor-toolbar-slot')),
          monacoCount: document.querySelectorAll('.monaco-editor').length,
        }
      })()`)
      info('前置：副栏/主栏顶栏与工具栏槽', JSON.stringify(topbar))
      ok(topbar.inSecondary >= 1, 'P14 副栏渲染了自己的笔记顶栏 NoteTopBar', JSON.stringify(topbar))
      ok(topbar.slotInSecondary === false, 'P15 副栏没有工具栏槽（isActive=false 生效，未抢主栏单例槽）')
      ok(topbar.barCount === 2, 'P16 两栏各一套顶栏（共 2 个 noteTopBar）', `count=${topbar.barCount}`)
      await shot('split-03-two-topbars')

      // ---- 5. Esc 归属（分屏 × NoteTopBar 干扰面）----
      const before = await cdp.evalJs(`(() => {
        const sec = document.querySelector('[data-pane="g2"]')
        return {
          mainActive: [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].filter(e => !e.closest('[data-pb-slot="secondary"]')).find(e => e.dataset.wbActive === '1')?.dataset.tabId ?? null,
          secActive: sec ? [...document.querySelectorAll('[data-pb-slot="secondary"] [data-pb-item]')].find(e => e.dataset.wbActive === '1')?.dataset.tabId ?? null : null,
          mainTabCount: [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].filter(e => !e.closest('[data-pb-slot="secondary"]')).length,
        }
      })()`)
      // 把焦点放到副栏里（如果有 Monaco），再按 Esc
      const secFocus = await cdp.evalJs(`(() => { const s = document.querySelector('[data-pane="g2"] textarea, [data-pane="g2"] .monaco-editor'); if (s) { s.focus?.(); return true } return false })()`)
      info('Esc 前置', JSON.stringify({ before, secFocus }))
      await cdp.key('Escape', 'Escape', 27)
      await sleep(1500)
      const after = await cdp.evalJs(`(() => {
        const sec = document.querySelector('[data-pane="g2"]')
        return {
          mainActive: [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].filter(e => !e.closest('[data-pb-slot="secondary"]')).find(e => e.dataset.wbActive === '1')?.dataset.tabId ?? null,
          secActive: sec ? [...document.querySelectorAll('[data-pb-slot="secondary"] [data-pb-item]')].find(e => e.dataset.wbActive === '1')?.dataset.tabId ?? null : null,
          divider: !!document.querySelector('.kb-pane-divider'),
          mainTabCount: [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].filter(e => !e.closest('[data-pb-slot="secondary"]')).length,
        }
      })()`)
      info('Esc 后状态', JSON.stringify(after))
      // 取证型断言：Esc 的归属（主栏换页 / 副栏不动），不管结论是什么都记录
      ok(after.secActive === before.secActive, 'P17 Esc 不改变副栏当前页（副栏未被 Esc 关闭）', JSON.stringify({ before: before.secActive, after: after.secActive }))
      info('P18 【取证】Esc 是否作用于主栏当前页', JSON.stringify({ before: before.mainActive, after: after.mainActive, changed: before.mainActive !== after.mainActive }))

      // ---- 6. 跨栏拖：副栏页签拖回主栏 → 自动合并 ----
      const dragPoints = await cdp.evalJs(`(() => {
        const s = document.querySelector('[data-pb-slot="secondary"] [data-pb-item]')
        const m = [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].find(e => !e.closest('[data-pb-slot="secondary"]'))
        if (!s || !m) return null
        const a = s.getBoundingClientRect(), b = m.getBoundingClientRect()
        return { from: { x: a.left + a.width/2, y: a.top + a.height/2 }, to: { x: b.left + b.width/2, y: b.top + b.height/2 }, dragId: s.dataset.tabId ?? null }
      })()`)
      info('跨栏拖前置', JSON.stringify(dragPoints))
      if (dragPoints) {
        await cdp.evalJs(`(() => {
          window.__drag = { dt: new DataTransfer(), el: document.querySelector('[data-pb-slot="secondary"] [data-pb-item]') }
          const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__drag.dt })
          window.__drag.el.dispatchEvent(ev)
          return true
        })()`)
        await sleep(300)
        await cdp.mouse('mouseMoved', dragPoints.to.x, dragPoints.to.y, 'none')
        await cdp.evalJs(`(() => {
          const t = [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].find(e => !e.closest('[data-pb-slot="secondary"]'))
          t?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__drag.dt }))
          return true
        })()`)
        await sleep(200)
        await cdp.evalJs(`(() => {
          const t = [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].find(e => !e.closest('[data-pb-slot="secondary"]'))
          t?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__drag.dt }))
          window.__drag.el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__drag.dt }))
          return true
        })()`)
        await sleep(2000)
      }
      const afterDragBack = await cdp.evalJs(`(() => ({
        divider: !!document.querySelector('.kb-pane-divider'),
        secContent: !!document.querySelector('[data-pane="g2"]'),
        tabCount: document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]').length,
        tabs: [...document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')].map(e => (e.textContent||'').trim().slice(0,24)),
      }))()`)
      info('拖回主栏后', JSON.stringify(afterDragBack))
      ok(!afterDragBack.divider && !afterDragBack.secContent, 'P19 副栏最后一个页面拖回主栏 → 自动合并回单栏', JSON.stringify(afterDragBack))
      await shot('split-04-auto-merged')

      // ---- 7. 向下拆分（column）+ 拖到空白处自动合并 ----
      const tabRect3 = await cdp.evalJs(`(() => { const e = document.querySelector('[data-wb="pagebar"] [data-tab-id]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`)
      if (tabRect3) await cdp.rightClick(tabRect3.x, tabRect3.y)
      const colMenu = await cdp.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '向下拆分'); if (!b) return null; const r = b.getBoundingClientRect(); return { disabled: b.disabled, x: r.left + r.width/2, y: r.top + r.height/2 } })()`)
      ok(!!colMenu && !colMenu.disabled, 'P20 「向下拆分」可用', JSON.stringify(colMenu))
      if (colMenu && !colMenu.disabled) { await cdp.click(colMenu.x, colMenu.y); await sleep(2000) }
      const colState = await cdp.evalJs(`(() => {
        const div = document.querySelector('.kb-pane-divider')
        const sec = document.querySelector('[data-pane="g2"]')
        const main = document.querySelector('[data-pane="main"]')
        const a = main?.getBoundingClientRect(), b = sec?.getBoundingClientRect()
        return { isCol: div ? div.classList.contains('is-col') : null, mainTop: a ? Math.round(a.top) : null, secTop: b ? Math.round(b.top) : null, secY: b ? Math.round(b.top) : null }
      })()`)
      info('向下拆分后几何', JSON.stringify(colState))
      ok(colState.isCol === true, 'P21 「向下拆分」= column 方向（分隔条带 is-col）')
      ok(colState.secTop !== null && colState.mainTop !== null && colState.secTop >= colState.mainTop, 'P22 副栏在主栏下方（column 布局几何正确）', JSON.stringify(colState))
      await shot('split-05-column-split')

      // 副栏页签拖到空白处 → 自动合并
      const blankDrop = await cdp.evalJs(`(() => {
        const s = document.querySelector('[data-pb-slot="secondary"] [data-pb-item]')
        if (!s) return null
        const a = s.getBoundingClientRect()
        return { x: a.left + a.width/2, y: a.top + a.height/2 }
      })()`)
      if (blankDrop) {
        await cdp.evalJs(`(() => {
          window.__drag2 = { dt: new DataTransfer(), el: document.querySelector('[data-pb-slot="secondary"] [data-pb-item]') }
          window.__drag2.el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__drag2.dt }))
          return true
        })()`)
        await sleep(300)
        // 落在主栏内容区（不是页签条）—— 无处理器的空白，应只调 dragend，不触发 move
        await cdp.mouse('mouseMoved', blankDrop.x, blankDrop.y + 200, 'none')
        await cdp.evalJs(`(() => { window.__drag2.el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__drag2.dt })); return true })()`)
        await sleep(1500)
      }
      const afterBlank = await cdp.evalJs(`(() => ({ divider: !!document.querySelector('.kb-pane-divider'), tabCount: document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]').length }))()`)
      info('拖到空白区后', JSON.stringify(afterBlank))
      ok(afterBlank.divider, 'P23 页面拖到无落点的空白区 → 不误合并（分屏仍在）', JSON.stringify(afterBlank))

      // ---- 8. 手动合并按钮 ----
      const mergeBtn = await cdp.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '合并回主栏'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`)
      ok(!!mergeBtn, 'P24 页面条右端有「合并回主栏」按钮')
      if (mergeBtn) { await cdp.click(mergeBtn.x, mergeBtn.y); await sleep(1800) }
      const merged = await cdp.evalJs(`(() => ({
        divider: !!document.querySelector('.kb-pane-divider'),
        secContent: !!document.querySelector('[data-pane="g2"]'),
        tabCount: document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]').length,
        monaco: document.querySelectorAll('.monaco-editor').length,
      }))()`)
      info('手动合并后', JSON.stringify(merged))
      ok(!merged.divider && !merged.secContent, 'P25 点「合并回主栏」→ 回单栏', JSON.stringify(merged))

      // ---- 9. 留一个分屏状态给重启段 ----
      const tabRect4 = await cdp.evalJs(`(() => { const e = document.querySelector('[data-wb="pagebar"] [data-tab-id]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`)
      if (tabRect4) await cdp.rightClick(tabRect4.x, tabRect4.y)
      const rowMenu2 = await cdp.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '向右拆分'); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`)
      if (rowMenu2) { await cdp.click(rowMenu2.x, rowMenu2.y); await sleep(2000) }
      const persisted = await cdp.evalJs(`(() => ({ divider: !!document.querySelector('.kb-pane-divider'), secTabs: document.querySelectorAll('[data-pb-slot="secondary"] [data-pb-item]').length }))()`)
      const settingRaw = await cdp.evalJs(`(async () => { try { return await window.api.getSetting('workbenchLayout') } catch (e) { return 'ERR:' + e.message } })()`)
      report.persistedSetting = String(settingRaw).slice(0, 800)
      info('落盘前分屏态', JSON.stringify(persisted))
      ok(persisted.divider, 'P26 重启段前置：当前处于分屏状态')
      ok(String(settingRaw).includes('pageSplit'), 'P27 workbenchLayout 设置里已写入 pageSplit（持久化）', String(settingRaw).slice(0, 300))
      await shot('split-06-before-restart')
    }
  }

  const probeErrors = await cdp.evalJs(`(() => (window.__probeErrors || []).slice(0, 12))()`).catch(() => [])
  report.probeErrors = probeErrors
  const passN = results.filter((r) => r.pass === true).length
  const failN = results.filter((r) => r.pass === false).length
  report.summary = { pass: passN, fail: failN, info: results.filter((r) => r.pass === null).length }
  info('console 错误', JSON.stringify((cdp.consoleErrors || []).slice(0, 8)))
  info('页面内错误', JSON.stringify((probeErrors || []).slice(0, 8)))

  if (!RESTART_ONLY && failN === 0 && !report.crash) {
    // ---- 自动重启段：杀实例 → 等锁释放 → 新实例 → 检查分屏是否恢复 ----
    await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    await shot('split-06-before-restart')
    const mainReportPath = saveReport('page-split-report.json', report)
    console.log(`[探针] 主段 PASS=${passN} FAIL=${failN} 报告=${mainReportPath}`)
    await killElectron(proc)
    writeFileSync(join(ART_DIR, '.probe-restart'), new Date().toISOString(), 'utf8')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, RESTART_ONLY: '1' }, stdio: 'inherit',
    })
    child.on('exit', (code) => process.exit(code ?? 0))
  } else {
    const p = saveReport(RESTART_ONLY ? 'page-split-report-restart.json' : 'page-split-report.json', report)
    console.log(`[探针] PASS=${passN} FAIL=${failN} 报告=${p}`)
    finish(proc, failN === 0 ? 0 : 1)
  }
} catch (e) {
  report.crash = String(e?.stack ?? e).slice(0, 2000)
  saveReport(RESTART_ONLY ? 'page-split-report-restart.json' : 'page-split-report.json', report)
  console.error('[探针] 崩溃:', report.crash)
  finish(proc, 2)
}
