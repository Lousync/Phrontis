// 契约验证：书架「删除书籍」这条整本删除链（2026-09-23）
//
// 分工：本脚本验**静态接线**。这条链路几乎每一步漏了都**不报错**，只是留下垃圾或界面不动：
//   ① 五个 repo 出口在场 —— 少一个 = 那一类数据永远留在 `.knowbase/modules/*.json` 里，
//      用户看到的是「书删了，但摘录/书签还在，甚至点进去还能跳」
//   ② handler 七步 + 每步经 step() 包裹（收集错误而非中断）—— 中断式实现会让
//      「移回收站失败」连累后面所有清理，反过来「某步失败」又让整次删除报错但其实已删一半
//   ③ **文件先移回收站**（`trashWorkspacePath`，绝不 `rm`）—— 顺序反了会出现「元数据已清、
//      书文件还在 .books 里」的鬼影：书架扫不到（meta 没了）但资源管理器里看得见
//   ④ 广播四个 scope —— 漏一个 = 那个面板不刷新（铁律 1 / 18）
//   ⑤ IPC 三处同步：preload / types / ipc.ts
//   ⑥ UI 侧：右键菜单入口 + 危险态确认 + 吞噬动画 + `deletingRef` 防「广播把卡片提前抽走」
//   ⑦ 负向：整本删除不得走 `rm` / `unlink` 直接删书文件；不得删掉导出出的「读书笔记」页
//
// 运行（仓库根目录）：
//   node .AGENT/scripts/book-market/verify-book-delete.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const code = (rel) => stripComments(read(rel))

const REPO = 'electron/database/repositories/bookMarketRepo.ts'
const CORE = 'electron/lib/bookDelete.ts'
const SHELF = 'src/modules/bookshelf/index.tsx'
const PRELOAD = 'electron/preload/index.ts'
const TYPES = 'src/types/index.ts'
const IPC = 'src/lib/ipc.ts'

/** handler 体（`bookMarket:deleteBook` 到下一个 handler / 文件尾） */
const repo = code(REPO)
const hStart = repo.indexOf("ipcMain.handle('bookMarket:deleteBook'")
const hNext = hStart < 0 ? -1 : repo.indexOf('ipcMain.handle(', hStart + 10)
const handler = hStart < 0 ? '' : repo.slice(hStart, hNext < 0 ? undefined : hNext)
/** 业务核（七步清理真正实现的地方；抽出来是为了能被运行期探针直接调，见文件头注） */
const core = code(CORE)

/* ================= ① 五个 repo 出口 ================= */
console.log('\n--- ① repo 出口：五类数据各有一个整本删除入口 ---')
const EXPORTS = [
  ['electron/lib/kbStore/readerStateVaultRepo.ts', 'readerStateRemoveBook', '阅读进度 + txt/foliate 书签'],
  ['electron/lib/kbStore/pdfReaderVaultRepo.ts', 'pdfReaderRemoveBook', 'PDF 进度 + PDF 书签'],
  ['electron/lib/kbStore/pdfReaderVaultRepo.ts', 'pdfReaderCoverRemove', 'PDF 封面缓存（含 .covers 图片文件）'],
  ['electron/lib/kbStore/excerptVaultRepo.ts', 'excerptDeleteBook', '摘录'],
  ['electron/lib/kbStore/excerptExportVaultRepo.ts', 'excerptExportRemove', '导出映射'],
]
for (const [path, fn, what] of EXPORTS) {
  const src = code(path)
  check(`${path.split('/').pop()} 导出 ${fn}（${what}）`,
    new RegExp(`export function ${fn}\\(`).test(src))
  // 每个出口都必须过 requireCurrentRootId —— 否则「当前仓库已切走」时会把**别的仓库**的数据删掉
  const body = src.slice(src.indexOf(`export function ${fn}(`))
  check(`  ${fn} 校验当前仓库（requireCurrentRootId）`, /requireCurrentRootId\(rootId\)/.test(body.slice(0, 700)))
  check(`  ${fn} 走 writeJsonOrThrow 落盘（失败可上报，不静默）`, /writeJsonOrThrow\(/.test(body.slice(0, 1200)))
}

/* ================= ② 业务核：七步 + step 包裹 ================= */
console.log('\n--- ② 业务核（lib/bookDelete.ts）：七步 + 每步收集错误不中断 ---')
check('业务核存在且导出 deleteBookEverywhere', /export async function deleteBookEverywhere\(/.test(core))
check('★ 业务核不 import electron（否则运行期探针够不到 —— 见文件头注）',
  !/from 'electron'/.test(core))
check('有 step() 单步包装（收错误、不中断后续清理）',
  /const step = \(label: string[\s\S]{0,400}catch \(e\)/.test(core))
// 七个清理步骤，缺一即「那一类数据永远留在盘上」
const STEPS = ['元数据', '封面', '阅读进度', 'PDF 进度', 'PDF 封面缓存', '摘录', '导出映射']
for (const s of STEPS) {
  check(`清理步骤在场：${s}`, new RegExp(`step\\('${s}'`).test(core))
}
// 除「移回收站」（async 抛异常，单独 try/catch）外，其余一律走 step —— 裸调用会中断整条链
const bareCalls = ['bookMetaRemove', 'bookCoverDelete', 'readerStateRemoveBook', 'pdfReaderRemoveBook',
  'pdfReaderCoverRemove', 'excerptDeleteBook', 'excerptExportRemove'].filter((fn) => {
  const re = new RegExp(`${fn}\\(`, 'g')
  let m
  while ((m = re.exec(core)) !== null) {
    // 判据：调用点前面紧邻的必须是 `step('…', () => `（允许 `{ ` 起始的块体）
    if (!/step\('[^']*',\s*\(\)\s*=>\s*{?\s*$/.test(core.slice(Math.max(0, m.index - 60), m.index))) return true
  }
  return false
})
check('七个出口全部经 step() 调用（无裸调用）', bareCalls.length === 0, bareCalls.join(','))
check('返回值带 errors 列表（部分失败可如实上报）', /return\s*{\s*ok:\s*errors\.length === 0,\s*errors\s*}/.test(core))

/* ================= ③ 顺序：先取 meta → 再移回收站 → 再清理元数据 ================= */
console.log('\n--- ③ 顺序：先移回收站，再清元数据 ---')
const iMeta = core.indexOf('bookMetaGet(relPath)')
const iTrash = core.indexOf('trashWorkspacePath(rootId, relPath)')
const iMetaRm = core.indexOf("step('元数据'")
check('移回收站用 trashWorkspacePath（系统回收站，可撤销）', iTrash > -1)
check('★ 先 bookMetaGet 取封面引用（移走文件前必须拿到）', iMeta > -1 && iMeta < iTrash)
check('★ 移回收站先于清元数据（否则留下「扫不到但还在」的鬼影文件）', iTrash > -1 && iMetaRm > iTrash)
check('移回收站失败也收进 errors（不静默吞掉）',
  /try\s*{\s*await trashWorkspacePath\(rootId, relPath\)\s*}\s*catch[\s\S]{0,120}errors\.push/.test(core))

/* ================= ④ handler 只做转发 + 广播 ================= */
console.log('\n--- ④ handler：转发 + 广播四个 scope（铁律 1 / 18）---')
check('handler 转发给 deleteBookEverywhere（不自留实现）',
  /await deleteBookEverywhere\(String\(rootId \?\? ''\), String\(relPath \?\? ''\)\)/.test(handler))
check('handler 返回核的结果', /return r\b/.test(handler))
// 四个 scope 都必须是**这一处**广播出去的（少一个 = 那个面板删完书还显示着旧数据）
const SCOPES = ['pdfReader', 'knowledge', 'readerState', 'excerpt']
check('handler 内确有 broadcastDataChanged 调用', /broadcastDataChanged\(/.test(handler))
const scopeList = /for \(const s of \[([^\]]*)\]/.exec(handler)?.[1] ?? ''
const gotScopes = [...scopeList.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
check('★ 广播恰好覆盖 pdfReader / knowledge / readerState / excerpt 四个 scope',
  gotScopes.join(',') === SCOPES.slice().sort().join(','), `实得 [${gotScopes}]`)
check('负向：handler 不自造 data:notify 语义', !/data:notify/.test(handler))

/* ================= ⑤ IPC 三处同步 ================= */
console.log('\n--- ⑤ IPC 三处同步：preload / types / ipc.ts ---')
check('preload 转发 bookMarket:deleteBook',
  /bookMarketDeleteBook:[\s\S]{0,160}ipcRenderer\.invoke\(\s*'bookMarket:deleteBook'/.test(code(PRELOAD)))
check('types 声明 bookMarketDeleteBook 返回 { ok, errors }',
  /bookMarketDeleteBook:[\s\S]{0,160}Promise<\s*{\s*ok: boolean;\s*errors: string\[\]\s*}>/.test(code(TYPES)))
check('ipc.ts 封装 bookMarketDeleteBook', /export const bookMarketDeleteBook\s*=/.test(code(IPC)))

/* ================= ⑥ UI：入口 / 确认 / 动画 / 防抽卡 ================= */
console.log('\n--- ⑥ 书架 UI：右键入口 + 危险确认 + 吞噬动画 + 防提前抽卡 ---')
const shelf = code(SHELF)
check('右键菜单状态在场（ctxMenu）', /const \[ctxMenu, setCtxMenu\] = useState/.test(shelf))
check('卡片挂 onContextMenu 打开菜单', (shelf.match(/onContextMenu=\{\(e\) => \{ e\.preventDefault\(\); setCtxMenu\(/g) ?? []).length >= 2)
check('菜单项带 data-wb 锚点（探针按锚点找）', /data-wb="bookDeleteMenu"/.test(shelf))
check('★ 确认框走危险态（variant: danger）+ 明示不可恢复', /variant:\s*'danger'/.test(shelf) && /不可恢复/.test(shelf))
check('确认文案说明「读书笔记页面保留」（与实现一致，不让用户以为笔记也没了）', /读书笔记/.test(shelf))
check('★ 删除走 bookMarketDeleteBook（IPC），不自行拼写盘路径', /await bookMarketDeleteBook\(rootId, b\.relPath\)/.test(shelf))
check('动画类 kb-deleting / kb-done 在场', /kb-deleting/.test(shelf) && /kb-deleting kb-done/.test(shelf))
check('吞噬动画用 DeleteWipe', /<DeleteWipe\s*\/>/.test(shelf))
// ★ deletingRef：主进程写盘后会广播，load() 若直接把卡片抽走，动画就没得播（.kb-deleting 白挂）
check('★ deletingRef 在场（删除中的书不被广播提前抽走）', /deletingRef\.current\.add\(b\.relPath\)/.test(shelf))
check('★ load() 保留删除中的卡片', /deletingRef\.current\.has\(b\.relPath\)/.test(shelf))
check('★ finally 里清 deletingRef 并重拉（动画收尾后回到磁盘真相）',
  /finally\s*{[\s\S]{0,200}deletingRef\.current\.delete\(b\.relPath\)[\s\S]{0,200}void load\(\)/.test(shelf))
check('防重入：删除中的书再次触发直接返回', /deletingRef\.current\.has\(b\.relPath\)\)\s*return/.test(shelf))

/* ================= ⑦ 负向 ================= */
console.log('\n--- ⑦ 负向 ---')
// 整本删除绝不能直接 rm / unlink 书文件（必须经系统回收站）
check('★ 负向：业务核不出现 rm/unlinkSync 直接删书文件',
  !/\brm\(|rmSync\(|unlinkSync\(/.test(core))
check('★ 负向：业务核不写死绝对路径（一律 { rootId, relPath }，铁律 3）',
  !/[A-Za-z]:\\\\|\/Users\//.test(core))
// 导出映射删掉，但导出出的那篇「读书笔记」页面必须保留（正文归编辑器/知识库管）
check('★ 负向：不触碰「读书笔记」页面正文（只清映射）',
  !/读书笔记/.test(core) && /excerptExportRemove/.test(core))
// 书架不得自己动手删文件（渲染层不接触绝对路径）
check('★ 负向：书架 UI 不出现 fs / rm / unlink', !/\bunlinkSync\(|\brmSync\(|require\(['"]fs/.test(shelf))

/* ================= ⑧ 运行期探针在场（静态断言够不到的那几条） ================= */
console.log('\n--- ⑧ 运行期探针在场（防被静默删掉）---')
// 本脚本只验静态接线；「七步真把五处 JSON 清干净了吗」「笔记页真留住了吗」「书文件真进回收站了吗」
// 只有真跑才算数 —— 那三条的判据在下面这个探针里。它被删掉不会有任何报错，故在此钉一条。
const PROBE = '.AGENT/scripts/book-market/probe-book-delete.cjs'
let probeSrc = ''
try { probeSrc = read(PROBE) } catch { /* 缺失即 fail */ }
check(`运行期探针在场：${PROBE}`, probeSrc.length > 0)
check('  探针带重建命令（Electron 33 = Node 20，不能 strip-types，必须 esbuild 打包）',
  /esbuild tmp\/book-delete-probe-entry\.ts/.test(probeSrc))
check('★ 探针头注写明 --external:trash（省了它运行期报 Invalid URL，不是删书逻辑的问题）',
  /--external:trash/.test(probeSrc))
check('★ 探针头注写明仓库须按真实形态登记（否则路径守卫报「未授权的工作区」）',
  /registerWorkspaceHandlers/.test(probeSrc))
// 负向：探针不得碰用户真实数据目录（userData 必须在 app ready 前改到临时目录）
check('★ 负向：探针在 app ready 之前改 userData（不碰开发数据目录）',
  probeSrc.indexOf("app.setPath('userData'") < probeSrc.indexOf('app.whenReady'))

/* ================= 结果 ================= */
console.log('\n========================================')
if (pass) {
  console.log('✅ 删除书籍链路契约全部通过')
} else {
  console.log('❌ 有断言失败 —— 见上面的 fail 行')
}
process.exit(pass ? 0 : 1)
