#!/usr/bin/env node
/**
 * 看板插件控件基建契约（2026-09-28）—— 源码级断言，零依赖。
 *
 * 背景：底层基建 = 插件经 manifest `contributes.dashboardWidgets[]` 声明看板控件，
 * 主进程校验 + `plugin:listDashboardWidgets` 枚举 + 渲染层合并进看板卡片网格
 * （沙箱 iframe 复用 PluginFrame）。全局控件 id = `<pluginId>:<wid>`（与面板编辑器拍板口径一致）。
 *
 * 断言面：
 *  A. 主进程校验（pluginRegistry.ts）：wid 正则 / 去重 / title ≤20 / span 1-3 / 仅 ui 插件
 *  B. handler：只收 type==='ui' 且带 entry 的启用插件
 *  C. 接线：preload + ipc.ts 双侧 pluginListDashboardWidgets
 *  D. 渲染层：plugins-changed 订阅、`<pluginId>:<wid>` 拼接、Card 列跨度、卸载即消失
 *  E. 内置卡不受伤：CardBody 仍在、toggleCard 归一化保留插件 id
 */
import { readFileSync } from 'node:fs'

const ROOT = 'E:/Projects/KnowledgeRecorder'
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

const registry = read('electron/lib/pluginRegistry.ts')
const preload = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
const types = read('src/types/index.ts')
const index = read('src/modules/dashboard/index.tsx')
const cards = read('src/modules/dashboard/cards.tsx')

let pass = 0
const fails = []
const ok = (name, cond) => { if (cond) pass++; else fails.push(name) }

// ---- A. 主进程校验 ----
ok('A0 贡献白名单含 dashboardWidgets（漏了 = 一律拒装）', /KNOWN_CONTRIBUTIONS = \[[^\]]*'dashboardWidgets'/.test(registry))
ok('A1 dashboardWidgets 校验块存在', /key === 'dashboardWidgets'/.test(registry))
ok('A2 仅 ui 插件可声明', /dashboardWidgets 贡献仅 UI 插件\(type: ui\)可声明/.test(registry))
ok('A3 wid 正则断言', /typeof w\.wid !== 'string' \|\| !\/\^\[a-z0-9\]\[a-z0-9-\]\{0,39\}\$\/\.test\(w\.wid\)/.test(registry))
ok('A4 wid 去重', /重复的 wid/.test(registry))
ok('A5 title ≤20', /dashboardWidgets: title 缺失或过长\(≤20\)/.test(registry))
ok('A6 span 仅 1-3', /span 仅支持 1-3（列跨度）/.test(registry))

// ---- B. handler ----
ok('B1 handler 存在', /ipcMain\.handle\('plugin:listDashboardWidgets'/.test(registry))
ok('B2 只收 ui 插件 + entry', /plugin:listDashboardWidgets[\s\S]{0,800}?if \(m\.type !== 'ui' \|\| !m\.entry\) continue/.test(registry))
ok('B3 只收已启用插件', /plugin:listDashboardWidgets[\s\S]{0,300}?if \(!entry\.enabled\) continue/.test(registry))
ok('B4 span 缺省兜底 1', /span: typeof w\.span === 'number' && w\.span >= 1 && w\.span <= 3 \? w\.span : 1/.test(registry))

// ---- C. 接线 ----
ok('C1 preload 通道', /pluginListDashboardWidgets: \(\) => ipcRenderer\.invoke\('plugin:listDashboardWidgets'\)/.test(preload))
ok('C2 ipc 封装', /export const pluginListDashboardWidgets = \(\): Promise<PluginDashboardWidget\[\]> => a\(\)\.pluginListDashboardWidgets\(\)/.test(ipc))
ok('C3 类型导入', /PluginDashboardWidget/.test(ipc.split('from \'../types\'')[0] ?? ''))

// ---- D. 渲染层 ----
ok('D1 类型定义 + 全局 id 注释', /export interface PluginDashboardWidget \{[\s\S]{0,600}?`<pluginId>:<wid>`/.test(types))
ok('D2 usePluginWidgets 订阅 plugins-changed（保活面不重挂）', /function usePluginWidgets[\s\S]{0,600}?addEventListener\('plugins-changed', load\)/.test(index))
ok('D3 全局 id 拼接唯一出口', /const widgetIdOf = \(w: PluginDashboardWidget\) => `\$\{w\.pluginId\}:\$\{w\.wid\}`/.test(index))
ok('D4 插件卡显示条件 = 勾选 ∧ 清单在场', /widgets\.filter\(\(w\) => shown\.has\(widgetIdOf\(w\)\)\)/.test(index))
ok('D5 Card 列跨度落 grid gridColumn', /span && span > 1 \? \{ gridColumn: `span \$\{span\} \/ span \$\{span\}` \}/.test(cards))
ok('D6 插件卡走 PluginFrame 沙箱', /<PluginFrame pluginId=\{w\.pluginId\} entry=\{w\.entry\} grantedCapabilities=\{w\.granted\} \/>/.test(index))
ok('D7 编辑弹层有插件控件小节', /插件控件<\/div>/.test(index))

// ---- E. 内置卡不受伤 ----
ok('E1 toggleCard 归一化保留插件 id（不依赖异步清单）', /\.\.\.\[\.\.\.wanted\]\.filter\(\(v\) => !builtinIds\.has\(v\)\)/.test(index))
ok('E2 内置卡仍走 CardBody', /<CardBody def=\{c\} snap=\{snap\}/.test(index))
ok('E3 CARD_REGISTRY 未被动态污染（仍是静态清单）', /export const CARD_REGISTRY: readonly CardDef\[\] = \[/.test(cards))
ok('E4 插件分组色相已定义（HUE 完备性）', /plugin: 'var\(--accent\)'/.test(cards))

console.log(`verify-dashboard-widgets: ${pass} PASS, ${fails.length} FAIL`)
for (const f of fails) console.log(`FAIL ${f}`)
process.exit(fails.length > 0 ? 1 : 0)
