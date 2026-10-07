// 契约验证：书市模块 UI 接线与书架收口（方案 §11.6 / S4）。
//
// 分工：`probe-s4-module.cjs` 验**行为**（真 electron：挂载、端到端上架、三态、队列控制）；
// 本脚本验**静态接线**——那些「漏了就静默降级」的东西：图标表缺一格渲染成空、模块根写
// `flex-1` 滚轮没反应（铁律 11）、少挂一条 `useDataChanged` 界面不刷新（铁律 18）、
// 渲染层自己再推一遍书名（本次收口要消掉的东西）。
//
// 锁的八类（编号对应方案 §11.6）：
//   ① 模块登记：APP_MODULES 四 flag + TabName + 编译期 satisfies
//   ② 整窗归属：WORKBENCH_TABBAR_EXCLUDED 含它；App.tsx 静态 import + case（负向：不在 lazy 里）
//   ③ 模块根与纪律：data-wb / h-full（非 flex-1）· 零 alert/confirm · 零 window.api 直用
//   ④ 图标六表齐（漏一格 = 界面空白，不报错）
//   ⑤ 动效纪律：零 @keyframes / 零 transition-all / 过渡白名单（唯一例外见 ui-animation-plan §E）
//   ⑥ 书架收口锁：bookshelf/ 零 bookDisplayName · DTO 三字段 · 渲染层零 meta 兜底
//   ⑦ 封面只读通道：四处齐 + 读取路径必经 bookCoverAbsPath（负向：没有第二处手拼 .covers）
//   ⑧ 代理单一写路径：模块零新 IPC，只读设置键 bookMarketProxy
//
// 运行（仓库根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/book-market/verify-book-market-ui.mjs
// 期望：全部 ok + exit=0

import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const code = (rel) => stripComments(read(rel))
const has = (rel, re) => re.test(code(rel))

const APP_MODULES = 'src/lib/appModules.ts'
const LAYOUT = 'src/lib/workbenchLayout.ts'
const APP = 'src/App.tsx'
const TYPES = 'src/types/index.ts'
const IPC = 'src/lib/ipc.ts'
const PRELOAD = 'electron/preload/index.ts'
const SCHEMA = 'electron/lib/kbStore/bookMarketSchema.ts'
const META_REPO = 'electron/lib/kbStore/vaultBookMetaRepo.ts'
const BM_REPO = 'electron/database/repositories/bookMarketRepo.ts'
const MOD_DIR = 'src/modules/bookmarket'
const SHELF_DIR = 'src/modules/bookshelf'

/** 模块源码全集（静态断言逐文件跑，「铁律 21 同文件禁并行改」那类问题也就顺带被看见） */
const moduleFiles = walkSourceFiles(join(ROOT, MOD_DIR))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => f.replace(/\\/g, '/'))
const modRel = moduleFiles.map((f) => relative(ROOT.replace(/\\/g, '/'), f).replace(/\\/g, '/'))
const modSrc = new Map(modRel.map((r) => [r, stripComments(readFileSync(join(ROOT, r), 'utf8'))]))

/* ================= ① 模块登记 ================= */
console.log('\n--- ① 模块登记（appModules 唯一真相源） ---')
const modBlock = code(APP_MODULES)
check('APP_MODULES 有 bookMarket 条目', /id:\s*'bookMarket'/.test(modBlock))
const bmLine = (modBlock.match(/^.*id:\s*'bookMarket'.*$/m) ?? [''])[0]
for (const flag of ['bar', 'tile', 'palette']) {
  check(`bookMarket ${flag}: true（与工具箱/插件平级）`, new RegExp(`${flag}:\\s*true`).test(bmLine), bmLine.trim().slice(0, 90))
}
check('模块清单仍是编译期可校验的（as const satisfies 在位）', /as const satisfies/.test(modBlock))
check('TabName 联合含 bookMarket', /TabName[\s\S]{0,4000}?'bookMarket'/.test(code(TYPES)))

/* ================= ② 整窗归属 ================= */
console.log('\n--- ② 整窗独占模块归属 ---')
check('WORKBENCH_TABBAR_EXCLUDED 含 bookMarket（整窗独占 = 不登记文档标签）',
  /WORKBENCH_TABBAR_EXCLUDED[^=]*=\s*\[[^\]]*'bookMarket'/.test(code(LAYOUT)))
const appSrc = code(APP)
check('App.tsx 有 case \'bookMarket\'', /case\s+'bookMarket'\s*:/.test(appSrc))
check('App.tsx 用**静态** import 引入书市（铁律 20 的 lazy 只点名引擎类）',
  /import\s*\{\s*BookMarketModule\s*\}\s*from\s*'\.\/modules\/bookmarket'/.test(appSrc))
check('负向：书市不在 lazy( 里（不与 monaco/pdfjs 同待遇）',
  !/lazy\([^)]*bookmarket/i.test(appSrc), '命中 lazy(…bookmarket…)')

/* ================= ③ 模块根与纪律 ================= */
console.log('\n--- ③ 模块根 h-full / 零 alert / 零 window.api 直用 ---')
const rootSrc = modSrc.get(`${MOD_DIR}/index.tsx`) ?? ''
const rootTag = (rootSrc.match(/<div[^>]*data-wb="bookMarket"[^>]*>/) ?? [''])[0]
check('模块根带 data-wb="bookMarket"（探针契约）', !!rootTag, rootTag.slice(0, 80))
check('模块根 h-full（铁律 11：槽位容器是块级 div，flex-1 在里面是死属性 ⇒ 滚轮没反应）',
  /className="[^"]*\bh-full\b/.test(rootTag), rootTag.slice(0, 120))
check('负向：模块根没有用 flex-1 顶替 h-full', !/className="[^"]*\bflex-1\b/.test(rootTag))
for (const [rel, src] of modSrc) {
  if (/[^.\w]alert\s*\(/.test(src)) check(`零 alert()：${rel}`, false)
  if (/[^.\w]confirm\s*\(/.test(src)) check(`零 confirm()：${rel}`, false)
  if (/\bwindow\.api\b/.test(src)) check(`零 window.api 直用（一律走 src/lib/ipc.ts）：${rel}`, false)
}
check('全模块零 alert / confirm / window.api 直用', true, `${modRel.length} 个文件`)

/* ================= ④ 图标六表 ================= */
console.log('\n--- ④ 图标表覆盖（漏一格 = 界面空白，不报错） ---')
const tables = [
  ['图标 id 联合 IconModuleId', 'src/lib/sidebarIcons.tsx', /IconModuleId[\s\S]{0,600}'bookMarket'/],
  ['经典图标映射', 'src/lib/sidebarIcons.tsx', /bookMarket:\s*[A-Z]\w*/],
  ['手绘包 HAND_DRAWN', 'src/components/shared/ModuleIcons.tsx', /bookMarket:\s*\w+/],
  ['StyleAware 导出 BookMarketIcon', 'src/components/shared/ModuleIcons.tsx', /export function BookMarketIcon/],
  ['页面条 TAB_ICONS', 'src/components/workbench/WorkbenchPageBar.tsx', /bookMarket:\s*</],
  ['桌面磁贴 TILE_META', 'src/modules/desktop/tiles.tsx', /bookMarket:\s*\{/],
  ['活动栏 RAIL_BUTTONS', 'src/components/shared/ActivityBar.tsx', /id:\s*'bookMarket'/],
]
for (const [label, rel, re] of tables) check(label, has(rel, re), rel)

/* ================= ⑤ 动效纪律 ================= */
console.log('\n--- ⑤ 动效纪律（铁律 13：只用既定令牌，不另造过渡） ---')
// 白名单：颜色反馈（.kb-micro-pop 语义）/ transform / opacity / 进度条填充（§E 已认可的唯一例外）。
// 新增一类过渡必须**先补基建 + 更新 docs/ui-animation-plan.md**，再把这里放开。
const TRANSITION_OK = /^transition-(colors|transform|opacity|none|\[width\])$/
const offenders = []
for (const [rel, src] of modSrc) {
  if (/@keyframes/.test(src)) offenders.push(`${rel}: @keyframes`)
  if (/transition-all/.test(src)) offenders.push(`${rel}: transition-all`)
  for (const m of src.matchAll(/\btransition-[\w[\]-]+/g)) {
    if (!TRANSITION_OK.test(m[0])) offenders.push(`${rel}: ${m[0]}`)
  }
  // 进度条填充是唯一动 width 的地方，且必须同时是「determinate 进度条」写法
  for (const m of src.matchAll(/transition-\[width\][^"'`]*/g)) {
    if (!/duration-\d+\s+ease-linear/.test(m[0])) offenders.push(`${rel}: transition-[width] 缺 duration-*/ease-linear`)
  }
}
check('零 @keyframes / 零 transition-all / 过渡全在白名单内', offenders.length === 0, offenders.join(' · '))
check('动效令牌真源在全局 CSS（.kb-drawer-in 随本模块补入）', has('src/styles/index.css', /\.kb-drawer-in\s*\{/))

/* ================= ⑥ 书架收口锁 ================= */
console.log('\n--- ⑥ 书架书名收口（S4 拍板 ①②） ---')
const shelfFiles = walkSourceFiles(join(ROOT, SHELF_DIR)).filter((f) => /\.tsx?$/.test(f))
const shelfLeak = shelfFiles
  .map((f) => [f.replace(/\\/g, '/'), stripComments(readFileSync(f, 'utf8'))])
  .filter(([, src]) => /\bbookDisplayName\s*\(/.test(src))
  .map(([f]) => relative(ROOT.replace(/\\/g, '/'), f).replace(/\\/g, '/'))
check('bookshelf/ 下 bookDisplayName( 零次（展示名只由主进程 DTO 一次性定死）', shelfLeak.length === 0, shelfLeak.join(','))
const listItemBlock = (code(TYPES).match(/interface BookListItem[\s\S]*?\n\}/) ?? [''])[0]
check('BookListItem 有 displayName / author / coverRef 三字段',
  /\bdisplayName:\s*string/.test(listItemBlock) && /\bauthor:\s*string/.test(listItemBlock) && /\bcoverRef:\s*string/.test(listItemBlock))
// 渲染层不许再把 meta 兜底拼一遍（那是本次要收掉的东西，漏一处就出现两套书名）。
// 范围刻意只圈「读书名的三处」——全仓扫会命中 help/docsLoader.ts 的文档 frontmatter，
// 那跟书 meta 毫无关系，把它算进来的断言只会逼下一个人写豁免清单。
const TITLE_SCOPE = [`${SHELF_DIR}`, MOD_DIR, `${APP}`]
const rendererLeak = TITLE_SCOPE
  .flatMap((p) => (p.endsWith('.tsx') ? [join(ROOT, p)] : walkSourceFiles(join(ROOT, p))))
  .filter((f) => /\.tsx?$/.test(f))
  .filter((f) => /meta\?\.title|meta\.title\s*\|\|/.test(stripComments(readFileSync(f, 'utf8'))))
  .map((f) => relative(ROOT.replace(/\\/g, '/'), f).replace(/\\/g, '/'))
check('书架 / 书市 / App 零 meta?.title 兜底写法', rendererLeak.length === 0, rendererLeak.join(','))
check('DTO 层真的读了 .meta.json（bookMetaReadAll + bookMetaKey）',
  /bookMetaReadAll\(/.test(code('electron/database/repositories/pdfReaderRepo.ts')) &&
  /bookMetaKey\(/.test(code('electron/database/repositories/pdfReaderRepo.ts')))
check('BookCover 有 coverRef 分支（书市封面走只读通道，不落库、不缓存）',
  /coverRef/.test(code(`${SHELF_DIR}/BookCover.tsx`)) && /bookMarketCoverGet/.test(code(`${SHELF_DIR}/BookCover.tsx`)))

/* ================= ⑦ 封面只读通道 ================= */
console.log('\n--- ⑦ coverGet 通道：四处齐 + 路径守卫唯一 =================')
check('通道 ↔ preload', /ipcRenderer\.invoke\('bookMarket:coverGet'/.test(code(PRELOAD)))
check('通道 ↔ ElectronAPI', /bookMarketCoverGet\s*:/.test(code(TYPES)))
check('通道 ↔ ipc.ts 包装', /export const bookMarketCoverGet/.test(code(IPC)))
check('通道 ↔ 主进程 handler', /ipcMain\.handle\(\s*'bookMarket:coverGet'/.test(code(BM_REPO)))
check('读取路径必经 bookCoverAbsPath（内含 isSafeCoverRel：只认 .covers 下单层文件名）',
  /bookCoverAbsPath\(/.test(code(META_REPO)) &&
  /const p = bookCoverAbsPath\(coverRel\)/.test(code(META_REPO)))
check('负向：main 里没有第二处手拼 .covers 路径', (() => {
  const hits = walkSourceFiles(join(ROOT, 'electron'))
    .filter((f) => /\.ts$/.test(f))
    .map((f) => [f.replace(/\\/g, '/'), stripComments(readFileSync(f, 'utf8'))])
    .filter(([, src]) => /['"`]\.books\/\.covers/.test(src))
    .map(([f]) => relative(ROOT.replace(/\\/g, '/'), f).replace(/\\/g, '/'))
  return hits.length === 1 && hits[0].endsWith('bookMarketSchema.ts')
})())

/* ================= ⑧ 代理单一写路径 ================= */
console.log('\n--- ⑧ 代理：只走设置机制，不开新 IPC ---')
// 注意 `setProxy` 是本模块一个 **React state setter**（设置里的代理输入框），不是 session API ——
// 断言只能认 `.setProxy(`（带点），裸 `setProxy(` 会把输入框判成违规。
const proxyWrite = modRel.filter((r) => /\.setProxy\s*\(|\bipcRenderer\b/.test(modSrc.get(r) ?? ''))
check('模块内零 session.setProxy / 零 ipcRenderer 直用', proxyWrite.length === 0, proxyWrite.join(','))
const proxyChannel = ['bookMarketSetProxy', 'bookMarketProxy:set']
const proxyHits = [PRELOAD, TYPES, IPC, BM_REPO].filter((rel) => proxyChannel.some((c) => code(rel).includes(c)))
check('全链路无代理写通道（代理是设置，不是 IPC）', proxyHits.length === 0, proxyHits.join(','))
check('模块里出现的是设置键 bookMarketProxy', modRel.some((r) => /bookMarketProxy/.test(modSrc.get(r) ?? '')))
check('设置项真源在 src/lib/settings.ts', /bookMarketProxy\s*:/.test(code('src/lib/settings.ts')))
check('主进程 applyBookMarketProxy 只作用于书市 session partition', has('electron/lib/bookMarket/netSession.ts', /setProxy/))

/* ================= 结尾 ================= */
const files = moduleFiles.filter((f) => existsSync(f)).length
console.log(`\n  模块文件 ${files} 个：${modRel.map((r) => r.replace(`${MOD_DIR}/`, '')).join(', ')}`)
console.log('\n========================================')
if (pass) {
  console.log('✅ 书市 UI 接线与书架收口契约全部通过')
  process.exit(0)
}
console.log('❌ 有断言失败 —— 见上面的 fail 行')
process.exit(1)
