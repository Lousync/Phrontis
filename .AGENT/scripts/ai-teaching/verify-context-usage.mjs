#!/usr/bin/env node
/**
 * 契约验证：AI 教学「上下文用量明细」纯函数（`electron/lib/aiTeachContextUsagePure.ts`）
 *
 * 锁什么：
 *  1. 旧 5 字段（systemChars / constraintChars / profileChars / sourcesChars / ruleChars）口径不变；
 *  2. 新 7 字段是 systemFull 的**互斥分区**：分类和 === systemFull.length（不重不漏）；
 *  3. messages / toolsDef 不在 systemFull 内，按各自真实序列化长度计；
 *  4. 字符 → token → 百分比 / 剩余空间：任何输入都不出负数，分类和不超过真实已用；
 *  5. 无注入 / 未设窗口 / 已用超窗 三种降级不崩；
 *  6. **双端一致性**：`electron/lib/aiTeachContextUsagePure.ts`（主进程）与
 *     `src/lib/contextUsagePure.ts`（渲染层）的标签 / 顺序 / 口径 / 输出逐行相等
 *     —— 两份实现是刻意复制，任一单边改动必须被这里拦住。
 *
 * 运行（仓库根目录）：node .AGENT/scripts/ai-teaching/verify-context-usage.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

async function loadStripped(relPath, tmpName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-teach-usage-'))
  const tmpFile = path.join(tmpDir, tmpName)
  fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
  const mod = await import(pathToFileURL(tmpFile).href)
  return { mod, tmpDir }
}

const { mod: usage, tmpDir: usageTmp } = await loadStripped(
  'electron/lib/aiTeachContextUsagePure.ts',
  'aiTeachContextUsagePure.mjs',
)
// 渲染层镜像（src/lib/contextUsagePure.ts；只 import type，strip 后零依赖）
const { mod: usageUi, tmpDir: usageUiTmp } = await loadStripped(
  'src/lib/contextUsagePure.ts',
  'contextUsagePure.mjs',
)
// 段内台账纯函数（分层断言：台账必须走请求级，不能进 system 分区）
const { mod: ledgerPure, tmpDir: ledgerTmp } = await loadStripped(
  'electron/lib/teachLedgerPure.ts',
  'teachLedgerPure.mjs',
)

const {
  CHARS_PER_TOKEN,
  CONTEXT_USAGE_CATEGORIES,
  SYSTEM_SIDE_FIELDS,
  buildInjectionStats,
  buildContextUsage,
  estimateTokensFromChars,
  scaleTokensToBudget,
  sumClassifiedSystemChars,
} = usage

const REP = (n, s) => s.repeat(n)

// 合成一份「有内容」的真实形状注入：各段长度互不相同，便于发现串段 / 漏段。
const PARTS = {
  systemPrompt: REP(120, 'S'),
  constraintsRaw: REP(60, 'C'),
  scopeInjected: REP(80, 'Q'),
  repoRules: REP(40, 'R'),
  favorites: REP(20, 'F'),
  sources: REP(50, 'M'),
  profile: REP(30, 'P'),
  course: REP(70, 'U'),
  skillList: REP(35, 'K'),
  explicitSkill: REP(15, 'E'),
  toolsHint: REP(45, 'T'),
  protocols: REP(200, 'G'),
  scopeRule: REP(25, 'A'),
  writeScope: REP(55, 'B'),
  permissions: REP(65, 'D'),
  runtime: REP(75, 'V'),
  messagesJson: REP(500, 'J'),
  toolsJson: REP(1500, 'X'),
}
// systemFull = 7 个分区字段覆盖到的 15 段（顺序不影响长度断言）
PARTS.systemFull = [
  PARTS.systemPrompt,
  PARTS.scopeInjected,
  PARTS.repoRules,
  PARTS.favorites,
  PARTS.sources,
  PARTS.profile,
  PARTS.course,
  PARTS.skillList,
  PARTS.explicitSkill,
  PARTS.toolsHint,
  PARTS.protocols,
  PARTS.scopeRule,
  PARTS.writeScope,
  PARTS.permissions,
  PARTS.runtime,
].join('')

const stats = buildInjectionStats(PARTS)

console.log('\n=== 1. buildInjectionStats：旧 5 字段口径不变 ===')
check('systemChars = buildSystemPrompt 长度', stats.systemChars === PARTS.systemPrompt.length, String(stats.systemChars))
check('constraintChars = 四层原始正文合计', stats.constraintChars === PARTS.constraintsRaw.length, String(stats.constraintChars))
check('profileChars = 三层画像长度', stats.profileChars === PARTS.profile.length, String(stats.profileChars))
check('sourcesChars = 素材 / 来源长度', stats.sourcesChars === PARTS.sources.length, String(stats.sourcesChars))
check(
  'ruleChars = 12 段教学规则（protocols + 范围 + 落点）',
  stats.ruleChars === PARTS.protocols.length + PARTS.scopeRule.length + PARTS.writeScope.length,
  String(stats.ruleChars),
)

console.log('\n=== 2. 新字段：互斥分区，和 === systemFull.length ===')
check('messagesChars 在 systemFull 之外', stats.messagesChars === PARTS.messagesJson.length, String(stats.messagesChars))
check('toolsDefChars 在 systemFull 之外', stats.toolsDefChars === PARTS.toolsJson.length, String(stats.toolsDefChars))
check('toolsListChars = 扩展工具提示', stats.toolsListChars === PARTS.toolsHint.length, String(stats.toolsListChars))
check('skillChars = 清单 + 显式指定', stats.skillChars === PARTS.skillList.length + PARTS.explicitSkill.length, String(stats.skillChars))
check(
  'workspaceChars = 要求注入 + 仓库规则 + 收藏 + 取材 + 落点',
  stats.workspaceChars === PARTS.scopeInjected.length + PARTS.repoRules.length + PARTS.favorites.length + PARTS.scopeRule.length + PARTS.writeScope.length,
  String(stats.workspaceChars),
)
check('ledgerChars = 画像 + 课程台账', stats.ledgerChars === PARTS.profile.length + PARTS.course.length, String(stats.ledgerChars))
check(
  'capabilityChars = 协议 + 权限 + 运行期',
  stats.capabilityChars === PARTS.protocols.length + PARTS.permissions.length + PARTS.runtime.length,
  String(stats.capabilityChars),
)
check('SYSTEM_SIDE_FIELDS 恰好 7 段', SYSTEM_SIDE_FIELDS.length === 7, String(SYSTEM_SIDE_FIELDS.length))
check('★ 7 段分区和 === systemFull.length（不重不漏）', sumClassifiedSystemChars(stats) === PARTS.systemFull.length, `${sumClassifiedSystemChars(stats)} vs ${PARTS.systemFull.length}`)
check('7 段分区和 <= systemFull + messages + tools（总上限）', sumClassifiedSystemChars(stats) + stats.messagesChars + stats.toolsDefChars <= PARTS.systemFull.length + PARTS.messagesJson.length + PARTS.toolsJson.length, '')

console.log('\n=== 3. 空注入 / 缺字段降级 ===')
const empty = buildInjectionStats({})
check('空输入不抛错且旧字段为 0', empty.systemChars === 0 && empty.constraintChars === 0 && empty.ruleChars === 0, JSON.stringify(empty))
check('空输入新字段全 0', empty.messagesChars === 0 && empty.toolsDefChars === 0 && empty.ledgerChars === 0 && empty.capabilityChars === 0, JSON.stringify(empty))
check('空输入分区和为 0', sumClassifiedSystemChars(empty) === 0, '')
check('null stats 分区和为 0', sumClassifiedSystemChars(null) === 0, '')

console.log('\n=== 4. 字符 -> token：口径与边界 ===')
check('CHARS_PER_TOKEN = 2.6', CHARS_PER_TOKEN === 2.6, String(CHARS_PER_TOKEN))
check('2600 字 -> 1000 tok', estimateTokensFromChars(2600) === 1000, String(estimateTokensFromChars(2600)))
check('0 / 负数 / NaN -> 0', estimateTokensFromChars(0) === 0 && estimateTokensFromChars(-9) === 0 && estimateTokensFromChars(NaN) === 0, '')

console.log('\n=== 5. 分类行 + 百分比 + 剩余空间 ===')
check('分类表 9 行且 key 唯一', CONTEXT_USAGE_CATEGORIES.length === 9 && new Set(CONTEXT_USAGE_CATEGORIES.map((c) => c.key)).size === 9, String(CONTEXT_USAGE_CATEGORIES.length))
check(
  '分类顺序与示意图一致',
  CONTEXT_USAGE_CATEGORIES.map((c) => c.key).join(',') === 'messages,toolsDef,toolsList,skills,system,sources,workspace,ledger,capability',
  CONTEXT_USAGE_CATEGORIES.map((c) => c.key).join(','),
)

const normal = buildContextUsage(stats, { windowTokens: 200000, usedTokens: 50000 })
const rowSum = normal.rows.reduce((a, r) => a + r.tokens, 0)
check('rows 输出 9 行', normal.rows.length === 9, String(normal.rows.length))
check('★ 分类 token 和 <= 真实已用', rowSum <= normal.usedTokens, `${rowSum} vs ${normal.usedTokens}`)
check('usedTokens 保持真实值', normal.usedTokens === 50000, String(normal.usedTokens))
check('剩余空间 = 窗口 - 已用（非负）', normal.freeTokens === 150000, String(normal.freeTokens))
check('剩余百分比 75', normal.freePct === 75, String(normal.freePct))
check('所有行百分比在 0..100', normal.rows.every((r) => r.pct >= 0 && r.pct <= 100), JSON.stringify(normal.rows.map((r) => r.pct)))
check('unclassifiedTokens = 已用 - 分类和（非负）', normal.unclassifiedTokens === normal.usedTokens - rowSum && normal.unclassifiedTokens >= 0, String(normal.unclassifiedTokens))

// 估算和明显超过真实 used：等比收敛，绝不让分类和 > used
const heavy = buildInjectionStats({
  systemPrompt: REP(20000, 'a'),
  protocols: REP(20000, 'b'),
  messagesJson: REP(40000, 'c'),
  toolsJson: REP(80000, 'd'),
})
const tight = buildContextUsage(heavy, { windowTokens: 100000, usedTokens: 12000 })
const tightSum = tight.rows.reduce((a, r) => a + r.tokens, 0)
check('★ 估算超真实 used 时收敛（分类和 <= used）', tightSum <= tight.usedTokens, `${tightSum} vs ${tight.usedTokens}`)
check('收敛后 classifiedTokens === 分类和', tight.classifiedTokens === tightSum, `${tight.classifiedTokens} vs ${tightSum}`)
check('收敛不产生负数', tight.rows.every((r) => r.tokens >= 0 && r.pct >= 0) && tight.unclassifiedTokens >= 0, '')
check('未超时收敛函数原样返回', JSON.stringify(scaleTokensToBudget([1, 2, 3], 10)) === JSON.stringify([1, 2, 3]), '')

// 未设窗口 / 已用超窗
const noWindow = buildContextUsage(stats, { usedTokens: 50000 })
check('未设窗口：百分比全 0、剩余 0', noWindow.rows.every((r) => r.pct === 0) && noWindow.freeTokens === 0 && noWindow.freePct === 0, '')
const overshoot = buildContextUsage(stats, { windowTokens: 10000, usedTokens: 50000 })
check('已用超窗：剩余恒 0（不出负）', overshoot.freeTokens === 0, String(overshoot.freeTokens))
check('已用超窗：usedPct 夹取到 100', overshoot.usedPct === 100, String(overshoot.usedPct))
const noUsed = buildContextUsage(stats, { windowTokens: 100000, usedTokens: 0 })
const noUsedSum = noUsed.rows.reduce((a, r) => a + r.tokens, 0)
check('没有 promptTokens 时退回分类估算和', noUsed.usedTokens === noUsedSum, `${noUsed.usedTokens} vs ${noUsedSum}`)
check('没有 promptTokens + 有窗口：剩余 = 窗口 - 分类和', noUsed.freeTokens === Math.max(0, 100000 - noUsedSum), String(noUsed.freeTokens))

console.log('\n=== 6. 无注入 / 空 stats 的明细降级 ===')
const emptyView = buildContextUsage(null, { windowTokens: 128000, usedTokens: 0 })
check('null stats 不抛错', emptyView.rows.length === 9, String(emptyView.rows.length))
check('null stats 全 0 / 剩余 = 窗口', emptyView.rows.every((r) => r.tokens === 0) && emptyView.usedTokens === 0 && emptyView.freeTokens === 128000, JSON.stringify({ used: emptyView.usedTokens, free: emptyView.freeTokens }))
const zeroView = buildContextUsage(empty, { windowTokens: 0, usedTokens: 0 })
check('全空 + 未设窗口不崩', zeroView.rows.length === 9 && zeroView.freeTokens === 0 && zeroView.usedPct === 0, '')

console.log('\n=== 7. agentService 接线：每个 system 片段恰好归入一个分区 ===')
const agentSrc = fs.readFileSync(path.join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
const blockStart = agentSrc.indexOf('const injection: AiTeachInjectionStats')
const block = blockStart >= 0 ? agentSrc.slice(blockStart, blockStart + 2500) : ''
const countOf = (name) => (block.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
// systemFull 的全部片段（顺序与 buildSystemPrompt 拼接一致）
const HINT_NAMES = [
  'baseSystem', 'schedulePersona', 'intelPersona', 'scopeInstHint', 'repoRulesHint',
  'assistantConstraintHint', 'glossaryHint', 'profileHint', 'longTaskHint', 'courseHint',
  'teachStyleHint', 'favoritesHint', 'titleRuleHint', 'quizRuleHint', 'planRuleHint',
  'askRuleHint', 'outlineRuleHint', 'endcourseRuleHint', 'teachLedgerRuleHint', 'wrapupRuleHint', 'visualHint',
  'mindmapHint', 'imageHint',
  'sourcesHint', 'scopeRuleHint', 'writeScopeHint', 'constraintsToolHint', 'sideLaneHint',
  'toolsHint', 'executionHint', 'deniedHint', 'vaultFileHint', 'vaultScopeHint',
  'skillHint', 'explicitSkillHint', 'PARALLEL_HINT', 'aiAssistantHint', 'hookStartHint',
]
check('找到 injection 统计块', blockStart >= 0 && block.includes('buildInjectionStats('), String(blockStart))
const missing = HINT_NAMES.filter((n) => countOf(n) === 0)
const duplicated = HINT_NAMES.filter((n) => countOf(n) > 1)
check(`systemFull 的 ${HINT_NAMES.length} 个片段全部入分区（无遗漏）`, missing.length === 0, missing.join(','))
check('没有片段被重复计入两个分区', duplicated.length === 0, duplicated.join(','))
check('messages / tools 走真实序列化', block.includes('JSON.stringify(convo') && block.includes('JSON.stringify(toolPayload)'), '')
check('旧字段 constraintsRaw 仍是四层原始正文', block.includes('constraintsRaw: scopeLayers.global + scopeLayers.workspace + scopeLayers.unit + scopeLayers.lesson'), '')

console.log('\n=== 7b. 台账分层：不进 system 分区（同段内 systemFull 逐字稳定） ===')
const requestInjectionLine = (agentSrc.match(/const requestInjection = \[[^\]]*\]/) || [''])[0]
const systemFullBlock = (agentSrc.match(/const systemFull = manual[\s\S]*?\n\n/) || [''])[0]
check('★ 台账经 requestInjection（历史之后的 user 消息层）注入', requestInjectionLine.includes('courseRequestHint'), requestInjectionLine.slice(0, 160))
check('★ systemFull 拼接不含台账块（负向，防打散 prompt cache 前缀）',
  systemFullBlock !== '' && !systemFullBlock.includes('courseRequestHint') && !systemFullBlock.includes('台账'),
  systemFullBlock.slice(-120))
check('buildCourseInjection 用 out 参携带台账（system 返回值不含它）',
  /buildCourseInjection\(sessionId, getSettingReader\(\), courseRequestOut\)/.test(agentSrc), '')
// 2026-11-22 错题回流：与台账同一分层口径 —— requestOut.wrongBlock 只进首条 user 消息层
check('★ 错题块经 courseRequestOut.wrongBlock 注入（与台账同层，不进 system）',
  /courseRequestOut: \{ block: string; wrongBlock: string \}/.test(agentSrc)
  && /\[courseRequestOut\.block, courseRequestOut\.wrongBlock\]\.filter\(Boolean\)\.join\(/.test(agentSrc), '')
check('★ systemFull 拼接不含错题块（负向，防打散 prompt cache 前缀）',
  systemFullBlock !== '' && !systemFullBlock.includes('wrongBlock') && !systemFullBlock.includes('错题'), systemFullBlock.slice(-120))
check('课程 / 复习上下文（course 分区）只取 system 返回值 courseHint',
  block.includes('course: courseHint') && !block.includes('course: courseHint + courseRequestHint'), '')

// 纯函数级：同一段（聚焦参数不变）连续两轮 —— system 段逐字相同，台账块随进度变化
const TWO_ORDER = ['u1', 'u2', 'u3']
const TWO_UNITS = [
  { id: 'u1', name: '资源分配图' },
  { id: 'u2', name: '安全序列' },
  { id: 'u3', name: '银行家算法' },
]
const ROUND1 = [
  { role: 'assistant', content: '第一轮\n```teach\n{"unitId":"u1","step":1,"label":"定义"}\n```', created_at: '2026-11-22T10:00:00.000Z' },
]
const ROUND2 = [
  ...ROUND1,
  { role: 'assistant', content: '第二轮\n```teach\n{"unitId":"u2","step":1,"label":"安全序列","newTerms":["安全序列"]}\n```', created_at: '2026-11-22T10:01:00.000Z' },
]
const focus = { activeIdx: 2, total: 3, activeName: '安全序列' }
const requestBlockOf = (msgs) => ledgerPure.renderSegmentLedgerRequestBlock({
  patch: ledgerPure.ledgerToPatch(ledgerPure.foldTeachFences(msgs, { unitOrder: TWO_ORDER })),
  units: TWO_UNITS,
  focusId: 'u2',
  ...focus,
})
const sysLineRound1 = ledgerPure.renderSegmentProgressLine(focus)
const sysLineRound2 = ledgerPure.renderSegmentProgressLine(focus)
const reqBlockRound1 = requestBlockOf(ROUND1)
const reqBlockRound2 = requestBlockOf(ROUND2)
check('★ 同一段内连续两轮 system 段逐字相同（进度句与台账解耦）',
  sysLineRound1 === sysLineRound2 && !sysLineRound1.includes(ledgerPure.TEACH_LEDGER_HEADER),
  JSON.stringify(sysLineRound1))
check('★ 同一段内连续两轮请求级台账块随进度变化（不是冻结）',
  reqBlockRound1 !== reqBlockRound2 && reqBlockRound2.includes('已覆盖：资源分配图'), JSON.stringify(reqBlockRound2))
check('无围栏轮次请求级注入为空（零成本）', requestBlockOf([]) === '', '')

console.log('\n=== 7c. 注入位置：每轮变化段在历史之后（OpenAI 系自动前缀缓存） ===')
// 压缩核心纯函数（只 import type，strip 后零依赖）
const { mod: compressCore, tmpDir: compressTmp } = await loadStripped(
  'electron/lib/agentCompressCore.ts',
  'agentCompressCore.mjs',
)
const { composeContextWithDigest, DIGEST_PREFIX } = compressCore
const HIST = [
  { role: 'user', content: '第一问' },
  { role: 'assistant', content: '第一答' },
  { role: 'user', content: '当前提问' },
]
const DIGEST = '旧纪要正文'
const SUFFIX = '【本轮注入】台账 / 日程 / 情报'

// 1) 只有 suffix：[history..., suffix]，suffix 在最后
const onlySuffix = composeContextWithDigest(null, HIST, null, SUFFIX)
check('★ 只有 suffix 时追加在 history 之后（末条即注入段）',
  onlySuffix.length === HIST.length + 1
  && JSON.stringify(onlySuffix.slice(0, HIST.length)) === JSON.stringify(HIST)
  && onlySuffix[onlySuffix.length - 1].role === 'user'
  && onlySuffix[onlySuffix.length - 1].content === SUFFIX,
  JSON.stringify(onlySuffix.map((m) => m.role + ':' + String(m.content).slice(0, 8))))

// 2) 只有 digest：digest 在 history 之前（旧历史摘要的位置语义不能动）
const onlyDigest = composeContextWithDigest(DIGEST, HIST)
check('★ 只有 digest 时仍在 history 之前（首条 = 纪要）',
  onlyDigest.length === HIST.length + 1
  && onlyDigest[0].content === DIGEST_PREFIX + DIGEST
  && JSON.stringify(onlyDigest.slice(1)) === JSON.stringify(HIST),
  String(onlyDigest[0].content).slice(0, 20))

// 3) digest + suffix：[digest, ...history, suffix]
const both = composeContextWithDigest(DIGEST, HIST, null, SUFFIX)
check('★ digest + suffix：[纪要, ...历史, 注入段]',
  both.length === HIST.length + 2
  && both[0].content === DIGEST_PREFIX + DIGEST
  && JSON.stringify(both.slice(1, 1 + HIST.length)) === JSON.stringify(HIST)
  && both[both.length - 1].content === SUFFIX,
  JSON.stringify(both.map((m) => m.role + ':' + String(m.content).slice(0, 6))))

// 3b) extraPrefix 仍保留「历史之前」的原语义（本批不改它的位置）
const withExtra = composeContextWithDigest(null, HIST, '【前段】', SUFFIX)
check('extraPrefix 仍在 history 之前，suffix 仍在最后',
  withExtra.length === HIST.length + 2
  && withExtra[0].content === '【前段】'
  && JSON.stringify(withExtra.slice(1, 1 + HIST.length)) === JSON.stringify(HIST)
  && withExtra[withExtra.length - 1].content === SUFFIX,
  JSON.stringify(withExtra.map((m) => m.role + ':' + String(m.content).slice(0, 6))))

// 4) 全空：与 history 逐项相同（不新增消息）
const plain = composeContextWithDigest(null, HIST, null, null)
check('★ 全空（digest / extraPrefix / suffix 都空）不新增消息',
  plain.length === HIST.length && JSON.stringify(plain) === JSON.stringify(HIST), JSON.stringify(plain.length))
check('全空等价的空串 / undefined 变体同样不新增消息',
  composeContextWithDigest(null, HIST, '', '').length === HIST.length
  && composeContextWithDigest(undefined, HIST, undefined, undefined).length === HIST.length, '')

// 静态：两个调用点（首次装配 + 压缩后重装配）都把 requestInjection 放在第 4 个实参
const CALL_4TH = /composeContextWithDigest\(asm\.digest\?\.text, buildHistoryWithImages\(capHistoryImages\(history\)\), undefined, requestInjection\)/g
const callSites4 = (agentSrc.match(CALL_4TH) || []).length
check('★ agentService 的两处调用点都把 requestInjection 传给第 4 参（第 3 参 undefined）',
  callSites4 === 2, `匹配 ${callSites4} 处`)

// 负向：不得再把 requestInjection 当第 3 参（extraPrefix = 历史之前）
const prefixForm = /composeContextWithDigest\(asm\.digest\?\.text, buildHistoryWithImages\(capHistoryImages\(history\)\), requestInjection\)/g
check('★ 负向：requestInjection 不再作为第 3 参（否则每轮打散会话前缀）',
  (agentSrc.match(prefixForm) || []).length === 0, '')

// 结构：suffix 只进 tail（在 history 之后），head 里没有 suffix 的痕迹
const coreSrc = fs.readFileSync(path.join(ROOT, 'electron/lib/agentCompressCore.ts'), 'utf8')
check('composeContextWithDigest 签名含第 4 参 suffix',
  /suffix\?: string \| null/.test(coreSrc), '')
check('合成顺序为 [...head, ...history, ...tail]',
  /return \[\.\.\.head, \.\.\.history, \.\.\.tail\]/.test(coreSrc), '')

console.log('\n=== 8. 双端一致性：src/lib/contextUsagePure.ts（渲染层镜像） ===')
const UI_TRIO = (list) => JSON.stringify(list.map((c) => [c.key, c.label, c.field]))
check('渲染层导出了 5 个同名算法', ['CHARS_PER_TOKEN', 'CONTEXT_USAGE_CATEGORIES', 'estimateTokensFromChars', 'scaleTokensToBudget', 'buildContextUsage'].every((k) => usageUi[k] != null), Object.keys(usageUi).join(','))
check('★ 9 个分类的 key / 标签 / 字段与顺序两处完全相同', UI_TRIO(CONTEXT_USAGE_CATEGORIES) === UI_TRIO(usageUi.CONTEXT_USAGE_CATEGORIES), UI_TRIO(usageUi.CONTEXT_USAGE_CATEGORIES))
check('★ CHARS_PER_TOKEN 两处相同', usageUi.CHARS_PER_TOKEN === CHARS_PER_TOKEN, `${usageUi.CHARS_PER_TOKEN} vs ${CHARS_PER_TOKEN}`)
check(
  'estimateTokensFromChars 同口径',
  [0, 1, 999, 2599, 2600, 123456].every((n) => usageUi.estimateTokensFromChars(n) === estimateTokensFromChars(n)),
  '',
)
check(
  'scaleTokensToBudget 同输出（含不需要收敛的分支）',
  [[[900, 400, 300, 50], 500], [[3, 2, 1], 100], [[1, 2, 3], 0]].every(
    ([vals, cap]) => JSON.stringify(usageUi.scaleTokensToBudget(vals, cap)) === JSON.stringify(scaleTokensToBudget(vals, cap)),
  ),
  '',
)

const PARITY_CASES = [
  [stats, { windowTokens: 200000, usedTokens: 50000 }],
  [stats, { windowTokens: 1000000, usedTokens: 12900 }],
  [stats, {}],
  [heavy, { windowTokens: 10000, usedTokens: 50000 }],
  [empty, { windowTokens: 128000, usedTokens: 0 }],
  [null, { windowTokens: 0 }],
  [null, { windowTokens: -1, usedTokens: NaN }],
]
let parityDiff = ''
for (const [s, o] of PARITY_CASES) {
  const main = JSON.stringify(buildContextUsage(s, o))
  const ui = JSON.stringify(usageUi.buildContextUsage(s, o))
  if (main !== ui && !parityDiff) parityDiff = `opts=${JSON.stringify(o)} main=${main} ui=${ui}`
}
check('★ 同一组输入下 buildContextUsage 输出逐行相等（7 组用例）', parityDiff === '', parityDiff)

const badNums = []
for (const [s, o] of PARITY_CASES) {
  for (const view of [buildContextUsage(s, o), usageUi.buildContextUsage(s, o)]) {
    const nums = [view.windowTokens, view.usedTokens, view.usedPct, view.classifiedTokens, view.unclassifiedTokens, view.freeTokens, view.freePct, ...view.rows.flatMap((r) => [r.chars, r.tokens, r.pct])]
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) badNums.push(`opts=${JSON.stringify(o)}`)
  }
}
check('★ 渲染层纯函数不出负数 / NaN（null / 负数窗口 / NaN 已用 都覆盖）', badNums.length === 0, badNums.join(' | '))
check(
  '渲染层展示格式：429 / 12.9k / 987.1k / 1M',
  [429, 12900, 987100, 1000000].map(usageUi.formatContextTokens).join(',') === '429,12.9k,987.1k,1M',
  [429, 12900, 987100, 1000000].map(usageUi.formatContextTokens).join(','),
)
check(
  '渲染层百分比：<1% / 0% / 取整 / 未设窗口空串',
  usageUi.formatContextPct(429, 1000000) === '<1%' &&
    usageUi.formatContextPct(0, 1000000) === '0%' &&
    usageUi.formatContextPct(987100, 1000000) === '99%' &&
    usageUi.formatContextPct(5000, 0) === '',
  `${usageUi.formatContextPct(429, 1000000)} / ${usageUi.formatContextPct(0, 1000000)} / ${usageUi.formatContextPct(987100, 1000000)} / "${usageUi.formatContextPct(5000, 0)}"`,
)
check(
  '头部比例保留一位小数：1.3% / <0.1% / 0% / 未设窗口空串',
  usageUi.formatContextPctDetailed(13000, 1000000) === '1.3%' &&
    usageUi.formatContextPctDetailed(429, 1000000) === '<0.1%' &&
    usageUi.formatContextPctDetailed(0, 1000000) === '0%' &&
    usageUi.formatContextPctDetailed(5000, 0) === '',
  `${usageUi.formatContextPctDetailed(13000, 1000000)} / ${usageUi.formatContextPctDetailed(429, 1000000)} / ${usageUi.formatContextPctDetailed(0, 1000000)} / "${usageUi.formatContextPctDetailed(5000, 0)}"`,
)

console.log('\n=== 9. 面板接线（src/modules/ai-teaching/index.tsx） ===')
const panelSrc = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/index.tsx'), 'utf8')
check('面板走渲染层纯函数，不再自算 CHARS_PER_TOKEN', panelSrc.includes("from '../../lib/contextUsagePure'") && !panelSrc.includes('const CHARS_PER_TOKEN'), '')
check('明细面板 aria-label / 关闭按钮可访问名', panelSrc.includes('aria-label="上下文用量明细"') && panelSrc.includes('aria-label="关闭"'), '')
check('未分类兜底行 + 估算脚注 + 未设窗口提示在位', panelSrc.includes('其他（工具结果等）') && panelSrc.includes('token 数是按字符估算的粗略值') && panelSrc.includes('填模型上下文窗口后可见比例'), '')
check('用量面板只有一份 DOM：hover 预览与点击钉住共用（不再出现「两个菜单」）',
  panelSrc.includes('data-wb="aiTeachUsagePanel"') && panelSrc.includes('group-hover:block') &&
    panelSrc.includes("tokenOpen ? 'select-text kb-pop' : 'pointer-events-none hidden group-hover:block kb-view-fade'") &&
    !panelSrc.includes('w-[252px]'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(usageTmp, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
try { fs.rmSync(usageUiTmp, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
try { fs.rmSync(ledgerTmp, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
try { fs.rmSync(compressTmp, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
