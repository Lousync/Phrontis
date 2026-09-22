/**
 * 摘录导出知识库闭环探针（v3.5.0 第 5 项 · 施工方案 C）。
 * 用法（隔离实例，勿与用户 dev 抢单实例锁）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books --ud "knowbase (dev probe-app)"
 *   cd tmp/probe-app && node <仓库根>/.AGENT/scripts/workbench-shell/probes/run-probe.mjs ^
 *     <仓库根>/.AGENT/scripts/workbench-shell/probes/probe-excerpt-export.mjs --no-sandbox --disable-gpu
 *
 * 断言链（任一失败 exit 1）：
 *   1) 实例自证：build 产物（file:）+ 当前仓库 = 探针 fixture
 *   2) 预置 2 条 TXT 摘录 → 打开该书 → 右栏出现导出按钮
 *   3) 点导出 → 知识库页数 +1（**能看见**：广播 + 索引都生效）+ 映射回写 + md 里 2 个 kbloc 链接
 *   4) 再点一次 → 页数**不变**、页面 id **不变**（幂等：覆盖重写同一篇，不产生新页）
 *   5) 页面被删 → 再导出自愈新建（映射指向失效页面时不报错、自动重建）
 *   6) ★ B-15：同名不同格式的书（探针样书.txt / .epub）各导一篇 → 页名带格式后缀、互不覆盖
 */
const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } = await import('node:fs')
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
// 仓库根由脚本位置推导（probes → workbench-shell → scripts → .AGENT → 仓库根）。
// 勿写死盘符：在 worktree 里跑会静默读主仓的 fixture → 假 PASS。
const PROJ = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const FIXTURE = `${PROJ}/tmp/vault-fixture`
const BOOK = '.books/探针样书.txt'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* 等 electron */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常')
  return r.result?.value
}

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}
function assertFailed() { if (failed) { console.error('断言链中断'); process.exit(1) } }

const mapPath = join(FIXTURE, '.knowbase', 'modules', 'excerptExports.json')
const inboxDir = join(FIXTURE, '.knowbase', '_inbox')
const readMap = () => { try { return JSON.parse(readFileSync(mapPath, 'utf8')) } catch { return null } }
const listNotes = () => {
  try { return readdirSync(inboxDir).filter((f) => f.startsWith('读书笔记 · ')) } catch { return [] }
}
const pageCount = async () => {
  const pages = await evalJs(`window.api.getKnowledgePages().then((p) => (p ?? []).length).catch(() => -1)`)
  return pages
}
/** 轮询到目标页数（广播 + 索引重建需要一拍） */
const waitPageCount = async (want, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const n = await pageCount()
    if (n === want) return n
    await sleep(300)
  }
  return await pageCount()
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  await send('Runtime.enable')
  for (let i = 0; i < 24; i++) {
    const ready = await evalJs(`!!document.querySelector('[data-wb-bookmark="bookshelf"]')`).catch(() => false)
    if (ready) break
    await sleep(500)
  }
  await sleep(800)
  await evalJs(`(() => {
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push(String(e.message || e)))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)))
    return true
  })()`)
  // 兜底：仓库选择器 / 新手引导若仍在前台，按同套路径绕过（与其余探针一致）
  for (let i = 0; i < 6; i++) {
    const up = await evalJs(`!!document.querySelector('.vault-picker-step')`)
    if (!up) break
    await evalJs(`(() => {
      const row = [...document.querySelectorAll('button, [role=button], .cursor-pointer')].find((x) => (x.textContent || '').includes('探针测试仓库'))
      row?.click(); return true
    })()`)
    await sleep(500)
  }
  for (let i = 0; i < 12; i++) {
    const step = await evalJs(`!!document.querySelector('.onboarding-step')`)
    if (!step) break
    await evalJs(`(() => {
      const vis = (b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const b = [...document.querySelectorAll('button')].filter(vis).find((x) => /下一步|完成|跳过/.test(x.textContent || ''))
      b?.click(); return true
    })()`)
    await sleep(400)
  }

  // 1) 实例自证
  const proto = await evalJs(`location.protocol`)
  const vaultName = await evalJs(`(async () => { try { const cur = await window.api.workspaceGetCurrent(); return cur?.name ?? null } catch { return null } })()`)
  const cur = await evalJs(`(async () => { try { const c = await window.api.workspaceGetCurrent(); return c ? { rootId: c.rootId, path: c.path } : null } catch { return null } })()`)
  console.log('[实例自证]', JSON.stringify({ proto, vaultName, rootId: cur?.rootId }))
  if (proto !== 'file:' || vaultName !== '探针测试仓库' || !cur?.rootId) {
    console.error('CDP 连接的不是隔离探针实例（proto/vault 不符），终止以防误伤')
    process.exit(3)
  }

  // 2) 预置 2 条 TXT 摘录（确定性 fixture：直接写盘，导出链路读的就是这份）
  const key = `${cur.rootId}/${BOOK}`
  const now = new Date().toISOString()
  const mk = (id, paraIndex, text, color, type) => ({ id, kind: 'txt', paraIndex, start: 0, end: text.length, text, note: id === 'ex-1' ? '第一条的备注' : '', color, type, at: now, updatedAt: now })
  writeFileSync(join(FIXTURE, '.knowbase', 'modules', 'excerpts.json'), JSON.stringify({
    version: 1,
    books: { [key]: { 'ex-1': mk('ex-1', 1, '探针样书第一段的摘录文本', 'g', 'excerpt'), 'ex-2': mk('ex-2', 2, '探针样书第二段的摘录文本', 'b', 'idea') } },
  }, null, 2), 'utf8')
  // 映射与旧导出页先清（重复跑不漂移）
  try { unlinkSync(mapPath) } catch { /* 无即无需清 */ }
  for (const f of listNotes()) { try { unlinkSync(join(inboxDir, f)) } catch { /* 忽略 */ } }
  console.log('[fixture]', JSON.stringify({ key, notesBefore: listNotes().length }))
  // ★ 上面是**绕过应用直接删盘**，而 knowledgeIndex 是**记忆化**的（磁盘缓存还不校验文件是否在，
  //   见 seed-probe-vault.mjs 里那段「幽灵页」说明）⇒ 不重建就会把已删的页继续算进页数，
  //   下面「导出后页数 +1」拿到假读数。2026-09-22 实测：连跑几轮别的探针后 here = before 13 / after 11
  //   （导出写盘触发 rebuild，才第一次看到真值），换 seed 紧接着跑则一直绿 ——
  //   即这条与产品无关，是**探针之间的世界污染**。修法：用现成通道做一次**净零**的星标往返，
  //   借它的 invalidateKnowledgeIndex() 逼索引重建（不新造测试专用 IPC，也不动产品代码）。
  //   选页要躲开三类「不能写」的条目（欢迎页 / 二进制归档 / 索引里有但盘上已不在 = 幽灵页），
  //   所以是**挨个试**：成功一次索引就已重建，随后那次回翻把星标复原（净零，不污染 fixture 语义）。
  const rebuilt = await evalJs(`(async () => {
    const pages = (await window.api.getKnowledgePages()) ?? []
    for (const p of pages.slice(0, 12)) {
      if (!p || !p.id) continue
      try {
        if (!(await window.api.toggleKnowledgeStar(p.id))) continue
        await window.api.toggleKnowledgeStar(p.id)
        return 'ok:' + p.id
      } catch { /* 换下一个 */ }
    }
    return 'no-starrable-page'
  })()`)
  console.log('[索引重建]', rebuilt)

  // 3) 打开书架 → 点 TXT 样书 → 等阅读器
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1200)
  const clicked = await evalJs(`(() => {
    // ★ 必须**精确匹配 relPath**（卡片 title 就是 relPath）。
    //   以前这里是 \`includes('探针样书')\` —— fixture 只有 .txt 时恰好命中，2a 加进 .epub/.fb2/.fbz、
    //   2b 加进 .cbz 之后，DOM 第一张变成 \`探针样书.epub\` ⇒ 点开的是 EPUB、挂上 epubReader，
    //   下面「TXT 阅读器挂载」永远为假（表象是探针自缢，不是产品挂了）。
    const card = [...document.querySelectorAll('main button')]
      .find((b) => (b.getAttribute('title') || '') === ${JSON.stringify(BOOK)})
    card?.click(); return !!card
  })()`)
  ok('找到并点击 TXT 样书卡片', clicked)
  let readerOn = false
  for (let i = 0; i < 30; i++) {
    readerOn = await evalJs(`!!document.querySelector('[data-wb="txtReader"]')`).catch(() => false)
    if (readerOn) break
    await sleep(500)
  }
  ok('TXT 阅读器挂载', readerOn)
  assertFailed()

  // 4) 右栏切到阅读 Tab（面板随阅读态出现）
  const tabClicked = await evalJs(`(() => {
    const t = document.querySelector('[data-wb-rp-tab="reading"]')
    t?.click(); return !!t
  })()`)
  ok('右栏出现阅读 Tab 并可点击', tabClicked)
  let panelW = 0
  for (let i = 0; i < 20; i++) {
    panelW = await evalJs(`(() => { const el = document.querySelector('[data-wb="readingPanel"]'); return el ? Math.round(el.getBoundingClientRect().width) : 0 })()`).catch(() => 0)
    if (panelW > 0) break
    await sleep(300)
  }
  ok('阅读面板可见（宽度 > 0）', panelW > 0, `w=${panelW}`)

  const btn = await evalJs(`(() => {
    const b = document.querySelector('[data-wb="excerptExportBtn"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { text: (b.textContent || '').trim(), title: b.getAttribute('title') || '', visible: r.width > 0 && r.height > 0, disabled: !!b.disabled }
  })()`)
  console.log('[导出按钮]', JSON.stringify(btn))
  ok('右栏书卡头有「导出为笔记」按钮且可见', !!btn?.visible)
  assertFailed()

  // 5) 第一次导出 → 页数 +1 + 映射回写 + md 两个 kbloc 链接
  const before = await pageCount()
  await evalJs(`(() => { document.querySelector('[data-wb="excerptExportBtn"]')?.click(); return true })()`)
  const after1 = await waitPageCount(before + 1, 20)
  ok('点导出 → 知识库页数 +1', after1 === before + 1, `before=${before} after=${after1}`)

  const map1 = readMap()
  const e1 = map1?.books?.[key] ?? null
  console.log('[映射①]', JSON.stringify(e1))
  ok('excerptExports.json 回写该书映射', !!e1 && !!e1.pageId)
  ok('映射 count = 2', e1?.count === 2, `count=${e1?.count}`)

  const notes1 = listNotes()
  console.log('[收件箱]', JSON.stringify(notes1))
  ok('收件箱出现「读书笔记 · 探针样书」页文件', notes1.length === 1, JSON.stringify(notes1))
  const md1 = notes1.length ? readFileSync(join(inboxDir, notes1[0]), 'utf8') : ''
  ok('导出 md 含 2 个 kbloc 链接', (md1.match(/kbloc:/g) || []).length === 2, `实际 ${(md1.match(/kbloc:/g) || []).length}`)
  ok('导出 md 链接指向书键与摘录 id', md1.includes(`kbloc:${key}#ex-1`) && md1.includes(`kbloc:${key}#ex-2`))
  ok('导出 md 含 frontmatter id（页面身份，非草稿）', /^---[\s\S]*?\bid:\s*\S+/m.test(md1))
  ok('导出 md 含备注', md1.includes('第一条的备注'))
  ok('导出 md 不含未预期协议（无 http/file/javascript）', !/https?:|file:|javascript:/i.test(md1))

  // 知识库索引侧「看得见」：页清单里能找到该页
  const seen = await evalJs(`window.api.getKnowledgePages().then((p) => (p ?? []).some((x) => String(x.title || '').includes('读书笔记'))).catch(() => false)`)
  ok('知识库页清单里能看到该页（广播 + 索引生效）', seen)

  // 6) 第二次导出 → 页数不变 + 页面 id 不变（幂等）
  await evalJs(`(() => { document.querySelector('[data-wb="excerptExportBtn"]')?.click(); return true })()`)
  await sleep(2000)
  const after2 = await pageCount()
  ok('再点一次导出 → 页数不变（不产生新页）', after2 === after1, `after1=${after1} after2=${after2}`)
  const map2 = readMap()
  const e2 = map2?.books?.[key] ?? null
  ok('★ 覆盖重写后页面 id 不变', !!e2 && e2.pageId === e1?.pageId, `${e1?.pageId} → ${e2?.pageId}`)
  ok('收件箱页文件数仍为 1', listNotes().length === 1, JSON.stringify(listNotes()))

  // 7) 自愈：把映射指向一个不存在的页面 → 再导出应重新建页、不报错
  {
    const broken = readMap() ?? { version: 1, books: {} }
    broken.books = broken.books ?? {}
    broken.books[key] = { ...(e2 ?? {}), pageId: 'no-such-page-id' }
    writeFileSync(mapPath, JSON.stringify(broken, null, 2), 'utf8')
    await evalJs(`(() => { document.querySelector('[data-wb="excerptExportBtn"]')?.click(); return true })()`)
    const after3 = await waitPageCount(after1 + 1, 20)
    const e3 = readMap()?.books?.[key] ?? null
    ok('★ 映射指向已删页面 → 自愈新建（页数 +1、回写新 id）', after3 === after1 + 1 && !!e3?.pageId && e3.pageId !== 'no-such-page-id', `after=${after3} id=${e3?.pageId}`)
  }

  // 8) ★ B-15：同名不同格式的书各导一篇 —— 页名必须带格式后缀、互不覆盖。
  //    fixture 里 探针样书.txt / .epub 展示名相同（bookDisplayName 都是「探针样书」），
  //    修前会产出「读书笔记 · 探针样书.md」+「…(1).md」，只有 (N) 后缀能区分。
  //    这里直接走 IPC 导出（不依赖 UI 划选），断言只看**页名与内容归属**。
  {
    const BOOK2 = '.books/探针样书.epub'
    const key2 = `${cur.rootId}/${BOOK2}`
    const xStore = JSON.parse(readFileSync(join(FIXTURE, '.knowbase', 'modules', 'excerpts.json'), 'utf8'))
    const now2 = new Date().toISOString()
    xStore.books[key2] = {
      'ex-9': { id: 'ex-9', kind: 'epub', cfi: '/6/4!/4/2/2:0', chapter: '第一章', text: 'EPUB 那本的独占摘录文本', note: '', color: 'y', type: 'excerpt', at: now2, updatedAt: now2 },
    }
    writeFileSync(join(FIXTURE, '.knowbase', 'modules', 'excerpts.json'), JSON.stringify(xStore, null, 2), 'utf8')

    const beforeNotes = listNotes()
    const txtFile = beforeNotes.find((f) => f.includes('探针样书.txt'))
    const txtBefore = txtFile ? readFileSync(join(inboxDir, txtFile), 'utf8') : ''

    const r2 = await evalJs(`window.api.excerptExportNote(${JSON.stringify(cur.rootId)}, ${JSON.stringify(BOOK2)}).then((x) => x).catch((e) => ({ ok: false, error: String(e) }))`)
    console.log('[B-15 导出]', JSON.stringify(r2))
    const afterNotes = listNotes()
    ok('★ B-15：EPUB 那本导出成功', !!r2?.ok, JSON.stringify(r2))
    ok('★ B-15：收件箱恰好新增 1 篇（页数 +1）', afterNotes.length === beforeNotes.length + 1, `${beforeNotes.length} → ${afterNotes.length}`)
    ok('★ B-15：页名带格式后缀且互不相同',
      afterNotes.includes('读书笔记 · 探针样书.epub.md') && afterNotes.includes('读书笔记 · 探针样书.txt.md'),
      JSON.stringify(afterNotes))
    ok('★ B-15：新页不是 (N) 后缀副本（说明不是撞名退让）',
      afterNotes.includes('读书笔记 · 探针样书.epub.md') && !afterNotes.some((f) => /探针样书\.epub\(\d+\)\.md$/.test(f)),
      JSON.stringify(afterNotes))
    const txtAfter = txtFile ? readFileSync(join(inboxDir, txtFile), 'utf8') : ''
    ok('★ B-15：TXT 那篇内容零改动（互不覆盖）', !!txtBefore && txtAfter === txtBefore)
    const epubMd = afterNotes.includes('读书笔记 · 探针样书.epub.md') ? readFileSync(join(inboxDir, '读书笔记 · 探针样书.epub.md'), 'utf8') : ''
    ok('★ B-15：EPUB 那篇是自己的摘录（未串入 TXT 的）',
      epubMd.includes('EPUB 那本的独占摘录文本') && !epubMd.includes('探针样书第一段的摘录文本'))
  }

  const errs = await evalJs(`window.__errs ?? []`)
  ok('渲染层无未捕获错误', (errs?.length ?? 0) === 0, JSON.stringify(errs?.slice(0, 3)))
  const errTexts = await evalJs(`[...document.querySelectorAll('[data-toast]')].map((e) => e.textContent).slice(0, 4)`)
  console.log('[toast]', JSON.stringify(errTexts))

  console.log(failed ? '\n存在失败断言' : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error('摘录导出探针失败:', e.message); process.exit(2) })
