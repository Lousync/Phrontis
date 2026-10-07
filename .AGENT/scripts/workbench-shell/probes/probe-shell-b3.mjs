/**
 * 批次3 左栏书签双态运行时探针：electron 产物 + CDP（Node 22 内置 WebSocket）
 * 断言：外壳 DOM / 书签 6 项 / 书签↔标签联动 / 模块态 slot+portal / 跟随与锁定 /
 *       树模式 / vaultBar / workbenchLayout 落盘 / console 零 error
 * 前置：electron 不设 KNOWBASE_SHARED_DATA 启动（走 dev 隔离，userData=%APPDATA%/knowbase (dev KnowledgeRecorder)）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT || 9222) // 端口可覆盖（KNOWBASE_PROBE_PORT，见 run-probe.mjs）：默认 9222 不变
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
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

const JS_STATE = `(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  return {
    rootChildren: q('#root')?.children.length ?? 0,
    shell: !!q('[data-wb="shell"]'),
    tabbar: !!q('[data-wb="pagebar"]'),
    // 2026-09-18 页面条置顶：编辑器 / 知识库不再占模块条目（由各自页签组代表），
    // 模块级状态改从页面条的 data-pb-tabs（openTabs 全量）读
    openTabs: (q('[data-wb="pagebar"]')?.dataset.pbTabs ?? '').split(',').filter(Boolean),
    bookmarks: qa('[data-wb="bookmarks"] [data-wb-bookmark]').map((b) => b.dataset.wbBookmark),
    bookmarkActive: qa('[data-wb="bookmarks"] [data-wb-bookmark][data-wb-active="1"]').map((b) => b.dataset.wbBookmark),
    modSlot: !!q('[data-wb="modSlot"]'),
    modSlotFilled: !!q('[data-wb="modSlot"]') && q('[data-wb="modSlot"]').children.length > 0,
    // 2026-09-16 第二轮 UI 反馈：模块态头部文字装饰已删，模块态改读 data-wb-mod（模块 key）
    modTitle: q('[data-wb="mod"]')?.dataset.wbMod ?? '',
    treeMode: !!q('[data-wb="treeMode"]'),
    treeDirs: qa('[data-wb="treeMode"] div').filter((d) => d.textContent && !d.querySelector('button')).length,
    // 真树判据（2026-09-29）：VaultTree 条目锚点 + 底部软件文件折叠节
    treeNodes: qa('[data-wb="treeMode"] [data-wb-tree-node]').length,
    treeSoftHead: !!q('[data-wb="treeMode"] [data-wb="treeSoftHead"]'),
    vaultBar: !!q('[data-wb="vaultBar"]'),
    tabs: qa('[data-wb="tab"]').map((t) => ({ id: t.dataset.wbTab, active: t.dataset.wbActive })),
    lockTitle: q('button[title^="锁定侧边栏"], button[title^="已锁定"]')?.title ?? '',
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
  for (let i = 0; i < 30; i++) {
    const st = await evalJs(`(() => ({ n: document.querySelector('#root')?.children.length ?? 0 }))()`)
    if (st.n > 0) break
    await sleep(500)
  }
  let st0 = await evalJs(JS_STATE)
  if (!st0.shell) {
    // 仓库选择页 → 进入
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/进入|打开|继续/.test(x.textContent)); b?.click(); return !!b })()`)
  }
  // 等主界面就绪（书签区 6 项渲染）：进入仓库 + 懒加载可能慢于固定 sleep（实测选仓页进入
  // 偶发慢于 1.5s → S3/S4/T1b 假失败），轮询最长 12s
  for (let i = 0; i < 24; i++) {
    st0 = await evalJs(JS_STATE)
    if (st0.shell && st0.bookmarks.length === 5) break
    await sleep(500)
  }

  // 状态复位：上次运行的 S13 可能落盘了 leftCollapsed=true → 本次启动左栏直接收起，S3 假失败。
  // 清空 workbenchLayout（parseWorkbenchLayout 对空串走默认值），等 debounce flush 后再断言。
  await evalJs(`window.api?.setSetting ? window.api.setSetting('workbenchLayout', '') : 'no-api'`)
  await sleep(800)
  // 复位后左栏若曾收起会自动展开（layout.leftCollapsed=false），重取一次状态
  st0 = await evalJs(JS_STATE)

  ok(st0.shell, 'S1 三栏外壳渲染')
  ok(st0.tabbar, 'S2 中间页面条渲染（v3.4.0 页面条置顶：原标签条）')
  ok(st0.bookmarks.join(',') === 'dashboard,knowledge,schedule,bookshelf,blog', 'S3 书签 5 项（2026-09-29 对齐真值：editor 模块退役、quiz 进 QUIZ_ENTRY_ENABLED 总闸）', st0.bookmarks.join(','))
  ok(st0.vaultBar, 'S4 底部仓库切换 vaultBar 渲染')
  // S5：启动落点可能一个标签都没开（反馈 10 起「回工作台 = 总览态」），故不断言已有标签，
  // 只记录现值；真正验「标签会登记」交给 T3（点知识库书签 → openTabs 含 knowledge）。
  console.log(`  · S5 openTabs 启动现值：${st0.openTabs.join(',') || '(空)'}`)

  // T1 书签点击 → 进模块态（整窗模块 dashboard 不开标签，故用 knowledge 验证既有链路）
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(1400)
  const st1 = await evalJs(JS_STATE)
  ok(st1.openTabs.includes('knowledge'), 'T1 点知识库书签 → openTabs 登记 knowledge', st1.openTabs.join(','))

  // T2 ‹ 返回总览 = 退出模块态（原型 lpBack：书签区只在总览可见，「再点书签退出」经返回钮达成）
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(600)
  const st2 = await evalJs(JS_STATE)
  ok(!st2.modSlot, 'T2 返回总览 = 退出模块态')
  ok(st2.bookmarks.length === 5, 'T2b 总览书签区恢复（5 项）')

  // T3 知识库书签 → 模块态 + 标签；标签条点 editor（已开）→ 跟随（标题变编辑区）
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(1200)
  const st3 = await evalJs(JS_STATE)
  ok(st3.modSlot && st3.modTitle === 'knowledge', 'T3 点知识库书签 → 模块态 = knowledge', `mod=${st3.modTitle}`)
  ok(st3.modSlotFilled, 'T3b knowledge 侧栏 portal 进左栏 slot')
  // T3c 页面条点模块条目 → 左栏自动跟随。2026-09-18 页面条置顶后编辑器 / 知识库不再占模块条目，
  // 故改用「博客」条目验证同一条链路（先返回总览 → 开博客 → 再返回总览 → 点条目）。
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb-bookmark="blog"]')?.click()`)
  await sleep(1200)
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="blog"]')?.click()`)
  await sleep(700)
  const st4 = await evalJs(JS_STATE)
  ok(st4.modTitle === 'blog', 'T3c 页面条点博客条目 → 左栏自动跟随', `mod=${st4.modTitle}`)

  // T4 锁定：📌 后点条目不跟随；解锁恢复（两个条目：博客 / 日程）
  // 注意：模块态下书签区隐藏，必须先「返回总览」才能点书签把日程登记进 openTabs
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb-bookmark="schedule"]')?.click()`)
  await sleep(1000)
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="blog"]')?.click()`)
  await sleep(700)
  const st4b = await evalJs(JS_STATE)
  const lockBtn = st4b.lockTitle
  ok(!!lockBtn, 'T4 模块态头部有锁定钮', lockBtn)
  await evalJs(`document.querySelector('button[title^="锁定侧边栏"]')?.click()`)
  await sleep(400)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="schedule"]')?.click()`)
  await sleep(700)
  const st5 = await evalJs(JS_STATE)
  ok(st5.modTitle === 'blog', 'T4b 锁定后点条目不跟随（仍博客）', `mod=${st5.modTitle}`)
  await evalJs(`document.querySelector('button[title^="已锁定"]')?.click()`)
  await sleep(400)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="schedule"]')?.click()`)
  await sleep(700)
  const st6 = await evalJs(JS_STATE)
  ok(st6.modTitle === 'schedule', 'T4c 解锁后点条目恢复跟随（日程）', `mod=${st6.modTitle}`)

  // T5 错题本书签：QUIZ_ENTRY_ENABLED=false（v3.5.0 随交互重做放出）时不渲染，只做在场性断言
  const quizBookmarkPresent = await evalJs(`!!document.querySelector('[data-wb-bookmark="quiz"]')`)
  if (quizBookmarkPresent) {
    await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
    await sleep(500)
    await evalJs(`document.querySelector('[data-wb-bookmark="quiz"]')?.click()`)
    await sleep(1200)
    const st7 = await evalJs(JS_STATE)
    ok(st7.openTabs.includes('knowledge'), 'T5 错题本书签 → openTabs 登记 knowledge', st7.openTabs.join(','))
    ok(st7.modTitle === 'quiz', 'T5b 模块态 = quiz（错题本复用 knowledge 侧栏）', `mod=${st7.modTitle}`)
  } else console.log('  （跳过 T5/T5b：QUIZ_ENTRY_ENABLED=false，错题本书签按总闸不渲染）')

  // ===== T6 树模式（方案 .claude/plans/workbench-tree-mode-implementation.md，2026-09-29 重写）=====
  // 本轮核心判据必须落在**运行期**：进树 → 展开目录（出现子条目）→ 点 md →
  // 断言「页面条真多了页签 **且** 中间区处于编辑态（非阅读优先）」。
  // 源码断言不算（顺序/时序类改动，见 memory contract-green-locks-wrong-order）。
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb="treeModeBtn"]')?.click()`)
  await sleep(800)
  const st8 = await evalJs(JS_STATE)
  ok(st8.treeMode, 'T6 🌳 进入文件树模式')
  ok(st8.treeNodes, 'T6c 树模式渲染真树（VaultTree 条目在场）', `nodes=${st8.treeNodes}`)
  // 软件文件折叠节只在根层有软件生成项时渲染（仓库内容相关）——无则跳过而非判失败
  if (st8.treeSoftHead === false) console.log('  （跳过 T6d：本仓根层无软件生成项，折叠节按设计不渲染）')

  // 展开一个根层目录 → 出现子条目
  const treeDir = await evalJs(`(() => {
    const d = document.querySelector('[data-wb="treeMode"] [data-wb-tree-node][data-wb-tree-dir="1"]')
    if (!d) return ''
    d.click(); return d.dataset.wbTreePath || '?'
  })()`)
  await sleep(900)
  const st8b = await evalJs(JS_STATE)
  ok(!!treeDir && st8b.treeNodes > st8.treeNodes, 'T6e 点目录行展开（子条目渲染）', `${treeDir} nodes ${st8.treeNodes}→${st8b.treeNodes}`)

  // 点一个 md 文件 → 新页签 + 编辑态
  const opened = await evalJs(`(() => {
    const f = [...document.querySelectorAll('[data-wb="treeMode"] [data-wb-tree-node][data-wb-tree-file="1"]')]
      .find((n) => /\\.md$/i.test(n.dataset.wbTreePath || ''))
    if (!f) return ''
    f.click(); return f.dataset.wbTreePath
  })()`)
  await sleep(2000)
  const st8c = await evalJs(`(() => {
    const q = (s) => document.querySelector(s)
    const qa = (s) => [...document.querySelectorAll(s)]
    // ★ 选择器口径：data-pb-owner 在**条目自身**上，不是容器（PageTabStrip:137）——不能写后代选择器
    const kbItems = qa('[data-wb="pagebar"] [data-pb-item][data-pb-owner="knowledge"]')
    const activeItem = kbItems.find((el) => el.dataset.wbActive === '1') ?? kbItems[0]
    return {
      tabs: (q('[data-wb="pagebar"]')?.dataset.pbTabs ?? '').split(',').filter(Boolean),
      kbItemCount: kbItems.length,
      kbActiveRel: activeItem?.dataset.tabId ?? '',
      kbFirstRel: kbItems[0]?.dataset.tabId ?? '',
      // 编辑态判据：Monaco 容器在场且不是阅读态排版（preview 态走 h1 + MarkdownPreview）
      monaco: !!q('.monaco-editor'),
      previewH1: !!q('main h1.text-xl'),
      editing: !!q('.monaco-editor') && !q('main h1.text-xl'),
    }
  })()`)
  ok(st8c.tabs.includes('knowledge'), 'T6f 点树内 md → 页面条登记 knowledge 页签', st8c.tabs.join(','))
  // 身份口径（2026-09-29 实测修正）：已在索引里的 md 页签 id 是 `auto:<relPath>`（身份统一兜底），
  // 只有未被索引收录的才落 `draft:<relPath>`——两种都是「该文件被打开」的合法身份，不能只认 draft。
  ok(st8c.kbItemCount > 0 && /^(draft|auto):/.test(st8c.kbFirstRel || ''), 'T6g 知识库页签组出现该 md（draft/auto 身份）', `n=${st8c.kbItemCount} rel=${st8c.kbFirstRel || st8c.kbActiveRel}`)
  ok(st8c.editing && st8c.monaco && !st8c.previewH1, 'T6h ★打开即编辑态（Monaco 在场、非阅读态排版）', `monaco=${st8c.monaco} previewH1=${st8c.previewH1}`)

  // 互斥（本轮一并修的缺陷）：树里开过文件后 ⌂ 回总览，必须**真回总览**而不是掉进模块侧栏
  await evalJs(`document.querySelector('button[title="返回总览"]')?.click()`)
  await sleep(700)
  const st9 = await evalJs(JS_STATE)
  ok(!st9.treeMode && st9.bookmarks.length === 5, 'T6b 树模式返回总览')
  ok(!st9.modSlot, 'T6i ★⌂ 回总览不掉进模块侧栏（leftMode/railModule 互斥修复的运行期判据）', `modSlot=${st9.modSlot} mod=${st9.modTitle}`)

  // ===== T7 外部改动实时性（开发负责人 2026-09-29 明确要求）=====
  // 场景：用户在**系统资源管理器**里改了这个仓库（新建 / 改名 / 删除），
  // 工作台文件树必须**及时**跟上，不能等切标签或手动刷新。
  // 链路：fsWatcher(原生 fs.watch recursive) → 防抖 300ms flush → broadcastDataChanged('knowledge')
  //       → 左栏 useDataChanged('knowledge') → 重扫已加载目录。
  // ★ 这条必须运行期验：源码断言只能证明「接了通道」，证明不了「真会到」。
  await evalJs(`document.querySelector('[data-wb="treeModeBtn"]')?.click()`)
  await sleep(700)
  const t7a = await evalJs(JS_STATE)
  ok(t7a.treeMode, 'T7 前置：回到树模式')

  const fsProbe = await import('node:fs')
  const pathProbe = await import('node:path')
  // ★ 仓库路径必须**从 app 实况取**（ws:getCurrent 返回 path），不能假定 fixture：
  //   探针宿主不指定仓库时，app 用 %APPDATA% 里记录的 recentVault —— 2026-09-29 首次跑
  //   就是错写到 tmp/vault-fixture 导致假红（磁盘读显示的是另一个仓库）。
  // ★ 且**不在仓库根直接造文件**（那是真实数据）：建一个专用子目录，全部操作关在里面，
  //   finally 递归删掉。子目录本身的新建/改名/删除同样能验「外部改动实时上树」。
  const vaultInfo = await evalJs(`window.api?.workspaceGetCurrent?.().then((c) => ({ path: c?.path ?? '', name: c?.name ?? '' }))`)
  const VAULT = vaultInfo?.path ?? ''
  const probeDir = VAULT ? pathProbe.join(VAULT, '__probe_t7__') : ''
  const inner = probeDir ? pathProbe.join(probeDir, 'a.md') : ''
  const inner2 = probeDir ? pathProbe.join(probeDir, 'b.md') : ''
  let t7ok = true
  let t7detail = ''
  if (!VAULT) {
    t7ok = false; t7detail = '拿不到当前仓库路径（ws:getCurrent.path 为空）'
  } else try {
    // 叶子选择器：树里根层节点的 data-wb-tree-path 是相对仓库根的路径
    const seeInTree = (rel) => evalJs(`!!document.querySelector('[data-wb="treeMode"] [data-wb-tree-path="${rel}"]')`)

    // ① 外部新建目录 + 其中放一个文件
    fsProbe.mkdirSync(probeDir, { recursive: true })
    fsProbe.writeFileSync(inner, '---\nid: 00000000-0000-0000-0000-00000000t7t7\ntitle: probe\n---\n\n', 'utf-8')
    await sleep(1800)
    let hasNew = await seeInTree('__probe_t7__')
    if (!hasNew) {
      // 诊断：手动派发 knowledge 广播（等价于主进程那条），区分「通道没到」与「重扫有 bug」
      await evalJs(`window.dispatchEvent(new CustomEvent('kb:data-changed', { detail: { scope: 'knowledge' } }))`)
      await sleep(1400)
      const afterManual = await seeInTree('__probe_t7__')
      t7detail += `[诊断] 手动广播后可见=${afterManual}（false=重扫有 bug，true=fsWatcher 通道没到） `
      hasNew = afterManual
    }
    if (!hasNew) { t7ok = false; t7detail += '新建未上树 ' }

    // ② 外部改名目录（走 OS 层 rename，绕开应用内通道）
    const renamedDir = `${probeDir}_renamed`
    fsProbe.renameSync(probeDir, renamedDir)
    await sleep(1800)
    const hasRenamed = await seeInTree('__probe_t7___renamed')
    if (!hasRenamed) { t7ok = false; t7detail += '改名未上树 ' }

    // ③ 外部删除
    fsProbe.rmSync(renamedDir, { recursive: true, force: true })
    await sleep(1800)
    const gone = await evalJs(`!document.querySelector('[data-wb="treeMode"] [data-wb-tree-path="__probe_t7___renamed"]')`)
    if (!gone) { t7ok = false; t7detail += '删除未下树' }
  } catch (e) {
    t7ok = false; t7detail = '探针写盘异常: ' + String(e.message || e)
  } finally {
    // 兜底清理（正常路径已在 ③ 删掉；异常中断时这里收尾，绝不给真实仓库留垃圾）
    try { if (probeDir && fsProbe.existsSync(probeDir)) fsProbe.rmSync(probeDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { if (probeDir && fsProbe.existsSync(`${probeDir}_renamed`)) fsProbe.rmSync(`${probeDir}_renamed`, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  ok(t7ok, 'T7 ★系统资源管理器改动 → 文件树实时跟上（新建 / 改名 / 删除，各 ~1.6s 内）', t7detail.trim())

  // ===== T8 空白区右键（用户报障 2026-09-29）=====
  // 缺陷：树根只有条目撑开的高度，条目下方大片空白不响应右键（「想在空白处新建文件点不动」）。
  // 判据必须是**几何**的：树根高度 ≈ 容器高度（铺满），且在条目下方空白处右键真能弹出菜单。
  const t8geo = await evalJs(`(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) } }
    const wrap = document.querySelector('[data-wb="fileTree"]')
    const vt = document.querySelector('[data-wb="fileTree"] [tabindex="0"]')
    const rows = [...document.querySelectorAll('[data-wb="treeMode"] [data-wb-tree-node]')]
    return { wrap: r(wrap), vt: r(vt), lastRow: r(rows[rows.length - 1]) }
  })()`)
  const fillGap = t8geo.vt && t8geo.wrap ? t8geo.wrap.h - t8geo.vt.h : -999
  ok(Math.abs(fillGap) <= 4, 'T8 ★树根铺满容器高度（空白区右键判定区完整）', `wrap=${t8geo.wrap?.h} vt=${t8geo.vt?.h} gap=${fillGap}`)
  const gapBelowRows = t8geo.vt && t8geo.lastRow ? t8geo.vt.b - t8geo.lastRow.b : 0
  if (gapBelowRows > 40) {
    const hit = await evalJs(`(() => {
      const vt = document.querySelector('[data-wb="fileTree"] [tabindex="0"]')
      const b = vt.getBoundingClientRect()
      const x = Math.round(b.left + 30), y = Math.round(b.bottom - 20)
      const el = document.elementFromPoint(x, y)
      if (!el) return { ok: false, reason: 'elementFromPoint 为空' }
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
      return { ok: true, insideRow: !!el.closest('[data-wb-tree-node]') }
    })()`)
    await sleep(400)
    const menuOpen = await evalJs(`!!document.querySelector('.kb-pop-layer')`)
    // 关掉菜单，别影响后续段
    await evalJs(`document.querySelector('.kb-pop-layer')?.click()`)
    await sleep(300)
    ok(hit?.ok && !hit.insideRow && menuOpen, 'T8b ★条目下方空白右键 → 弹出根层菜单', `insideRow=${hit?.insideRow} menu=${menuOpen}`)
  } else {
    console.log(`  （跳过 T8b：本仓条目已占满树区，无「条目下方空白」可测，gapBelowRows=${gapBelowRows}）`)
  }

  // 收尾：回总览，避免给后续段留树模式残留
  await evalJs(`document.querySelector('button[title="返回总览"]')?.click()`)
  await sleep(600)


  // S13 落盘链路：单击左栏手柄收起 → flush → workbenchLayout 键落盘
  const collapseJs = `(() => {
    const h = document.querySelector('div[role="separator"][title="拖拽调整宽度，双击复位"]')
    if (!h) return 'NO_HANDLE'
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    return 'DOWN'
  })()`
  await evalJs(collapseJs)
  await sleep(150)
  await evalJs(`(() => {
    const h = document.querySelector('div[role="separator"][title="拖拽调整宽度，双击复位"]')
    ;(h || window).dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    return 'UP'
  })()`)
  await sleep(400)
  const stC = await evalJs(JS_STATE)
  ok(!stC.shell || stC.bookmarks.length === 0, 'S13a 单击手柄 → 左栏收起', `bookmarks=${stC.bookmarks.length}`)
  await sleep(1200)
  // userData = %APPDATA%/knowbase (dev KnowledgeRecorder)——不设 KNOWBASE_SHARED_DATA 时
  // main/index.ts L86 在正式目录名后加 " (dev <检出目录名>)" 后缀（与正式数据隔离）
  const settingsPath = join(process.env.APPDATA || '', 'knowbase (dev KnowledgeRecorder)', 'settings.json')
  let persisted = null
  let readErr = ''
  try {
    if (!existsSync(settingsPath)) readErr = 'settings.json 不存在'
    else persisted = JSON.parse(readFileSync(settingsPath, 'utf8')).workbenchLayout
  } catch (e) { readErr = String(e.message || e) }
  let parsed = null
  try { parsed = JSON.parse(persisted ?? 'null') } catch { /* null */ }
  ok(parsed?.leftCollapsed === true, 'S13b workbenchLayout.leftCollapsed=true 落盘', persisted == null ? readErr : JSON.stringify(parsed))
  // 恢复展开
  await evalJs(`(() => { const e=document.querySelector('div[title="拖拽或点击展开"]'); e?.click(); return !!e })()`)
  await sleep(700)
  const stR = await evalJs(JS_STATE)
  ok(stR.bookmarks.length === 5, 'S14 边缘条点击 → 左栏重挂恢复', `bookmarks=${stR.bookmarks.length}`)

  ok(consoleErrors.length === 0, 'S12 console 零 error', consoleErrors.slice(0, 3).join(' | '))

  const fails = results.filter((r) => !r.pass)
  console.log('\n========================================')
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
  console.log(fails.length === 0 ? `\n✅ ${results.length} 项全 PASS` : `\n❌ ${fails.length}/${results.length} FAIL`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(2) })
