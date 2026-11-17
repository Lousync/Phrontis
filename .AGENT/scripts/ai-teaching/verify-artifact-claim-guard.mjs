#!/usr/bin/env node
/**
 * 契约：AI 教学产物声称核验（artifact claim guard，A 方案）。
 *
 * 背景：历史会话里出现过模型没调用 visual.html、却在正文写「右侧工件栏已打开示意图」的
 * 假完成（trace 工具步骤为 0，模型随后自认没调用工具）。修法不是改渲染，而是在回答落库前
 * 核验「声称 vs 事实」：命中无产物支撑的完成态 → 一次补救轮 → 仍不成立则追加校正文案。
 *
 * 本脚本：
 *  - strip 类型后直接跑 electron/lib/artifactClaimGuardPure.ts 的真实实现；
 *  - 用两条真实会话原文做正例，否定 / 未来 / 不确定 / 指代旧图 / 代码围栏做负例；
 *  - 静态锁 agentService 的接线（产物记账、补救一轮、finalize、只限 AI 教学面）。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-artifact-claim-guard.mjs
 * 输出纯 ASCII（禁 emoji）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------- 1. 纯函数真实实现
console.log('\n[声称核验] electron/lib/artifactClaimGuardPure.ts')
const PURE_REL = 'electron/lib/artifactClaimGuardPure.ts'
const pureSrc = read(PURE_REL)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-claim-guard-'))
const tmpFile = path.join(tmpDir, 'artifactClaimGuardPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const mod = await import(pathToFileURL(tmpFile).href)
const {
  detectUnbackedArtifactClaim,
  buildArtifactClaimRepairNotice,
  artifactCorrectionNotice,
  mergeClaimRepairReply,
} = mod

// 两条真实会话原文（2026-11-17 / 2026-11-12），均无 visual.html 调用
const REAL_1 = '### 闭包：把圆点后面的非终结符展开\n\n右侧工件栏已打开示意图「LR(0) 闭包 CLOSURE 逐步生成」，用 `下一步 ▸` 走三步，就能看到这条规则如何生效。'
const REAL_2 = '### 不同路径示意图：逐格填表，可暂停单步\n\n右侧工件栏已经打开：`visuals/unique-paths-dp.html`\n\n**这张图要说明的是：每个格子代表从起点到它的路径条数。**'

console.log('\n=== A. 正例（真实会话原文 + 合成）===')
{
  const r1 = detectUnbackedArtifactClaim(REAL_1, [])
  check('A1 真实例 1：已打开示意图 -> visual', r1 && r1.kind === 'visual', JSON.stringify(r1))
  const r2 = detectUnbackedArtifactClaim(REAL_2, [])
  check('A2 真实例 2：工件栏已打开 + visuals/*.html -> visual', r2 && r2.kind === 'visual', JSON.stringify(r2))
  check('A3 示意图已生成 -> visual', detectUnbackedArtifactClaim('示意图已生成，见右栏。', [])?.kind === 'visual')
  check('A4 思维导图已经生成 -> mindmap', detectUnbackedArtifactClaim('思维导图已经生成。', [])?.kind === 'mindmap')
  check('A5 图片已生成 -> image', detectUnbackedArtifactClaim('图片已生成，在对话里。', [])?.kind === 'image')
  check('A6 生成好了 -> visual', detectUnbackedArtifactClaim('这张结构图生成好了。', [])?.kind === 'visual')
  check('A7 evidence 非空且有界', (() => { const r = detectUnbackedArtifactClaim(REAL_1, []); return !!r && r.evidence.length > 0 && r.evidence.length <= 120 })())
  check('A8 裸「图已生成」-> visual', detectUnbackedArtifactClaim('图已生成，见右栏。', [])?.kind === 'visual')
}

console.log('\n=== B. 同轮已有产物 -> 不命中 ===')
check('B1 visual 已产出 -> 不命中', detectUnbackedArtifactClaim(REAL_1, ['visual']) === null)
check('B2 mindmap 已产出 -> 不命中', detectUnbackedArtifactClaim('思维导图已经生成。', ['mindmap']) === null)
check('B3 visual 已产出但声称导图 -> mindmap', detectUnbackedArtifactClaim('示意图已生成，思维导图也已生成。', ['visual'])?.kind === 'mindmap')

console.log('\n=== C. 负例（否定 / 未来 / 不确定 / 指代旧图 / 围栏）===')
{
  const neg = [
    ['C1 没有生成示意图', '我没有生成示意图，抱歉。'],
    ['C2 未能打开右侧工件栏', '未能打开右侧工件栏，路径 visuals/a.html 不可用。'],
    ['C3 生成失败', '示意图生成失败，请稍后再试。'],
    ['C4 接下来会生成示意图', '接下来会生成示意图，先讲完这一步。'],
    ['C5 稍后画好示意图', '稍后画好示意图再发给你。'],
    ['C6 应该已经打开', '右侧工件栏应该已经打开，路径 visuals/a.html。'],
    ['C7 可能已生成', '示意图可能已生成，你确认一下。'],
    ['C8 要不要生成示意图', '要不要生成示意图帮你看？'],
    ['C9 之前那张示意图已打开', '之前那张示意图已打开，可以直接看。'],
    ['C10 刚才那张图已生成', '刚才那张图已生成，不必重画。'],
    ['C11 代码围栏里的示例', '示例：\n```\n右侧工件栏已打开示意图\n```\n以上只是格式说明。'],
    ['C12 示意图如下（无完成态）', '示意图如下：\n\n| a | b |\n|---|---|\n| 1 | 2 |'],
    ['C13 纯「图」无产物名词', '这张图里橙色格表示当前格。'],
    ['C14 讲义已生成', '讲义已生成，路径 AI教学/第1章/段1/讲义.md。'],
    ['C15 这张图已打开（提醒旧图）', '这张图已打开，你点下一步就行。'],
    ['C16 上图已生成（指代旧图）', '上图已生成，不必重画。'],
    ['C17 已经生成过（既往经历）', '右侧工件栏里已经生成过一张内部结构图（`visuals/8253-internal-structure.html`），可以回看。'],
  ]
  for (const [name, text] of neg) check(name + ' -> null', detectUnbackedArtifactClaim(text, []) === null)
}

console.log('\n=== D. 提示与校正文案 ===')
{
  const claim = { kind: 'visual', evidence: REAL_1 }
  const repair = buildArtifactClaimRepairNotice(claim)
  check('D1 补救提示点名工具 visual.html', repair.includes('visual.html'))
  check('D2 补救提示声明不是用户发言', repair.includes('不是用户发言'))
  check('D3 补救提示要求不要提及核对', repair.includes('不要提及本系统核对'))
  check('D4 补救提示给「旧图 / 失败」出口', repair.includes('之前已经存在') && repair.includes('生成失败'))
  const correction = artifactCorrectionNotice(claim)
  check('D5 校正文案点名示意图 + 工具', correction.includes('示意图') && correction.includes('visual.html'))
  check('D6 校正文案明确「不成立」', correction.includes('不成立'))
  check('D7 导图 / 图片文案各自正确',
    artifactCorrectionNotice({ kind: 'mindmap', evidence: '' }).includes('思维导图')
    && artifactCorrectionNotice({ kind: 'image', evidence: '' }).includes('图片'))
}

console.log('\n=== E. 正文合并 ===')
{
  check('E1 模型复读原文 -> 只留一份', mergeClaimRepairReply('第一段讲解\n第二段', '第一段讲解\n第二段\n\n已生成示意图。') === '第一段讲解\n第二段\n\n已生成示意图。')
  check('E2 模型改写讲解 -> 原文在前、新文在后', (() => {
    const m = mergeClaimRepairReply('第一段讲解', '换了措辞的总结')
    return m.startsWith('第一段讲解') && m.endsWith('换了措辞的总结')
  })())
  check('E3 空原文 -> 只留新文', mergeClaimRepairReply('', '新文') === '新文')
  check('E4 空白差异也能去重', mergeClaimRepairReply('第一段 讲解', '第一段\n讲解\n已生成') === '第一段\n讲解\n已生成')
}

// ---------------------------------------------------------------- 2. agentService 接线
console.log('\n=== F. agentService 接线静态锁 ===')
const svc = stripComments(read('electron/lib/agentService.ts').replace(/\r\n/g, '\n'))
check('F1 引入纯函数模块', svc.includes("from './artifactClaimGuardPure'"))
check('F2 本轮产物种类记账', /const producedArtifacts: ArtifactProductKind\[\] = \[\]/.test(svc)
  && /realName === 'visual\.html'\) producedArtifacts\.push\('visual'\)/.test(svc)
  && /realName === 'mindmap'\) producedArtifacts\.push\('mindmap'\)/.test(svc)
  && /realName === 'image'\) producedArtifacts\.push\('image'\)/.test(svc))
check('F3 artifact.edit 按扩展名归类（.html/.json，.md 不算图）',
  /artifact\.edit'\) \{[\s\S]{0,220}endsWith\('\.html'\)[\s\S]{0,160}endsWith\('\.json'\)/.test(svc))
check('F4 补救轮只跑一次且避开收场轮', /source === 'aiTeaching' && !artifactClaimRepaired && !budgetCapped/.test(svc))
check('F5 命中后暂存正文 + 追加核对提示 + continue', /pendingClaimPrepend = r\.content[\s\S]{0,220}buildArtifactClaimRepairNotice\(claim\)[\s\S]{0,40}continue/.test(svc))
check('F6 正常出口走 finalize', /const reply = finalizeArtifactClaimReply\(r\.content \+ changesText\)/.test(svc))
check('F7 中断 / 截断出口合并暂存但免校正', /finalizeArtifactClaimReply\(r\.content \+ changesText, false\)/.test(svc))
check('F8 强制总结出口也走 finalize', /finalizeArtifactClaimReply\(fr\.content \+ changesText\)/.test(svc))
check('F9 finalize 只在 AI 教学面追加校正', /allowCorrection && source === 'aiTeaching'/.test(svc))
check('F10 校正追加在 appendAgentMessage 之前', (() => {
  const i = svc.indexOf('const reply = finalizeArtifactClaimReply(r.content + changesText)')
  const j = svc.indexOf('appendAgentMessage(sessionId, \'assistant\', reply, trace)', i)
  return i > 0 && j > i
})())

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
if (fail > 0) {
  console.log('\n失败明细见上方 FAIL 行。')
  process.exit(1)
}
