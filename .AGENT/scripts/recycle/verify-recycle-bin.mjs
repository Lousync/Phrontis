#!/usr/bin/env node
/**
 * 回收站契约（2026-10-27，3.14.1）。
 *
 * 这一轮修的是「回收站看起来没用」的四类静默问题：
 *   ① 范围：模块只收结构化模块数据，文件删除在系统回收站 —— UI/帮助文档必须说清楚；
 *   ② 恢复后刷新：主进程恢复写盘后必须 broadcastDataChanged，否则源模块停在旧列表；
 *   ③ 角标：图标条要能拿到待恢复条目数，且在增删/恢复后更新；
 *   ④ 安全：说说移入系统回收站时附件不能留在 attachments_trash 成为孤儿；
 *      「全部移入」必须先移成功再清索引，不能先清后移。
 *
 * 跑法（仓库根目录）：
 *   node .AGENT/scripts/recycle/verify-recycle-bin.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `  -- ${extra}` : ''}`) }
}

console.log('\n[类型] DataChangeScope 双侧')
const dataChanged = read('src/lib/dataChanged.ts')
check("DataChangeScope 含 'recycle'", /DataChangeScope\s*=[^;]*'recycle'/.test(dataChanged))
check("DataChangeScope 含 'moments'", /DataChangeScope\s*=[^;]*'moments'/.test(dataChanged))

console.log('\n[主进程] 回收站广播与计数')
const repo = read('electron/database/repositories/recycleBinRepo.ts')
check('recycleBinAdd 写盘后广播 recycle', /recycleBinAdd[\s\S]{0,600}broadcastDataChanged\('recycle'\)/.test(repo))
const restoreItemBlock = repo.slice(repo.indexOf("ipcMain.handle('recycleBin:restoreItem'"), repo.indexOf("ipcMain.handle('recycleBin:restorePartial'"))
check('恢复条目恢复所属模块 + recycle', restoreItemBlock.includes('broadcastDataChanged(scope)') && restoreItemBlock.includes("broadcastDataChanged('recycle')"))
const restorePartialBlock = repo.slice(repo.indexOf("ipcMain.handle('recycleBin:restorePartial'"), repo.indexOf('function spliceFromSnapshot'))
check('局部恢复广播 knowledge + recycle', restorePartialBlock.includes("broadcastDataChanged('knowledge')") && restorePartialBlock.includes("broadcastDataChanged('recycle')"))
check('有 recycleBin:count 供图标角标使用', repo.includes("ipcMain.handle('recycleBin:count'"))
check('emptyAll 先 trashAll 再清索引（不先清后移）', /emptyAll[\s\S]{0,800}await trashAll\(items\)[\s\S]{0,200}writeBin\(\[\]\)/.test(repo))
const recycleBroadcasts = (repo.match(/broadcastDataChanged\('recycle'\)/g) ?? []).length
check('recycle 广播覆盖增删/恢复/清空（≥ 7 处）', recycleBroadcasts >= 7, `实得 ${recycleBroadcasts}`)

console.log('\n[主进程] 说说附件与标题')
const trash = read('electron/lib/trashFiles.ts')
check('trashFiles 引用附件回收区路径', trash.includes('getVaultTrashRoot'))
check("trashFiles 有 moments 分支", trash.includes("item.module === 'moments'"))
check('trashFiles 把附件目录一起移入系统回收站', trash.includes('...extraTrash'))
const momentsRepo = read('electron/database/repositories/momentsRepo.ts')
check('说说回收站标题取正文摘要（不再固定「单机说说」）', momentsRepo.includes('content_md') && !momentsRepo.includes("title: '单机说说'"))

console.log('\n[渲染层] 回收站模块文案与角标')
const ui = read('src/modules/recycle/index.tsx')
check('保留天数读 settings 而非写死 30', ui.includes('recycleBinRetentionDays') && !ui.includes('将在 30 天后自动清空'))
check('X 按钮文案是「移入系统回收站」，不是「永久删除」', ui.includes('移入系统回收站') && !ui.includes('永久删除'))
check('操作有 Toast 反馈', ui.includes('showToast'))
check('全部移入有两段式确认', ui.includes('emptyArmed') && ui.includes('确认全部移入'))
const activity = read('src/components/shared/ActivityBar.tsx')
check('图标条拉取回收站计数', activity.includes('getRecycleBinCount'))
check("图标条订阅 recycle 广播", /useDataChanged\(\s*'recycle'/.test(activity))
check('图标条有待恢复项小圆点', activity.includes('recycleCount > 0'))
const momentsUi = read('src/modules/moments/index.tsx')
check("说说模块订阅 moments 广播", /useDataChanged\(\s*'moments'/.test(momentsUi))

console.log('\n[通信面] preload / ipc / 类型')
check('preload 暴露 getRecycleBinCount', read('electron/preload/index.ts').includes("getRecycleBinCount: () => ipcRenderer.invoke('recycleBin:count')"))
check('渲染层 ipc 封装 getRecycleBinCount', read('src/lib/ipc.ts').includes('getRecycleBinCount'))
check('ElectronAPI 类型有 getRecycleBinCount', /getRecycleBinCount:\s*\(\)\s*=>\s*Promise<number>/.test(read('src/types/index.ts')))

console.log('\n[帮助文档] 文件删除在系统回收站')
const common = read('resources/help/常见问题.md')
const tree = read('resources/help/工作台左栏与文件树模式.md')
const modules = read('resources/help/模块一览.md')
const quick = read('resources/help/快速上手.md')
check('常见问题区分软件内 / 系统回收站', common.includes('系统回收站') && common.includes('只收博客'))
check('文件树说明文件删除去系统回收站', tree.includes('系统回收站'))
check('模块一览说明回收站不是文件回收站', modules.includes('不是文件回收站'))
check('快速上手区分模块删除 / 文件删除', quick.includes('系统回收站'))
check('旧口径「删除一律进回收站模块」已消失', !tree.includes('删除一律进**回收站**模块'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
if (fail > 0) process.exit(1)
