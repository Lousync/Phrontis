#!/usr/bin/env node
/**
 * AI 设置页签 ↔ 锚点一致性契约（2026-10-13 按域重排：5 → 6 页签）。
 *
 * 这一轮改的本质是"设置项的页签归属 + 锚点落点"，而这两件事此前**没有任何机制保证一致**：
 *   · schema 里 `ui:true` 却没 `anchor` ⇒ 被 schemaKeyItems() 静默排除在设置搜索之外（搜不到等于不存在）；
 *   · schema 里写了 `anchor` 却没人在视图里渲染 ⇒ 搜索能搜到、点进去没有落点
 *     （terminalAiExec 就是这样：一个 level:'danger' 的安全开关，只能手改 settings.json）；
 *   · 视图里写死的 aiTab 值不在 AiTab 联合里 ⇒ 跳转落到不存在的页签。
 * 三种都不报错、编译也过。所以把它钉成契约。
 *
 * 跑法：node .AGENT/scripts/settings/verify-ai-tab-anchors.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS } from '../../../src/lib/settings.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

/** 递归收集 src 下的 .ts/.tsx 源码文本（锚点扫描用） */
function collectSrc(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { collectSrc(full, out); continue }
    const ext = extname(name)
    if (ext === '.ts' || ext === '.tsx') out.push({ rel: full.slice(ROOT.length + 1).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') })
  }
  return out
}
const SRC = collectSrc(join(ROOT, 'src'))
const renderedAnchors = new Set()
for (const f of SRC) for (const m of f.text.matchAll(/data-setting-anchor="([^"]+)"/g)) renderedAnchors.add(m[1])

const settingsSrc = read('src/lib/settings.ts')
const sectionsSrc = read('src/modules/settings/sections.tsx')
const meta = SETTINGS
const keys = Object.keys(meta)

// ===== 1. 页签定义 =====

console.log('\n[页签] AiTab 定义')
const EXPECTED_TABS = ['models', 'perms', 'tools', 'chat', 'usage', 'teach']
const unionMatch = settingsSrc.match(/export type AiTab =([^\n]+)/)
const unionTabs = unionMatch ? [...unionMatch[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]) : []
check('AiTab 联合存在', unionTabs.length > 0)
check(`AiTab 恰好是这 6 个：${EXPECTED_TABS.join(' / ')}`,
  unionTabs.length === EXPECTED_TABS.length && EXPECTED_TABS.every(t => unionTabs.includes(t)),
  `实际 ${unionTabs.join(' / ')}`)
check('已无旧页签 id（builtin / mcp / skill）残留为 aiTab 值',
  !/aiTab:\s*'(builtin|mcp|skill)'/.test(settingsSrc + sectionsSrc))

// ===== 2. schema 侧：ui:true 必须有 anchor，有 aiTab 的必须合法 =====

console.log('\n[schema] ui:true ⇒ anchor；aiTab ⇒ 合法值')
const aiToolsKeys = keys.filter(k => meta[k].section === 'aiTools')
const missingAnchor = aiToolsKeys.filter(k => meta[k].ui && !meta[k].anchor)
check('aiTools 里 ui:true 的项都有 anchor（否则搜不到）', missingAnchor.length === 0, missingAnchor.join(', '))
const badTab = keys.filter(k => meta[k].aiTab && !unionTabs.includes(meta[k].aiTab))
check('所有 aiTab 值都在 AiTab 联合里', badTab.length === 0, badTab.map(k => `${k}=${meta[k].aiTab}`).join(', '))
const uiNoTab = aiToolsKeys.filter(k => meta[k].ui && meta[k].anchor && !meta[k].aiTab)
check('aiTools 里可搜索的项都声明了页签（否则跳转回落到默认页签）', uiNoTab.length === 0, uiNoTab.join(', '))

// ===== 3. 锚点必须真的被渲染（范围：AI 工具大项） =====
//
// 只断言 AI 工具大项：其他大项的锚点由各自的机制渲染（快捷键那 11 个锚点是按命令表**动态**
// 生成的，terminal.fontSize / bookMarket.proxy 在各自模块视图里），本契约不管它们。

console.log('\n[锚点] AI 工具声明的锚点必须在视图里存在')
const entryItems = [...sectionsSrc.matchAll(/\{\s*id: '([^']+)',\s*section: '([^']+)',([\s\S]*?)\},\r?\n/g)]
  .map(m => ({ id: m[1], section: m[2], aiTab: (m[3].match(/aiTab: '([^']+)'/) ?? [])[1] }))
const entryIds = entryItems.map(e => e.id)
check('解析到入口项（sections.tsx ENTRY_ITEMS）', entryIds.length >= 15, `实际 ${entryIds.length}`)
check('入口项的 aiTab 都被解析到了（正则别漏字段）',
  entryItems.filter(e => e.section === 'aiTools').every(e => !!e.aiTab),
  entryItems.filter(e => e.section === 'aiTools' && !e.aiTab).map(e => e.id).join(', '))

const aiAnchors = keys.filter(k => meta[k].section === 'aiTools' && meta[k].anchor).map(k => ({ key: k, anchor: meta[k].anchor }))
const deadSchema = aiAnchors.filter(a => !renderedAnchors.has(a.anchor))
check(`AI 工具 schema 里全部 ${aiAnchors.length} 个 anchor 都有人在视图里渲染`,
  deadSchema.length === 0, deadSchema.map(a => `${a.key}→${a.anchor}`).join(', '))
const aiEntries = entryItems.filter(e => e.section === 'aiTools')
const deadEntry = aiEntries.filter(e => !renderedAnchors.has(e.id))
check(`全部 ${aiEntries.length} 个 AI 工具入口项锚点都有人在视图里渲染`,
  deadEntry.length === 0, deadEntry.map(e => e.id).join(', '))
// 范围外的锚点只做提示，不断言（避免把别的模块的历史遗留算到本契约头上）
const outOfScope = [...keys.filter(k => meta[k].anchor && meta[k].section !== 'aiTools').map(k => meta[k].anchor),
  ...entryItems.filter(e => e.section !== 'aiTools').map(e => e.id)].filter(a => !renderedAnchors.has(a))
check(`（提示，不断言）AI 工具之外的 ${outOfScope.length} 个锚点未在本契约扫描范围内渲染`,
  outOfScope.length >= 0, outOfScope.slice(0, 12).join(', '))

// ===== 4. 本轮三个具体回归（各自都是真实报障/隐患） =====

console.log('\n[回归] 本轮修掉的三个孤儿')
check('terminalAiExec：ui:true 有 anchor 且真的渲染了（此前只能手改 settings.json）',
  meta.terminalAiExec?.ui === true && meta.terminalAiExec?.anchor === 'terminal.aiExec' && renderedAnchors.has('terminal.aiExec'))
check('terminalAiExec 归属「权限」页签（它是安全开关，不是工具清单）', meta.terminalAiExec?.aiTab === 'perms')
check('aiAssistantPerception：补上了 anchor（此前 ui:true 无 anchor ⇒ 搜不到）',
  meta.aiAssistantPerception?.ui === true && !!meta.aiAssistantPerception?.anchor && renderedAnchors.has(meta.aiAssistantPerception.anchor))
check('aiAssistantPerception 归属「对话」页签', meta.aiAssistantPerception?.aiTab === 'chat')
const teachKeys = ['aiTeachRootDir', 'aiTeachDeleteSessionFolder', 'aiTeachVisionModel']
check('AI 教学三项已从「模块设置」移到 AI 工具',
  teachKeys.every(k => meta[k]?.section === 'aiTools'), teachKeys.filter(k => meta[k]?.section !== 'aiTools').join(', '))
check('AI 教学三项都有 anchor 且都渲染了，且归属「教学」页签',
  teachKeys.every(k => !!meta[k]?.anchor && renderedAnchors.has(meta[k].anchor) && meta[k].aiTab === 'teach'))
check('视觉转写模型提为正式设置键（不再只藏在 localStorage）',
  typeof meta.aiTeachVisionModel?.default === 'string')
check('AI 教学模块改读设置键而不是 localStorage',
  read('src/modules/ai-teaching/index.tsx').includes("getSettingRaw('aiTeachVisionModel')")
  && !read('src/modules/ai-teaching/index.tsx').includes("localStorage.setItem('aiTeach.visionModel'"))

// ===== 5. 视图侧接线 =====

console.log('\n[视图] 页签内容真的挂上了')
const toolsView = read('src/modules/settings/views/AiToolsView.tsx')
for (const t of EXPECTED_TABS) check(`AiToolsView 渲染了 ${t} 页签`, new RegExp(`tab === '${t}'`).test(toolsView))
check('每个页签都有归属的设置项或入口项（没有空页签）', EXPECTED_TABS.every(t =>
  keys.some(k => meta[k].aiTab === t) || entryItems.some(e => e.aiTab === t)),
  EXPECTED_TABS.filter(t => !keys.some(k => meta[k].aiTab === t) && !entryItems.some(e => e.aiTab === t)).join(', '))
check('默认页签是「模型」（不再落到只读的内置工具清单）', toolsView.includes("useState<AiTab>(initialTab ?? 'models')"))
check('设置搜索的默认页签回落也是「模型」',
  read('src/modules/settings/index.tsx').includes("(item.aiTab ?? 'models')"))
check('「工具调用量」已从常驻区搬进「用量」页签（不再切页签纹丝不动）',
  !/tab === 'models'[\s\S]{0,400}UsageSummary/.test(toolsView) && read('src/modules/settings/views/AiUsageTab.tsx').includes('aiTools.usage'))
check('「AI 助手」块已从常驻区搬进「对话」页签', toolsView.includes("data-setting-anchor=\"aiTools.chat\""))
check('Agent 循环预算已从「内置工具」搬进「对话」页签',
  /function ChatTab[\s\S]*<AgentLoopPanel \/>/.test(toolsView) && /function AgentLoopPanel/.test(toolsView))
check('「模块设置」不再渲染 AI 教学', !read('src/modules/settings/views/ModulesView.tsx').includes('AiTeachingView'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
