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
import { SETTINGS, resetKeysForTab, RESET_EXTRA_EXCLUDED } from '../../../src/lib/settings.ts'

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
const teachKeys = ['aiTeachRootDir', 'aiTeachDeleteSessionFolder']
check('AI 教学两项已从「模块设置」移到 AI 工具',
  teachKeys.every(k => meta[k]?.section === 'aiTools'), teachKeys.filter(k => meta[k]?.section !== 'aiTools').join(', '))
check('AI 教学两项都有 anchor 且都渲染了，且归属「教学」页签',
  teachKeys.every(k => !!meta[k]?.anchor && renderedAnchors.has(meta[k].anchor) && meta[k].aiTab === 'teach'))
check('视觉转写模型归属「模型 · 场景分配表」（它是第五个模型槽位，不在教学页放第二份控件）',
  meta.aiTeachVisionModel?.aiTab === 'models' && renderedAnchors.has('aiTeach.visionModel'))
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
  /function ChatTab[\s\S]*<AgentLoopGroup \/>/.test(toolsView) && /function AgentLoopGroup/.test(toolsView))
check('「模块设置」不再渲染 AI 教学', !read('src/modules/settings/views/ModulesView.tsx').includes('AiTeachingView'))

// ===== 6. 原型「28 项去向表」 =====
//
// 上一轮的真实教训：页签从 5 个重排成 6 个，但**每一项该去哪个页签**只存在于原型的
// 表格里（tmp/ai-settings-proto 的 MAP_ROWS），代码侧没有任何机制保证一致 ——
// 结果是生效了 5 项、错放了 6 项（流式/思考过程留在模型页、LibreOffice 没从模型页搬走、
// 月度上限的 aiTab 写着 tools 却渲染在"用量"页 ⇒ 设置搜索跳过去没有落点）。
// 所以把那张表钉成契约：**它就是"重排有没有按原型做"的判据**。
//
// PENDING：原型把它划给「场景分配表」，而那张表属第 3 刀 —— 列在这里是**可见的进度**，
// 不全绿但也不假装完成；第 3 刀落地后把对应项从这里删掉，断言就会自动变严。

console.log('\n[去向] 原型 28 项去向表')
const MAP_TO_TAB = {
  // 模型
  modelProviders: 'models', defaultChatModel: 'models', assistantModelId: 'models',
  aiAssistantInlineSuggestModelId: 'models', agentCompressModelId: 'models',
  aiFreeModelIds: 'models', llmMaxTokens: 'models',
  // 权限
  aiModulePermissions: 'perms', aiVaultFilePerm: 'perms', terminalAiExec: 'perms',
  // 工具
  aiSkillDisabled: 'tools', webCrawlMaxPages: 'tools', webCrawlDelayMs: 'tools', sofficePath: 'tools',
  // 用量
  aiToolMonthlyLimit: 'usage',
  // 对话
  aiStreamEnabled: 'chat', aiShowThinking: 'chat', aiAssistantPerception: 'chat', aiMascot: 'chat',
  ctxUsageDetail: 'chat', ctxWindow: 'chat', assistantThinking: 'chat',
  aiAssistantInlineSuggest: 'chat', aiAssistantInlineSuggestAuto: 'chat',
  agentMaxRounds: 'chat', agentRunTokenBudget: 'chat', agentContextBudgetTokens: 'chat',
  agentCompressionEnabled: 'chat', agentCompressAtPercent: 'chat',
  // 教学
  aiTeachRootDir: 'teach', aiTeachDeleteSessionFolder: 'teach',
  // 场景分配表的第五个槽位（原型 SCENE_LABEL 里有 vision；控件从教学页归位到这张表）
  aiTeachVisionModel: 'models',
}
// 第 3 刀已把下面这些全部归位，PENDING 清空 —— 留着这个集合是为了"下次还有半成品时
// 能诚实标出来"，而不是让它们假绿。
const PENDING = new Set([])

for (const [key, want] of Object.entries(MAP_TO_TAB)) {
  if (!meta[key]) { check(`原型表的 ${key} 在 SETTINGS 里存在`, false, '键已被删除或改名'); continue }
  const got = meta[key].aiTab
  if (PENDING.has(key)) {
    console.log(`  [PENDING] ${key}：原型划给「场景分配表」（第 3 刀），当前 aiTab=${got ?? '（未声明）'}`)
    continue
  }
  check(`${key} → ${want} 页签`, got === want, `实际 ${got ?? '（未声明）'}`)
}
// 两项原型标「不动」：从未进设置页的内部键，不该有 aiTab
for (const key of ['assistantWidth', 'learnProgress']) {
  check(`${key}（原型标「不动」）不应有 aiTab`, !meta[key]?.aiTab, `实际 ${meta[key]?.aiTab}`)
}

// ===== 7. 「复位」的范围（只动本页签；安全开关不参与） =====

console.log('\n[复位] 范围规则')
{
  const inScope = new Set()
  for (const t of EXPECTED_TABS) for (const k of resetKeysForTab(t)) inScope.add(k)

  // ★ 最关键的一条：安全边界不能被"恢复默认"顺手放开
  const dangerKeys = keys.filter(k => meta[k].level === 'danger')
  const leaked = dangerKeys.filter(k => inScope.has(k))
  check(`负向：${dangerKeys.length} 个 level:'danger' 的键都不在复位范围内`,
    leaked.length === 0, leaked.join(', '))
  check('已知的三个安全键确实都是 danger 级（否则上一条是空断言）',
    ['terminalAiExec', 'aiModulePermissions', 'aiVaultFilePerm'].every(k => meta[k]?.level === 'danger'))

  // 复位的范围只能是 aiTools 大项里、且声明了页签的项
  const stray = [...inScope].filter(k => meta[k].section !== 'aiTools' || !meta[k].aiTab)
  check('负向：复位范围不越界（都在 AI 大项内且声明了页签）', stray.length === 0, stray.join(', '))

  // 权限页：三个键全是安全开关 ⇒ 范围为空 ⇒ 界面上那个按钮必须置灰
  check('权限页的复位范围为空（本页只有安全开关）', resetKeysForTab('perms').length === 0,
    resetKeysForTab('perms').join(', '))
  check('模式页 / 工具页 / 对话页 / 用量页 / 教学页都有可复位的项',
    ['models', 'tools', 'chat', 'usage', 'teach'].every(t => resetKeysForTab(t).length > 0),
    ['models', 'tools', 'chat', 'usage', 'teach'].filter(t => resetKeysForTab(t).length === 0).join(', '))
  check('额外排除表当前为空（要排除就走 level:danger，别各写一处）', RESET_EXTRA_EXCLUDED.length === 0)

  // 视图接线：空范围要置灰 + 两步确认
  const view = read('src/modules/settings/views/AiToolsView.tsx')
  check('复位按钮在视图里', view.includes('恢复默认') && view.includes('resetKeysForTab'))
  check('复位是行内两步确认（不弹模态）', view.includes('再点一次：恢复默认') && view.includes('confirmReset'))
  check('范围为空时按钮置灰并说明原因', view.includes('resetKeys.length === 0'))
}

// ===== §8 文案减负（2026-10-13）=====
// 重排之后每节都挂一段常驻解释，整页读下来是散文。改造原则（docs/help-disclosure-pattern.md 形态 B）：
//   · 有信息量的说明 → SectionHead 悬停披露，**一字不删**；
//   · 复述句 / 开发者视角的理由 / 过期指路 / 历史括注 → 直接删。
// 这两条互为刹车：只查"少了段落"会纵容把说明删光，只查"有悬停"会纵容段落回来。
{
  console.log('\n[文案减负] 说明走悬停披露，界面不留开发者视角的话')
  const AI_VIEWS = ['AiModelsTab', 'AiToolsView', 'AiPermissionsTab', 'AiUsageTab', 'AiTeachingView', 'AiToolsAdvanced']
    .map(n => `src/modules/settings/views/${n}.tsx`)
  const views = AI_VIEWS.map(rel => ({ rel, text: read(rel) }))

  // ① 标题后不许紧跟常驻说明段（"标题 + 一段解释"正是噪音来源）
  //    例外：段首是插值的数据行（如 CC Switch 弹层的「来源：{path}」）不算说明文字。
  const INTRO_RE = /<\/h[23]>\s*\n\s*<p className="text-\[1[12][^"]*">\s*\n?([^\n]*)/g
  const inlineIntro = []
  for (const v of views) {
    INTRO_RE.lastIndex = 0
    let m
    while ((m = INTRO_RE.exec(v.text))) if (!m[1].includes('{')) inlineIntro.push(v.rel)
  }
  check('负向：标题后没有紧跟常驻说明段（一律走 SectionHead 悬停）', inlineIntro.length === 0, [...new Set(inlineIntro)].join(', '))

  // ② 披露组件确实在用（否则"减少噪音"可能是靠把说明删光换来的）
  //    2026-10-14：判据从「SectionHead 出现次数 ≥5」改成「每个视图都至少用了某个披露件」——
  //    改造后工具页/对话页整页由 SettingsGroup + HelpHint 组成，一个 SectionHead 也没有，
  //    按旧判据会把"换成了更合适的披露件"误判成"没有披露"（假 FAIL，且会诱导把 SectionHead 塞回去）。
  const DISCLOSURE = ['SectionHead', 'SettingsGroup', 'HelpHint']
  const noDisclosure = views.filter(v => !DISCLOSURE.some(d => v.text.includes(d))).map(v => v.rel)
  check('每个 AI 视图都用了披露件（SectionHead / SettingsGroup / HelpHint 至少其一）',
    noDisclosure.length === 0, noDisclosure.join(', '))

  // ③ 已删的文案不许回来
  const DEAD_COPY = [
    '都参与设置搜索',            // 折叠策略的内部理由（开发者视角）
    '本机搜索通道不可用',        // 给我自己看的核实备注
    '替代原来的"手填 ID 列表"',  // 历史沿革
    '原来的「压缩专用模型」',
    '对话输出',                  // 已改名的旧分区名（指路句已过期）
    '达到上限后调用将被拒绝',    // 已并进那一行标签
  ]
  const back = []
  for (const v of views) for (const s of DEAD_COPY) if (v.text.includes(s)) back.push(`${v.rel}: ${s}`)
  check('负向：已删文案没有回来（含开发者视角与过期指路）', back.length === 0, back.join(' | '))

  // ④ 两类必须常驻的文案不许被顺手收走：空态引导、不可逆风险警告
  check('空态仍常驻（尚未配置供应商）', read(AI_VIEWS[0]).includes('尚未配置供应商'))
  check('写入权限警告仍常驻（不可逆风险）', read(AI_VIEWS[2]).includes('直接生效'))
  check('终端执行"两道门"的关系仍在（收进悬停即可，别删）', read(AI_VIEWS[2]).includes('两道独立的门'))
}

// ===== §9 标签口径（2026-10-13 晚定，用户推翻上一轮的大白话替换）=====
// 口径：**标签用术语，说明用书面语** —— 这两个诉求针对的是两样东西，别再混着做。
// 口语叫法不删，留在 `SETTINGS[].keywords` 里当搜索别名。这条契约锁的就是
// 「术语没有被口语吃掉」+「别名没有被一起删掉」两件事。
{
  console.log('\n[标签口径] 术语做标签，口语做搜索别名')
  const TERMS = {
    llmMaxTokens: '单次 maxTokens 上限',
    agentMaxRounds: '最大推理轮数',
    agentRunTokenBudget: '单次 token 预算',
    agentContextBudgetTokens: '历史上下文预算',
    agentCompressAtPercent: '自动压缩触发线(%)',
    agentCompressionEnabled: '历史自动压缩',
  }
  // 别名给**完整**口语叫法：设置搜索按分词逐 token 打分，只留片段不足以保证命中。
  const ALIASES = {
    llmMaxTokens: '单次回复上限',
    agentMaxRounds: '单次任务最多思考几轮',
    agentRunTokenBudget: '单次任务花费上限',
    agentContextBudgetTokens: '带多少历史对话',
    agentCompressAtPercent: '用掉多少历史就触发总结',
    agentCompressionEnabled: '长对话先总结',
  }
  for (const [key, term] of Object.entries(TERMS)) {
    const meta = SETTINGS[key]
    check(`${key} 的标签是术语「${term}」`, meta?.label === term, String(meta?.label))
    check(`${key} 保留口语搜索别名「${ALIASES[key]}」`, (meta?.keywords ?? []).includes(ALIASES[key]), ALIASES[key])
  }
  // 视图里的可见标签也得是术语（settings.ts 与视图是两处手写字面量，容易只改一处）
  const chatView = read('src/modules/settings/views/AiToolsView.tsx')
  check('Agent 循环面板渲染术语标签', chatView.includes('最大推理轮数') && chatView.includes('历史自动压缩'))
  check('负向：面板里没有残留的口语标签', !chatView.includes('单次任务最多思考几轮') && !chatView.includes('带多少历史对话'))
  check('模型·高级渲染术语标签', read('src/modules/settings/views/AiModelsTab.tsx').includes('单次 maxTokens 上限'))
}

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
