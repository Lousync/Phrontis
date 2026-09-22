/**
 * 探针 fixture 仓库种子：探针 userData（%APPDATA%/knowbase (dev KnowledgeRecorder)，dev 隔离）默认无仓库 →
 * 编辑器走「未打开仓库」欢迎态，文件树侧栏不渲染，T1c/T3b portal 断言必然空。
 * 这里造一个带 .knowbase 的 fixture 仓库 + 登记（data/vaults.json）+ settings.currentVaultId，
 * 让 electron 启动时经 workspaceManager.loadVaults() 常规恢复路径打开它（不用原生对话框）。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const proj = 'E:/Projects/KnowledgeRecorder'
// --ud <name>：userData 目录名覆盖（默认 knowbase (dev KnowledgeRecorder)）。
// 隔离探针实例（tmp/probe-app，见 probe-app 说明）须传 --ud "knowbase (dev probe-app)"——
// 否则与用户正在跑的 dev 共用 userData：单实例锁互斥秒退 + 状态互相污染（2026-09-20 实测）。
const udFlagIdx = process.argv.indexOf('--ud')
const userDataName = udFlagIdx > -1 ? process.argv[udFlagIdx + 1] : 'knowbase (dev KnowledgeRecorder)'
const userData = join(process.env.APPDATA ?? '', userDataName)

// 防覆盖：隔离 userData 若尚无首启迁移 marker，先替 app 写上——
// 否则 app 首启的「从正式版快照」会覆盖本 seed 写入的 settings/vaults（2026-09-20 实测踩坑）。
// 探针数据自足（fixture vault + 空 settings），不需要正式版快照。
const markerPath = join(userData, '.dev-migrated')
if (!existsSync(markerPath)) {
  mkdirSync(userData, { recursive: true })
  writeFileSync(markerPath, new Date().toISOString(), 'utf8')
  console.log('wrote .dev-migrated marker → app 首启跳过快照迁移，seed 不会被覆盖')
}
const fixture = join(proj, 'tmp', 'vault-fixture')

// 1. fixture 仓库：.knowbase + 两个目录 + 散文件
for (const d of ['.knowbase', 'AI教学', '学习笔记']) mkdirSync(join(fixture, d), { recursive: true })
writeFileSync(join(fixture, 'README.md'), '# 探针 fixture\n\n仅供 probe-shell-b3 使用。\n', 'utf8')
writeFileSync(join(fixture, '学习笔记', '笔记一.md'), '# 笔记一\n\nfixture 内容。\n', 'utf8')

// 1b. B1 @ 引用（probe-batch5-ai E 组）需要 ≥5 个**可引用**页面（带 frontmatter id 的 doc，
//     非欢迎页）——chip 上限 4 篇要加到第 5 篇才验得出「超限被拒」。
//     无 frontmatter id 的 md 是草稿、知识库不显示，所以这批必须带 id。
for (let i = 1; i <= 6; i++) {
  const dir = join(fixture, '引用测试')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `引用页${i}.md`),
    `---\nid: probe-ref-${i}\ntitle: 引用页${i}\ntags: [探针, 引用]\n---\n\n# 引用页${i} 一级标题\n\n## 小节 A\n## 小节 B\n\n这是第 ${i} 篇引用测试页的首段正文，供 B1 骨架注入与 chip 上限断言使用。\n`,
    'utf8',
  )
}
// 1c. 全格式阅读器一期（2026-09-20）：--add-books → .books/ 落一本 TXT 样书
//     （几十段中文、空行分段），probe-reading-panel.mjs 断言链的 fixture
if (process.argv.includes('--add-books')) {
  // 幂等闸门（2026-09-21）：探针会往模块数据里写进度 / 摘录 / 书签，第二次跑时残留会让断言失真——
  // 实测两个假失败：① readerState.pct 残留 50 → step5「滚到 50%」从 50% 起滚，实际滚到 100%；
  // ② excerpts 残留 → 段落里已有 <mark>，程序化选区 range.setStart(文本节点, 4) 抛 IndexSizeError。
  // seed 在 electron 启动前执行（app 尚未把 jsonStore 载入内存），此处清空即真清空。
  //   ★ 这四个文件是**全格式共用**的：readerState.json 按 relPath 存每本书的进度/locator/字体/书签
  //     （epub 的 locator 是 CFI，同字段不同语义），excerpts.json / excerptExports.json 亦然。
  //     故「加了新格式」**不需要**新加文件；反过来，将来某格式真另立状态文件时**必须**补进本数组，
  //     否则残留态会让下一轮断言悄悄失真（正是 2026-09-21 踩到的那两个假失败）。
  const modulesDir = join(fixture, '.knowbase', 'modules')
  for (const f of ['readerState.json', 'excerpts.json', 'pdfReader.json', 'excerptExports.json']) {
    try { unlinkSync(join(modulesDir, f)); console.log('reset reader module data:', f) } catch { /* 不存在即无需清 */ }
  }
  // ★ 在 app 之外删了页，就必须一并删索引缓存 —— 否则留下「幽灵页」。
  //   knowledgeIndex 的磁盘缓存**不校验文件是否还在**（`getKnowledgeIndex` 只看 schemaVersion /
  //   source / ignoreState 指纹，见 knowledgeIndex.ts:796），所以本脚本删掉的「读书笔记」页仍算一页，
  //   表象是**下一个探针的页数断言假失败**：2026-09-22 实测 probe-excerpt-export 的
  //   「点导出 → 知识库页数 +1」拿到 before=11 after=11（缓存里的幽灵 +1，新建的真实页顶掉它 ⇒ 数量不变）。
  //   缓存删掉即强制重建，页数回到磁盘真值。给别的探针留一份干净的世界，比修某一个探针的断言更根本。
  for (const f of ['knowledge-index.json', 'knowledge-text.json']) {
    try { unlinkSync(join(fixture, '.knowbase', 'cache', f)); console.log('reset knowledge cache:', f) } catch { /* 不存在即无需清 */ }
  }
  // 摘录导出探针的幂等闸门（2026-09-21）：导出产生的「读书笔记」页落在收件箱（.knowbase/_inbox），
  // 残留会让「重复导出不产生新页」的页数断言漂移 → 一并清掉（只删本工具自己造的那一类页名）。
  {
    const inboxDir = join(fixture, '.knowbase', '_inbox')
    if (existsSync(inboxDir)) {
      for (const f of readdirSync(inboxDir)) {
        if (f.startsWith('读书笔记 · ')) {
          try { unlinkSync(join(inboxDir, f)); console.log('reset exported note:', f) } catch { /* 忽略 */ }
        }
      }
    }
  }
  const booksDir = join(fixture, '.books')
  mkdirSync(booksDir, { recursive: true })
  const bookPath = join(booksDir, '探针样书.txt')
  if (!existsSync(bookPath)) {
    const paras = []
    for (let i = 1; i <= 60; i++) {
      paras.push(`第 ${i} 段：这是探针样书的正文段落，用于驱动真实滚动并验证 TXT 阅读器的进度落盘与右栏阅读侧栏联动。`)
      paras.push('')
    }
    writeFileSync(bookPath, paras.join('\n'), 'utf8')
    console.log('seeded book:', bookPath)
  }
  // 轻量 PDF 样书（pdf-lib 生成，12 页带文本层）——PDF 划选摘录探针的 fixture
  const pdfPath = join(booksDir, 'Reader Sample (light).pdf')
  if (!existsSync(pdfPath)) {
    try {
      const require2 = createRequire(join(proj, 'package.json'))
      const { PDFDocument, StandardFonts, rgb } = require2('pdf-lib')
      const doc = PDFDocument.create ? await PDFDocument.create() : new PDFDocument()
      doc.setTitle('Phrontis Reader Sample')
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const bold = await doc.embedFont(StandardFonts.HelveticaBold)
      for (let i = 1; i <= 12; i++) {
        const page = doc.addPage([560, 760])
        page.drawText('Phrontis Reader Sample', { x: 60, y: 700, size: 18, font: bold, color: rgb(0.15, 0.15, 0.2) })
        page.drawText('Page ' + i + ' / 12', { x: 60, y: 668, size: 12, font, color: rgb(0.4, 0.4, 0.45) })
        for (let l = 0; l < 20; l++) {
          page.drawText('Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do ' + (i * 20 + l) + '.', {
            x: 60, y: 620 - l * 26, size: 10.5, font, color: rgb(0.2, 0.2, 0.25),
          })
        }
      }
      writeFileSync(pdfPath, Buffer.from(await doc.save()))
      console.log('seeded pdf:', pdfPath)
    } catch (e) {
      console.log('pdf seed skipped:', String(e).slice(0, 120))
    }
  }
  // 电子书引擎探针（B 段）的 fixture —— 两本 EPUB + 三本 FB2 系（阶段 2a 加后三本）：
  //   ① 探针样书.epub     正向：渲染 / 目录 / 分页 / 划选摘录 / 进度落盘
  //   ② 恶意样书.epub     负向：内联 <script> / onerror 属性 / 外部 <script src> 三载荷
  //                        「DOM 里在、执行没发生」（宿主 window 不被污染）
  //   ③ 探针样书.fb2      正向：同上 + KB PATCH ④（FB2 内建样式表内联）的排版靶
  //   ④ 探针样书.fbz      正向：同样内容装进 zip —— 分发看**后缀**（view.js 的 isFBZ 是 endsWith）
  //   ⑤ 恶意样书.fb2      负向：FB2 是白名单转换器 ⇒ 载荷**根本没进 DOM**（证据形态与 EPUB 不同）
  // 固定版式（阶段 2b，2026-09-22）再加两本 cbz：
  //   ⑥ 探针样书.cbz      正向：30 页纯色图（页名**不补零** ⇒ 字典序错页当场可见；部分条目大写 `.PNG`
  //                       ⇒ 上游大小写敏感的 `endsWith` 会把它们整包漏掉）+ 中间一条 `.txt` 诱饵
  //   ⑦ 恶意样书.cbz      负向：第 2 页是内联 <script> + onerror 的 .svg。三条防线**独立**：
  //                       SVG 作为 <img> 加载不执行脚本 / 内容帧 sandbox 无 allow-scripts / CSP 无 unsafe-inline
  // 生成器见 ./make-epub.mjs（零依赖手写 STORED zip，产物字节可复现）、./make-fb2.mjs、./make-cbz.mjs。
  // ★ 生成器改动后必须**先删产物**再 seed：下面按 existsSync 跳过，旧产物会静默留下来（踩过）
  for (const [name, mod, fn] of [
    ['探针样书.epub', './make-epub.mjs', 'probeEpub'],
    ['恶意样书.epub', './make-epub.mjs', 'maliciousEpub'],
    ['探针样书.fb2', './make-fb2.mjs', 'probeFb2'],
    ['探针样书.fbz', './make-fb2.mjs', 'probeFbz'],
    ['恶意样书.fb2', './make-fb2.mjs', 'maliciousFb2'],
    ['探针样书.cbz', './make-cbz.mjs', 'probeCbz'],
    ['恶意样书.cbz', './make-cbz.mjs', 'maliciousCbz'],
  ]) {
    const p = join(booksDir, name)
    if (existsSync(p)) continue
    try {
      const make = await import(mod)
      writeFileSync(p, make[fn]())
      console.log('seeded ebook:', p)
    } catch (e) {
      console.log('ebook seed skipped:', name, String(e).slice(0, 160))
    }
  }
}

if (!existsSync(join(fixture, '.knowbase', 'meta.json'))) {
  writeFileSync(join(fixture, '.knowbase', 'meta.json'), JSON.stringify({ name: '探针测试仓库', createdAt: new Date().toISOString() }), 'utf8')
}

// 2. 仓库登记表：userData/data/vaults.json
const dataDir = join(userData, 'data')
mkdirSync(dataDir, { recursive: true })
const vaultsPath = join(dataDir, 'vaults.json')
const row = {
  id: 'probe-vault-01',
  name: '探针测试仓库',
  path: fixture,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}
let rows = []
if (existsSync(vaultsPath)) {
  try { rows = JSON.parse(readFileSync(vaultsPath, 'utf8')) ?? [] } catch { rows = [] }
}
const mine = rows.filter((r) => r.id !== row.id)
writeFileSync(vaultsPath, JSON.stringify([...mine, row], null, 2), 'utf8')

// 3. settings.json：currentVaultId 指向 fixture（保留其他键）
const settingsPath = join(userData, 'settings.json')
let settings = {}
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) ?? {} } catch { settings = {} }
}
settings.currentVaultId = row.id
// 启动选择器关闭（App.tsx：onboardingDone 后每次启动弹 VaultPicker 全屏遮罩，拦截探针真实鼠标事件）
settings.startupVaultPicker = false
// 右栏基线归位（防上轮探针残留态污染：rightCollapsed=true 会让右栏面板整个不渲染，
// 阅读侧栏断言全空；rightTab 残留 'reading' 也会让回落断言失真）——显式归零
try {
  const wb = JSON.parse(settings.workbenchLayout ?? '{}')
  wb.rightCollapsed = false
  wb.rightTab = 'widgets'
  settings.workbenchLayout = JSON.stringify(wb)
} catch { settings.workbenchLayout = '{}' }
writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

console.log('seeded:', row.path)
console.log('vaults.json rows:', rows.length + 1)
console.log('settings.currentVaultId =', settings.currentVaultId)
