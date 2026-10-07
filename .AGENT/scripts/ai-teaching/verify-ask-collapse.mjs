#!/usr/bin/env node
/**
 * 提问卡（```ask 选择卡）收起二态（更新计划第 9 项 / v3.1.1）—— 结构契约静态断言。
 *
 * 为什么静态断言：提问卡是纯交互 UI（无纯函数可抽），而本项的高危回归全是**静默失败**——
 * Esc 链漏改（收起不生效/两段式退化）、换 ask 不重置收起态（新问题继承旧收起）、
 * Collapsible children 写成节点而非函数（TS 会拦，但运行时形态仍值得钉住）、
 * 收起 chip 的 ✕ 漏 stopPropagation（点了忽略顺手展开）。逐条断言钉死。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-ask-collapse.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const t = readFileSync(join(ROOT, 'src/modules/ai-teaching/index.tsx'), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}

console.log('\n[状态与重置]')
check('askCollapsed 状态声明于 Esc 统一入口之前（TDZ 安全：与 askVisible 同区）',
  t.indexOf('const [askCollapsed, setAskCollapsed]') < t.indexOf('// Esc 统一入口'))
check('换 ask 重置收起态（新问题不继承旧收起）',
  /setAskPicks\(\{\}\); setAskPage\(0\); setAskCustomOpen\(false\); setAskCustom\(''\); setAskCollapsed\(false\)/.test(t))

console.log('\n[Esc 两段式]')
check('Esc 第一段 = 收起（轻操作）', /if \(!askCollapsed\) \{ setAskCollapsed\(true\); return \}/.test(t))
check('Esc 第二段（已收起）= 忽略（退回自由输入）', /setAskDismissed\(askPending\.id\)/.test(t) && /setAskCollapsed\(true\); return \}\s*\n\s*setAskDismissed/.test(t))
check('Esc 效应依赖数组含 askCollapsed', /}, \[isActive, zenActive, onZenLevelChange, askVisible, askPending, askCollapsed,/.test(t))

console.log('\n[渲染接线]')
check('头行双态：收起 chip（点击展开）+ 展开头行（专用收起钮）',
  t.includes('{askCollapsed ? (') && t.includes('onClick={() => setAskCollapsed(false)}') && t.includes('onClick={() => setAskCollapsed(true)}'))
check('收起 chip 展示「待回答：」前缀 + 整卷进度', t.includes('待回答：{curQ}') && t.includes('已答 {pickedCount}/{n}'))
check('chip 内 ✕ 阻断冒泡（点忽略不误展开）', t.includes('e.stopPropagation(); setAskDismissed(askPending.id)'))
check('主体套 Collapsible（grid-rows 高度动画，非一次性过渡）', t.includes('<Collapsible open={!askCollapsed}>') && /<Collapsible open=\{!askCollapsed\}>\s*\n\s*\{\(\) => \(</.test(t))
check('展开态高度兜底：选项区 40vh 内滚', t.includes('pt-2 max-h-[40vh] overflow-y-auto space-y-0.5'))

console.log('\n[不扩范围]')
check('未做「流式输出中自动收起」（计划标记谨慎/先不做）', !/pending && setAskCollapsed\(true\)/.test(t))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
