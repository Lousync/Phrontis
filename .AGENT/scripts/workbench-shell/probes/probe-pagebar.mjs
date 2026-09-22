/**
 * 页面条置顶运行时探针（v3.4.0「活动页层级优化」第一项，2026-09-18）
 *
 * 断言（真实 DOM，build 产物 + CDP）：
 *   P1 中间栏第一行 = [data-wb="pagebar"]（旧 [data-wb="tabbar"] 已退役）
 *   P2 页面条紧邻的下一块内容在其正下方（行确实在内容之上，不是浮层/错位）
 *   P3 两个页签组槽同在条内（data-pb-slot=editor / knowledge）
 *   P4 条上暴露 data-pb-tabs（openTabs 全量，供模块级状态断言）
 *   P5 打开编辑区书签 → 编辑器模块激活，页面条位置/高度不变（切模块不跳变）
 *   P6 在左栏资源管理器点开 README.md → 编辑器页签组出现条目（owner=editor，带模块图标 + 文件名）
 *   P7 [data-tab-rel] 全部落在页面条内（模块内部不再有标签行）
 *   P8 切到知识库 → 页面条位置/高度仍不变，编辑器条目仍在（保活）
 *   P9 console 零 error
 *
 * 用法（必须先 electron-vite build）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-pagebar.mjs --no-sandbox --disable-gpu
 * 前置：先跑 seed-probe-vault.mjs 造 fixture 仓库（页面条要有文件可开）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 截图目录推导自脚本位置（勿写死盘符：在 worktree 里跑会把截图写进主仓）
const SHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../tmp/probe-shots')

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

/** 页面条观测：位置 / 高度 / 槽与条目 */
const JS_PAGEBAR = `(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const bar = q('[data-wb="pagebar"]')
  const r = bar?.getBoundingClientRect()
  const next = bar?.nextElementSibling
  const nr = next?.getBoundingClientRect()
  const items = qa('[data-pb-item]').map((el) => ({
    owner: el.dataset.pbOwner,
    label: (el.textContent || '').trim().slice(0, 40),
    inBar: !!el.closest('[data-wb="pagebar"]'),
    iconPaths: (el.querySelector('svg path')?.getAttribute('d') || '').slice(0, 24),
  }))
  // Phase 2 批次 2（编辑区退役）：页签属性两套并存——编辑器 data-tab-rel / 知识库 data-tab-id
  const tabRels = qa('[data-tab-rel],[data-tab-id]')
  return {
    shell: !!q('[data-wb="shell"]'),
    hasBar: !!bar,
    oldTabbar: !!q('[data-wb="tabbar"]'),
    barTop: r ? Math.round(r.top) : -1,
    barH: r ? Math.round(r.height) : -1,
    nextTop: nr ? Math.round(nr.top) : -1,
    slots: qa('[data-pb-slot]').map((s) => s.dataset.pbSlot),
    pbTabs: bar?.dataset.pbTabs ?? '',
    items,
    tabRelCount: tabRels.length,
    tabRelOutsideBar: tabRels.filter((el) => !el.closest('[data-wb="pagebar"]')).length,
    modTitle: q('[data-wb="mod"]')?.dataset.wbMod ?? '',
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
  let st = await evalJs(JS_PAGEBAR)
  // 仓库选择页（VaultPicker）是**覆盖在工作台之上的浮层**：此时 [data-wb="shell"] 已为 true，
  // 但所有点击都被浮层吞掉（探针会全线假失败）。所以先探测并在场时点「跳过，直接进入上次使用的仓库」。
  // 注意：绝不点「打开 / 打开本地仓库」——那是原生目录对话框，会卡死探针。
  const dismissPicker = `(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    // 只点**有处理器的元素**：同文本的祖先 div 也会命中 textContent 精确匹配，
    // 但祖先没有 onClick（document 顺序取第一个 = 点了个空壳）。优先 BUTTON，否则取最内层。
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
  })()`
  const pickerAct = await evalJs(dismissPicker)
  if (pickerAct !== 'no-picker') console.log('[前置] 仓库选择浮层:', pickerAct)
  for (let i = 0; i < 24; i++) {
    st = await evalJs(JS_PAGEBAR)
    if (st.shell && st.hasBar) break
    await sleep(500)
  }
  // 浮层若在等待期间才出现（懒挂载），再补一次
  const pickerAct2 = await evalJs(dismissPicker)
  if (pickerAct2 !== 'no-picker') { console.log('[前置] 仓库选择浮层(补):', pickerAct2); await sleep(1200) }
  // 浮层留在场 = 截图与指针交互都不可信（.click() 能绕过浮层，所以断言仍可能「假通过」）——必须确认关掉了
  const pickerGone = await evalJs(`!document.body.textContent.includes('选择要进入的仓库')`)
  console.log('[前置] 仓库选择浮层已关闭:', pickerGone)
  // 状态复位：清 workbenchLayout（左栏锁定/收起等历史态会干扰左栏模块态渲染）
  await evalJs(`window.api?.setSetting ? window.api.setSetting('workbenchLayout', '') : 'no-api'`)
  await sleep(800)
  st = await evalJs(JS_PAGEBAR)

  ok(st.hasBar, 'P1a 中间栏页面条渲染（[data-wb="pagebar"]）')
  ok(!st.oldTabbar, 'P1b 旧标签条 [data-wb="tabbar"] 已退役')
  // 2026-09-19 设计更新（Edge 页面条 + 空行隐藏）：无条目停靠 → 整行 display:none（h=0）；有条目 → 32~44px
  ok(st.barH === 0 || (st.barH >= 32 && st.barH <= 44),
    'P1c 页面条高度：无条目停靠=整行隐藏（h=0），有条目=32~44px', `h=${st.barH}`)
  ok(st.nextTop >= st.barTop + st.barH - 1, 'P2 页面条紧邻内容在其正下方（行确在内容之上）', `bar=${st.barTop}+${st.barH} next=${st.nextTop}`)
  ok(st.slots.includes('editor') && st.slots.includes('knowledge'), 'P3 两个页签组槽同在条内', JSON.stringify(st.slots))
  ok(typeof st.pbTabs === 'string', 'P4 条上暴露 data-pb-tabs（openTabs 可观测）', st.pbTabs)

  const shotOverview = await shot('pagebar-01-overview')

  // P5 进知识库模块（Phase 2 批次 2：编辑区退役，页面条锚点 = 知识库）：位置/高度不变
  await evalJs(dismissPicker)
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(1400)
  const st1 = await evalJs(JS_PAGEBAR)
  ok(st1.hasBar && st1.barH === st.barH && st1.barTop === st.barTop,
    'P5 切到知识库模块 → 页面条可见性/位置保持（无停靠时保持隐藏）', `before=${st.barTop}/${st.barH} after=${st1.barTop}/${st1.barH}`)
  ok(st1.modTitle === 'knowledge', 'P5b 左栏模块态 = 知识库', `mod=${st1.modTitle}`)

  // P6 打开 README.md：走 App 自己的 `kb-open-note` 事件通道（搜索面板同款）——
  // 批次 2 起该通道改道知识库（README.md 无 frontmatter id → draft 页签，PageEditor 内嵌 MonacoPane）
  const opened = await evalJs(`(() => {
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: 'README.md' } }))
    return 'sent'
  })()`)
  await sleep(2000)
  // 时序兜底：启动后 allPages 未就绪时事件可能落空（实测偶发）→ 最多补发 2 次
  let st2 = await evalJs(JS_PAGEBAR)
  for (let i = 0; i < 2 && !st2.items.some((x) => x.owner === 'knowledge' && /README/i.test(x.label)); i++) {
    await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: 'README.md' } }))`)
    await sleep(2200)
    st2 = await evalJs(JS_PAGEBAR)
  }
  const editorItems = st2.items.filter((i) => i.owner === 'knowledge')
  ok(opened === 'sent', 'P6a 经 kb-open-note 通道请求打开 README.md', String(opened))
  ok(editorItems.length >= 1 && editorItems.every((i) => i.inBar),
    'P6b 知识库页签进页面条（owner=knowledge，条目在条内）', JSON.stringify(st2.items))
  ok(editorItems.some((i) => /README/i.test(i.label)), 'P6c 条目标题 = 文件名', JSON.stringify(editorItems.map((i) => i.label)))
  ok(editorItems.every((i) => i.iconPaths.length > 0), 'P6d 条目带模块图标（svg path 非空）', JSON.stringify(editorItems.map((i) => i.iconPaths)))
  ok(st2.tabRelCount > 0 && st2.tabRelOutsideBar === 0,
    'P7 页签条目（data-tab-rel / data-tab-id）全部落在页面条内（模块内部不再有标签行）', `total=${st2.tabRelCount} outside=${st2.tabRelOutsideBar}`)

  const shotEditor = await shot('pagebar-02-editor-file-open')

  // P8 切博客：条不动、知识库页签保活（模块态下书签区隐藏 → 先返回总览再点书签）
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(600)
  await evalJs(`document.querySelector('[data-wb-bookmark="blog"]')?.click()`)
  await sleep(1600)
  const st3 = await evalJs(JS_PAGEBAR)
  // 2026-09-19：基准改为**最近可见态 st2**（此前对比的隐藏基线已无意义），±1px 为缩放/亚像素舍入容差
  ok(st3.hasBar && st3.barH === st2.barH && Math.abs(st3.barTop - st2.barTop) <= 1,
    'P8a 切到博客模块 → 页面条位置/高度与最近可见态一致（±1px）', `prev=${st2.barTop}/${st2.barH} now=${st3.barTop}/${st3.barH}`)
  ok(st3.items.filter((i) => i.owner === 'knowledge').length >= 1, 'P8b 知识库页签条目保活（切走不消失）', JSON.stringify(st3.items.map((i) => i.owner + ':' + i.label)))
  ok(st3.modTitle === 'blog', 'P8c 左栏模块态 = 博客', `mod=${st3.modTitle}`)

  const shotKnowledge = await shot('pagebar-03-knowledge')

  // P10 空态提示文字已删（2026-09-18 反馈轮）：页面条内不得再出现「没有打开的页面」。
  // 该文案属冗余说明（左栏书签 / 图标条本身就是入口），按铁律 12 只收不增。
  // 判据分两路：① 条内文本不含关键词；② 源码层/hasAnyItem 死代码已在契约 I3 锁住。
  const emptyHint = await evalJs(`(() => {
    const bar = document.querySelector('[data-wb="pagebar"]')
    return { hasHint: !!bar && bar.textContent.includes('没有打开的页面'), text: (bar?.textContent ?? '').slice(0, 120) }
  })()`)
  ok(!emptyHint.hasHint, 'P10 页面条内无空态提示文字（「没有打开的页面」足迹为零）', JSON.stringify(emptyHint))

  ok(consoleErrors.length === 0, 'P9 console 零 error', consoleErrors.slice(0, 3).join(' | '))

  console.log('\n截图：', shotOverview, '|', shotEditor, '|', shotKnowledge)
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
