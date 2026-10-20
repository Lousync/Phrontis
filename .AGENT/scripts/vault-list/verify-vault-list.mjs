#!/usr/bin/env node
/**
 * 契约：仓库列表管理（从列表移除 / 删除仓库文件夹）。
 *
 * 这条链路的失败模式都很安静：
 *   - `ws:forget` 只删 vaults.json、不删 settings.json.recentVaults ⇒ 重启后 loadVaults
 *     自愈把仓库又加回来，表象是「删了又出现」；
 *   - 允许把**当前仓库**只从列表移除 ⇒ currentVaultId 指向未登记仓库，重启自愈再复活；
 *   - 「删除仓库」误写成只删列表 ⇒ 用户以为文件没了，实际还在（或反过来）；
 *   - UI 用了 alert/confirm（全仓禁项）或没做行内二次确认。
 *
 * 做法：剥注释后扫源码（这些 handler 依赖 electron，没法切片执行）。
 *
 * 运行：node .AGENT/scripts/vault-list/verify-vault-list.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
const raw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
const fails = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fails.push(name + (detail ? `  → ${detail}` : '')); console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ''}`) }
}

const WM = read('electron/lib/workspaceManager.ts')
const SWITCHER = read('src/components/shared/VaultSwitcher.tsx')
const PICKER = read('src/components/shared/VaultPicker.tsx')
const TYPES = read('src/types/index.ts')
const PRELOAD = read('electron/preload/index.ts')

console.log('=== A. 主进程：从列表移除（保留文件夹） ===')

check('A1 ws:forget 同时清 roots / vaults.json / recentVaults',
  /ws:forget'[\s\S]{0,400}?roots\.delete\(rootId\)[\s\S]{0,200}?removeVault\(rootId\)[\s\S]{0,200}?forgetRecentVault\(rootId\)/.test(WM))
check('A2 ws:forget 拒绝当前仓库（否则重启自愈复活）',
  /ws:forget'[\s\S]{0,400}?getCurrentVault\(\)[\s\S]{0,200}?cur\.rootId === rootId[\s\S]{0,300}?return \{ ok: false, error:/.test(WM))
check('A3 拒绝文案说明了替代路径（切换 / 删除）',
  /当前仓库不能只从列表移除/.test(WM) && /删除仓库/.test(WM))

console.log('\n=== B. 主进程：删除仓库（整仓进回收站） ===')

check('B1 ws:deleteVault 过 isAllowedClearRoot 护栏', /ws:deleteVault'[\s\S]{0,400}?isAllowedClearRoot\(r\.rootPath\)/.test(WM))
check('B2 删除走 trashVaultFolder（不是 rm/rmSync 直删）', /ws:deleteVault'[\s\S]{0,500}?await trashVaultFolder\(r\.rootPath\)/.test(WM))
check('B3 删除后移除登记 + 墓碑 + 清当前仓库', /ws:deleteVault'[\s\S]{0,900}?removeVault\(rootId\)[\s\S]{0,300}?markRecentDeleted\(rootId\)[\s\S]{0,500}?setCurrentVault\(null\)/.test(WM))
check('B4 删除当前仓库时返回 deletedCurrent（渲染层据此回选择页）',
  /ws:deleteVault'[\s\S]{0,1200}?deletedCurrent: wasCurrent/.test(WM))

console.log('\n=== C. 启动自愈仍保留（删除墓碑 / 最近列表第二注册表） ===')

check('C1 loadVaults 仍从 recentVaults 自愈（含墓碑复活）',
  /readRecentVaults\(true\)/.test(WM) && /clearRecentDeleted\(rv\.rootId\)/.test(WM))
check('C2 自愈只在目录存在且含 .knowbase 时回登记',
  /readRecentVaults\(true\)[\s\S]{0,500}?existsSync\(rv\.path\)[\s\S]{0,200}?\.knowbase/.test(WM))

console.log('\n=== D. 渲染层：VaultSwitcher 列表管理 ===')

check('D1 切换器接入 workspaceForget / workspaceDeleteVault',
  /workspaceForget/.test(SWITCHER) && /workspaceDeleteVault/.test(SWITCHER))
check('D2 切换器有「从列表移除」与「删除仓库文件夹」入口',
  /从列表移除/.test(SWITCHER) && /删除仓库文件夹/.test(SWITCHER))
check('D3 切换器删除前有行内二次确认（移入回收站按钮）',
  /移入回收站/.test(SWITCHER) && /confirm === 'trash'/.test(SWITCHER))
check('D4 切换器对当前仓库隐藏「从列表移除」',
  /rootId !== cur\?\.rootId/.test(SWITCHER))
check('D5 切换器删除当前仓库后整窗重载回选择页',
  /deletedCurrent[\s\S]{0,300}?location\.reload\(\)/.test(SWITCHER))

console.log('\n=== E. 渲染层：VaultPicker 列表管理 ===')

check('E1 选择页接入 workspaceForget / workspaceDeleteVault',
  /workspaceForget/.test(PICKER) && /workspaceDeleteVault/.test(PICKER))
check('E2 选择页有「从列表移除」与「删除仓库文件夹」入口',
  /从列表移除/.test(PICKER) && /删除仓库文件夹/.test(PICKER))
check('E3 选择页删除前有行内二次确认（移入回收站按钮）',
  /移入回收站/.test(PICKER) && /confirm === 'trash'/.test(PICKER))
check('E4 选择页对当前仓库隐藏「从列表移除」',
  /rootId !== curId/.test(PICKER))
check('E5 选择页删除当前仓库后整窗重载回选择页',
  /deletedCurrent[\s\S]{0,300}?location\.reload\(\)/.test(PICKER))

console.log('\n=== F. 反向：不弹中央模态 / 类型与桥接一致 ===')

check('F1 两个列表组件都不用 alert()/confirm()',
  !/\balert\s*\(/.test(SWITCHER) && !/\bwindow\.confirm\s*\(/.test(SWITCHER)
  && !/\balert\s*\(/.test(PICKER) && !/\bwindow\.confirm\s*\(/.test(PICKER))
check('F2 workspaceForget 类型允许回传 error', /workspaceForget: \(rootId: string\) => Promise<\{ ok: boolean; error\?: string \}>/.test(TYPES))
check('F3 preload 仍转发 ws:forget / ws:deleteVault',
  /invoke\('ws:forget'/.test(PRELOAD) && /invoke\('ws:deleteVault'/.test(PRELOAD))
check('F4 两个列表都有 hover 才出现的「管理」按钮（不挤占主点击区）',
  /group-hover:opacity-100/.test(SWITCHER) && /group-hover:opacity-100/.test(PICKER))

// 防止误删注释里的说明后契约失效：原文（不剥注释）也应含用户文案
check('F5 用户文案保留（删除仓库文件夹…）', /删除仓库文件夹…/.test(raw('src/components/shared/VaultPicker.tsx')))

console.log('\n========================================')
if (fails.length) {
  console.log(`FAIL —— ${pass}/${pass + fails.length} 断言通过`)
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
} else {
  console.log(`PASS —— ${pass} 项断言全绿`)
}
