// 契约验证：摘录导出知识库闭环（v3.5.0 第 5 项 · 施工方案 C）。
//
// 覆盖：
//   ① excerptExportSchema 纯函数用例（键口径 == excerptKey / md 结构 / 每条恰好一个 kbloc 链接 /
//      无 kbloc 之外的协议 / 分组 / 幂等 upsert）
//   ② 负向：excerptExports.json 单写方（只允许出现在 excerptExportVaultRepo.ts）
//   ③ IPC 三处同步：excerpt:exportNote / excerpt:exportEntry 在 preload / types / ipc.ts 均有声明
//   ④ C2 硬约束（源码断言）：覆盖重写**只换 body、不重建 frontmatter**（保住页面 id），
//      且不走 knowledge:updatePage（该通道明确只支持重命名）
//   ⑤ C4 单点拦截：MarkdownPreview 在委托 onLinkClick **之前**拦下 kbloc:；事件常量 + App 侧监听齐备
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-excerpt-export.mjs

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// ===== ① excerptExportSchema 纯函数用例 =====
console.log('\n--- ① excerptExportSchema：键口径 / md 结构 / 幂等 upsert ---')
const X = await import('../../../electron/lib/kbStore/excerptExportSchema.ts')
const S = await import('../../../electron/lib/kbStore/excerptSchema.ts')

// 键口径必须与 excerptKey 逐字一致（同一本书的「摘录键」= 「导出键」）
for (const [rootId, relPath] of [['r1', '.books/a.pdf'], ['r1', '.books\\a.txt'], ['', 'a.txt'], ['r1', '/a.txt'], ['r1', './x/y.pdf']]) {
  check(`键口径与 excerptKey 一致（${JSON.stringify(rootId)} + ${JSON.stringify(relPath)}）`, X.exportKey(rootId, relPath) === S.excerptKey(rootId, relPath), X.exportKey(rootId, relPath))
}
check('键反解', X.exportKeyRel('r1/.books/a.pdf') === '.books/a.pdf')
check('键反解：无分隔返回空串', X.exportKeyRel('nokey') === '')

// 造几条样本摘录
const mk = (o) => ({ id: o.id, kind: o.kind, page: o.page, paraIndex: o.paraIndex, cfi: o.cfi, chapter: o.chapter, text: o.text, note: o.note ?? '', color: o.color ?? 'y', type: o.type ?? 'excerpt', at: 'AT', updatedAt: 'UP' })
const pdfs = [
  mk({ id: 'e1', kind: 'pdf', page: 3, text: '第一页的引文', note: '这页很关键', color: 'g', type: 'excerpt' }),
  mk({ id: 'e2', kind: 'pdf', page: 3, text: '同页第二条', color: 'b', type: 'idea' }),
  mk({ id: 'e3', kind: 'pdf', page: 12, text: '跨页引文', type: 'highlight' }),
]
const mdPdf = X.buildExcerptExportMarkdown({ rootId: 'r1', relPath: '.books/书.pdf', bookName: '书', excerpts: pdfs, exportedAt: '2026-09-21T10:00:00.000Z' })
check('md 标题含书名', mdPdf.startsWith('# 读书笔记 · 《书》'))
check('md 说明行含条数与日期', mdPdf.includes('共 3 条摘录') && mdPdf.includes('2026-09-21'))
check('pdf 按页分组（升序：第 3 页在前、第 12 页在后）', mdPdf.indexOf('## 第 3 页') > -1 && mdPdf.indexOf('## 第 3 页') < mdPdf.indexOf('## 第 12 页'))
check('引文为 markdown 引用块', mdPdf.includes('> 第一页的引文'))
check('备注有则出', mdPdf.includes('备注：这页很关键'))
check('无备注的条目不出现空备注行', !mdPdf.includes('备注：\n'))
check('类型 / 颜色以纯文本呈现', mdPdf.includes('摘录 · 绿') && mdPdf.includes('想法 · 蓝') && mdPdf.includes('高亮 · 黄'))
check('每条摘录恰好一个 kbloc 链接', (mdPdf.match(/kbloc:/g) || []).length === pdfs.length, `实际 ${(mdPdf.match(/kbloc:/g) || []).length}`)
check('链接形如 kbloc:<bookKey>#<excerptId>', mdPdf.includes('(kbloc:r1/.books/书.pdf#e1)') && mdPdf.includes('(kbloc:r1/.books/书.pdf#e3)'))
check('md 不含 kbloc 之外的协议（无 http/https/file/javascript）', !/https?:|file:|javascript:|data:/i.test(mdPdf))
check('md 不含 HTML 标签（纯文本呈现）', !/<[a-z/][^>]*>/i.test(mdPdf))

// txt 分组：连续段区间合并 + 断点分段
const txts = [
  mk({ id: 't1', kind: 'txt', paraIndex: 2, text: 'A', color: 'p', type: 'excerpt' }),
  mk({ id: 't2', kind: 'txt', paraIndex: 3, text: 'B' }),
  mk({ id: 't3', kind: 'txt', paraIndex: 9, text: 'C' }),
]
const mdTxt = X.buildExcerptExportMarkdown({ rootId: 'r1', relPath: '.books/文.txt', bookName: '文', excerpts: txts, exportedAt: '2026-09-21T10:00:00.000Z' })
check('txt 连续段合并为区间（第 3–4 段）', mdTxt.includes('## 第 3–4 段'), mdTxt.split('\n').filter((l) => l.startsWith('## ')).join(' / '))
check('txt 断点另起一组（第 10 段）', mdTxt.includes('## 第 10 段'))
check('txt 单段不带区间符', !mdTxt.includes('第 10–10 段'))

// ★ 阶段 2a：foliate 系（epub / fb2 / fbz）按章节分组 —— 三者走同一条分支
//   （落到 txt 分支会按 paraIndex 排序，而 foliate 系摘录根本没有 paraIndex ⇒ 全被当 0
//    合并成一组「## 第 1 段」，不报错、只是导出结果看着不对）
for (const k of ['epub', 'fb2', 'fbz']) {
  const foliate = [
    mk({ id: `${k}1`, kind: k, chapter: '第一章', cfi: 'epubcfi(/6/4!/4/2/1:0)', text: '第一章引文', color: 'v', type: 'excerpt' }),
    mk({ id: `${k}2`, kind: k, chapter: '第二章', cfi: 'epubcfi(/6/8!/4/2/1:0)', text: '第二章引文' }),
  ]
  const md = X.buildExcerptExportMarkdown({ rootId: 'r1', relPath: `.books/书.${k}`, bookName: '书', excerpts: foliate, exportedAt: '2026-09-22T10:00:00.000Z' })
  check(`${k} 按章节分组（## 第一章 / ## 第二章，不补「页」「段」量词）`,
    md.includes('## 第一章') && md.includes('## 第二章'))
  check(`${k} 不被当 txt 并成「第 1 段」`, !md.includes('## 第 1 段'), md.split('\n').filter((l) => l.startsWith('## ')).join(' / '))
  check(`${k} 每条一个 kbloc 链接`, (md.match(/kbloc:/g) || []).length === 2)
}
// 无 chapter 的 foliate 摘录统一归「正文」（不丢条目）
{
  const noChap = [mk({ id: 'n1', kind: 'fb2', cfi: 'epubcfi(/6/4!/4/2/1:0)', text: '无章节名' })]
  const md = X.buildExcerptExportMarkdown({ rootId: 'r1', relPath: '.books/书.fb2', bookName: '书', excerpts: noChap, exportedAt: '2026-09-22T10:00:00.000Z' })
  check('fb2 无 chapter 时回落「## 正文」且条目不丢', md.includes('## 正文') && md.includes('无章节名'))
}

// ★ 阶段 2b：cbz 走兜底分支（平铺一组、不套任何量词模板）。
//   实情是 cbz **生成不出摘录**（固定版式无文本层，excerptSchema 显式拒绝），这一组数据
//   正常不会出现；用例留着是为了锁住「万一出现了，兜底也不撒谎」——不补「页」「段」量词，
//   也不按 paraIndex 排序（cbz 那字段恒 undefined，会全被当 0 并成「第 1 段」）。
{
  const comic = [
    mk({ id: 'c1', kind: 'cbz', text: '画集第一页说明' }),
    mk({ id: 'c2', kind: 'cbz', text: '画集第二页说明' }),
  ]
  const md = X.buildExcerptExportMarkdown({ rootId: 'r1', relPath: '.books/画集.cbz', bookName: '画集', excerpts: comic, exportedAt: '2026-09-22T10:00:00.000Z' })
  const heads = md.split('\n').filter((l) => l.startsWith('## ')).join(' / ')
  check('cbz 兜底：平铺一组「## 正文」，不补「页」「段」量词', md.includes('## 正文') && !/## 第 /.test(md), heads)
  check('cbz 兜底：不并成「第 1 段」（paraIndex 恒 undefined，套 txt 模板即错）', !md.includes('## 第 1 段'))
  check('cbz 兜底：条目不丢（每条一个 kbloc 链接）', (md.match(/kbloc:/g) || []).length === 2)
}

// 空摘录：只出标题与说明，不产出 kbloc
const mdEmpty = X.buildExcerptExportMarkdown({ rootId: 'r1', relPath: 'a.txt', bookName: 'a', excerpts: [], exportedAt: '2026-09-21T10:00:00.000Z' })
check('空摘录：不产出 kbloc 链接', !mdEmpty.includes('kbloc:'))
check('空摘录：仍出标题', mdEmpty.startsWith('# 读书笔记 · 《a》'))

// 幂等 upsert：同一 key 重复写只保留一条（不新增条目）
const e1 = { pageId: 'p1', pagePath: '收件箱/x.md', exportedAt: 'T1', count: 2 }
const e2 = { pageId: 'p1', pagePath: '收件箱/x.md', exportedAt: 'T2', count: 5 }
let store = X.emptyExportStore()
store = X.applyExportEntry(store, 'r1/.books/a.pdf', e1)
store = X.applyExportEntry(store, 'r1/.books/a.pdf', e2)
check('upsert：重复导出不新增条目（键数仍为 1）', Object.keys(store.books).length === 1, `实际 ${Object.keys(store.books).length}`)
check('upsert：后写覆盖 count/exportedAt', store.books['r1/.books/a.pdf'].count === 5 && store.books['r1/.books/a.pdf'].exportedAt === 'T2')
check('upsert：不 mutate 入参（纯函数）', (() => { const base = X.emptyExportStore(); const next = X.applyExportEntry(base, 'k', e1); return Object.keys(base.books).length === 0 && next !== base })())
check('不同书各占一条', Object.keys(X.applyExportEntry(store, 'r1/.books/b.txt', e1).books).length === 2)

// ===== ② 负向：excerptExports.json 单写方 =====
console.log('\n--- ② 负向：excerptExports.json 唯一写方 ---')
{
  const offenders = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
        const src = readFileSync(p, 'utf8')
        if (stripComments(src).includes('excerptExports.json') && !p.replaceAll('\\', '/').endsWith('electron/lib/kbStore/excerptExportVaultRepo.ts')) offenders.push(p)
      }
    }
  }
  walk(join(ROOT, 'electron'))
  walk(join(ROOT, 'src'))
  check('excerptExports.json 只出现在 excerptExportVaultRepo.ts', offenders.length === 0, offenders.join(', '))
}

// ===== ③ IPC 三处同步 =====
console.log('\n--- ③ IPC 三处同步：preload / types / ipc.ts ---')
{
  const preload = stripComments(read('electron/preload/index.ts'))
  const types = stripComments(read('src/types/index.ts'))
  const ipc = stripComments(read('src/lib/ipc.ts'))
  for (const ch of ['excerpt:exportNote', 'excerpt:exportEntry']) {
    check(`preload 桥含 ${ch}`, preload.includes(`'${ch}'`))
  }
  check('types 声明 ExcerptExportEntry', types.includes('interface ExcerptExportEntry'))
  check('types 声明 excerptExportNote / excerptExportEntry', /excerptExportNote:/.test(types) && /excerptExportEntry:/.test(types))
  check('ipc.ts 封装 excerptExportNote / excerptExportEntry', /export const excerptExportNote/.test(ipc) && /export const excerptExportEntry/.test(ipc))
  check('主进程 handler 注册两通道', /ipcMain\.handle\('excerpt:exportNote'/.test(stripComments(read('electron/database/repositories/excerptRepo.ts'))))
}

// ===== ④ C2 硬约束：覆盖重写只换 body（保住页面 id） =====
console.log('\n--- ④ C2 硬约束：只换 body，不重建 frontmatter ---')
{
  const kv = stripComments(read('electron/lib/kbStore/knowledgeVaultRepo.ts'))
  const i = kv.indexOf('export function vaultExportExcerptsNote')
  check('vaultExportExcerptsNote 存在', i > -1)
  if (i > -1) {
    const next = kv.indexOf('\nexport function ', i + 10)
    const body = kv.slice(i, next > -1 ? next : i + 2000)
    check('函数体内只替换 doc.body', /doc\.body\s*=\s*contentMd/.test(body))
    check('保留原 frontmatter 序列化（serializeMarkdown(doc.frontmatter, …)）', /serializeMarkdown\(\s*doc\.frontmatter/.test(body))
    check('★ 不生成新 id（不含 randomUUID）', !/randomUUID/.test(body))
    check('页面不存在时返回 null（交给自愈分支）', /if\s*\(\s*!entry\s*\)\s*return null/.test(body))
    check('写后失效索引（invalidateKnowledgeIndex）', /invalidateKnowledgeIndex\(\)/.test(body))
  }
  const repo = stripComments(read('electron/lib/kbStore/excerptExportVaultRepo.ts'))
  check('★ 未把 knowledge:updatePage 当覆盖写入口（它只支持重命名）', !repo.includes('knowledge:updatePage'))
  check('自愈分支：页面不在时走 vaultCreatePage 新建', repo.includes('vaultCreatePage('))
  check('导出后回写映射（applyExportEntry）', repo.includes('applyExportEntry('))
}

// ===== ⑤ C4 单点拦截：kbloc: 必须拦在 openExternal 之前 =====
console.log('\n--- ⑤ C4：kbloc: 在 MarkdownPreview 单点拦截 + App 侧路由 ---')
{
  const mp = stripComments(read('src/components/shared/MarkdownPreview.tsx'))
  const iKb = mp.indexOf('/^kbloc:/i')
  const iDeleg = mp.indexOf('onLinkClick(href)')
  const iOpen = mp.indexOf('window.api.openExternal(href)')
  check('MarkdownPreview 拦截 kbloc: 链接', iKb > -1)
  check('★ 拦截位置早于 onLinkClick 委托', iKb > -1 && iDeleg > -1 && iKb < iDeleg, `kbloc@${iKb} deleg@${iDeleg}`)
  check('★ 拦截位置早于 openExternal 默认分支', iKb > -1 && iOpen > -1 && iKb < iOpen, `kbloc@${iKb} open@${iOpen}`)
  const ev = read('src/components/shared/pdf/pdfEvents.ts')
  check('事件常量 KB_OPEN_EXCERPT_LOC 存在', /export const KB_OPEN_EXCERPT_LOC\s*=\s*'kb-open-excerpt-loc'/.test(ev))
  check('MarkdownPreview 派发该事件', mp.includes('KB_OPEN_EXCERPT_LOC'))
  const app = stripComments(read('src/App.tsx'))
  check('App 监听该事件并解析 kbloc:', app.includes('KB_OPEN_EXCERPT_LOC') && /\^kbloc:/.test(app))
  check('App 侧派发 KB_PDF_GOTO_PAGE / KB_TXT_GOTO_PARA 回原文', app.includes('KB_PDF_GOTO_PAGE') && app.includes('KB_TXT_GOTO_PARA'))
  check('右栏导出入口带锚点 data-wb="excerptExportBtn"', read('src/components/workbench/ReadingSidePanel.tsx').includes('data-wb="excerptExportBtn"'))
}

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)
