#!/usr/bin/env node
/**
 * 素材库上移工作区层（更新计划第 5 项 / v3.1.1）—— 结构契约静态断言。
 *
 * 为什么是静态断言而不是跑真函数：素材库全链路（layout/readMerged/promote）依赖
 * getCurrentVault() 与 Electron app 上下文，抽函数会连带撕出整条依赖链（与
 * verify-ai-schedule-tools.mjs 能抽纯函数的情况不同）；而本项最容易回归的是
 * 「接线缺失」类静默失败（漏传 prop / 漏注册 IPC / 建夹播种复活），静态契约恰好全覆盖。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-sources-workspace.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const src = read('electron/lib/aiTeachingSources.ts')
const folders = read('electron/lib/aiTeachingFolders.ts')
const renderer = read('src/modules/ai-teaching/index.tsx')
const types = read('src/types/index.ts')
const preload = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
const agent = read('electron/lib/agentService.ts')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}

// ---- 布局层：工作区级库 + 三级回退 ----
console.log('\n[布局层] aiTeachingSources.ts')
check('layout 支持 scope=workspace/session 双层', src.includes("scope: SourcesScope = 'workspace'") && src.includes("scope === 'workspace'"))
check('无会话三级回退：会话夹父目录 → lastWorkspaceId → 产物根', src.includes('listWorkspaces(getSetting).lastWorkspaceId') && src.includes('const wsRel = lastWs ? workspaceFolderRel(lastWs, getSetting) : null'))
check('工作区库路径 = {工作区层}/SOURCES/SOURCE.md', /dirRel = `\$\{p\.parentRel\}\/\$\{SOURCES_DIR\}`/.test(src))
check('readSources 返回 workspaceRel + sessionRel', /workspaceRel: ws\.fileRel, sessionRel: m\.conv\?\.fileRel \?\? null/.test(src))
check('空模板标注「工作区级·跨对话共用」', src.includes('（工作区级·跨对话共用）'))

// ---- 合并读与编号定位 ----
console.log('\n[合并读] 统一编号 1..N + locateByNo 反查')
check('readMerged 工作区在前、会话存量去重在后', src.includes("seen.add(key(e))") && src.includes('readMerged(sessionId, getSetting)'))
check('合并视图重编号', src.includes('flat.map((e, i) => ({ ...e, no: i + 1 }))'))
check('locateByNo 存在且按 origNo 取层内条目', src.includes('function locateByNo') && src.includes("hit.scope === 'workspace' ? m.ws : m.conv") && src.includes('e.no === hit.origNo'))
for (const fn of ['removeSource', 'extractRange', 'readSourceBytes', 'transcribeVision', 'webProbeSource', 'webCrawlSource']) {
  const at = src.indexOf(`export async function ${fn}`) >= 0 ? src.indexOf(`export async function ${fn}`) : src.indexOf(`export function ${fn}`)
  const body = at >= 0 ? src.slice(at, at + 1200) : ''
  check(`${fn} 经 locateByNo 定位`, body.includes('locateByNo(sessionId, no, getSetting)'))
}
check('空会话抓取有独立中止槽（不互误取消）', src.includes("'__workspace__'"))

// ---- 注入 ----
console.log('\n[AI 注入] resolveSourcesForInjection')
check('注入按层分组：工作区主库 + 本对话私有补充', src.includes('工作区素材库（跨对话共用') && src.includes('本对话私有补充'))
check('条目路径按所属层 dirRel 拼接', src.includes('**提取稿 ${e.dirRel}/'))
check('登记指引指向工作区主库并要求接最大编号 +1（合并编号不能直接改文件）', src.includes('编号接着文件内现有最大值 +1'))
check('dir 条目列解析后的 matAbs（非素材夹本身——回归修复）', src.includes('listDirFilesRecursive(matAbs, files)'))
check('dir 条目路径拼仓库相对前缀 + 仓库外守护', src.includes('const matRel = relative(rootPath, matAbs)') && src.includes("matRel.startsWith('..')"))

// ---- 存量上收 ----
console.log('\n[存量上收] promoteSessionSources')
check('上收复制原件与提取稿（源不动）', src.includes('function copyInto') && src.includes('promoteSessionSources'))
check('全部成功才清对话级登记；失败项保留可重试', src.includes('kept.length === 0') && src.includes('rewriteEntries(cl, kept)'))

// ---- 会话夹联动 ----
console.log('\n[会话夹联动] aiTeachingFolders.ts')
const createSeg = (() => {
  const at = folders.indexOf('export function ensureSessionFolder')
  const end = folders.indexOf('broadcastTreeRefresh(baseRel)', at)
  return at >= 0 && end > at ? folders.slice(at, end) : ''
})()
check('建夹不再播种对话级 SOURCES/SOURCE.md（登记收敛工作区主库）', createSeg.length > 0 && !createSeg.includes('sourceTemplateText(') && !createSeg.includes("join(baseAbs, 'SOURCES')"))
check('对话改名仍同步存量素材夹（合并读按夹名定位，不改会丢）', folders.includes("join(parentAbs, 'SOURCES', oldName)"))
check('删对话仍回收存量素材夹（跟随同一设置）', folders.includes('SOURCES/${rel.slice(lastSlash + 1)}'))

// ---- 渲染层 ----
console.log('\n[渲染层] index.tsx')
check('无对话也回读素材库（sid ?? 空 = 工作区主库）', renderer.includes('aiTeachSrcRead(sid ?? \'\')'))
check('记录对话级路径（上收入口的显隐依据）', renderer.includes('setSrcSessionRel(r.sessionRel ?? null)'))
check('卡片路径按条目所属层（e.dirRel 回退主库推导）', renderer.includes('e.dirRel || (srcFileRel'))
check('会话存量条目带「对话」角标', renderer.includes("e.scope === 'session' && ("))
check('「上收」按钮：有存量且有对话时出现', renderer.includes('{srcSessionRel && activeId && (') && renderer.includes('doPromoteSources()'))
check('doPromoteSources 调 aiTeachSrcPromote（确认弹窗保护）', renderer.includes('aiTeachSrcPromote(activeId)') && renderer.includes("'上收素材到工作区主库'"))
check('＋素材不再门控 activeId（未建对话也能登记）', !renderer.includes('{activeId && (\n                  <button onClick={() => {\n                    setSrcForm('))

// ---- IPC 四层 ----
console.log('\n[IPC] promote 四层接线')
check('主进程注册 aiTeachSrc:promote', src.includes("ipcMain.handle('aiTeachSrc:promote'"))
check('preload 暴露 aiTeachSrcPromote', preload.includes("aiTeachSrcPromote: (id: string) => ipcRenderer.invoke('aiTeachSrc:promote', id)"))
check('types 声明 aiTeachSrcPromote', types.includes('aiTeachSrcPromote: (id: string) => Promise<AiTeachSourcesResult>'))
check('ipc.ts 封装 aiTeachSrcPromote', ipc.includes('export const aiTeachSrcPromote'))
check('agentService 注入仍走 resolveSourcesForInjection', agent.includes('resolveSourcesForInjection(sessionId, getSettingReader())'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
