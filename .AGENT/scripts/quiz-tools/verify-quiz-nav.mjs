#!/usr/bin/env node
/**
 * 契约验证：题卡「答对自动跳下一题」的目标选择（quizNavPure）。
 *
 * 为什么需要它：AI 教学界面会把同一份题单同时渲染在左聊天栏与右教材/工件栏，两栏各自是
 * 独立滚动容器。旧实现全局找「视口里下一张题卡」，会把另一栏的题当成下一题、把那一栏滚走
 * （2026-11-10 用户反馈：左侧答对选择题后，右侧教材自动翻到下一题）。
 * 这里锁住「只选同 scope 的下一张」这条纯函数口径，并静态检查 QuizCard 确实按滚动容器分栏。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-quiz-nav.mjs
 * 期望：输出 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pickNextQuizCardIndex } from '../../../src/components/shared/quizNavPure.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

let failures = 0
let checks = 0
const check = (name, cond, detail) => {
  checks++
  if (cond) console.log('  [OK] ' + name)
  else {
    failures++
    console.error('  [FAIL] ' + name + (detail ? ' —— ' + detail : ''))
  }
}

console.log('\n§1 pickNextQuizCardIndex（同栏优先 / 不跨栏 / 容差 / 无下一题）')

check('跨栏更近的题卡不选：右栏 200 不抢聊天栏 800', pickNextQuizCardIndex([
  { top: 100, scope: 'chat' },      // 0 当前（聊天）
  { top: 200, scope: 'material' },  // 1 右栏，视口更近
  { top: 800, scope: 'chat' },      // 2 聊天栏下一题
], 0) === 2)

check('同栏取最近：600 / 300 两张取 300', pickNextQuizCardIndex([
  { top: 100, scope: 'a' },
  { top: 600, scope: 'a' },
  { top: 300, scope: 'a' },
], 0) === 2)

check('同栏没有后续题 → -1', pickNextQuizCardIndex([
  { top: 500, scope: 'a' },
  { top: 600, scope: 'a' },
], 1) === -1)

check('只有另一栏有后续题 → -1（绝不跨栏）', pickNextQuizCardIndex([
  { top: 100, scope: 'chat' },
  { top: 300, scope: 'material' },
], 0) === -1)

check('只有自己 → -1', pickNextQuizCardIndex([{ top: 100, scope: 'a' }], 0) === -1)

check('容差内（上方 2px）算下一题', pickNextQuizCardIndex([
  { top: 100, scope: 'a' },
  { top: 98, scope: 'a' },
], 0) === 1)

check('超出容差（上方 10px）不算下一题', pickNextQuizCardIndex([
  { top: 100, scope: 'a' },
  { top: 90, scope: 'a' },
], 0) === -1)

check('越界下标安全返回 -1', pickNextQuizCardIndex([{ top: 100, scope: 'a' }], 9) === -1)

console.log('\n§2 QuizCard 接线（按滚动容器分 scope，不按全局视口选）')
{
  const src = readFileSync(join(ROOT, 'src', 'components', 'shared', 'QuizCard.tsx'), 'utf8')
  check('使用 pickNextQuizCardIndex 选下一题', /pickNextQuizCardIndex\(/.test(src))
  check('为每张题卡计算最近滚动容器 scope', /scope:\s*scrollScopeOf\(closestScrollBox\(/.test(src))
  check('滚动落在当前题卡所在容器（手算居中，不滚祖先）', /box\.scrollTo\(\{\s*top:\s*Math\.max\(0,\s*target\),\s*behavior:\s*'smooth'\s*\}\)/.test(src))
}

console.log('\n' + (failures === 0 ? 'PASS (' + checks + ' checks)' : 'FAIL (' + failures + '/' + checks + ')'))
process.exit(failures === 0 ? 0 : 1)
