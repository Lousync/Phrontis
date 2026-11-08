// 契约验证：B-47 段 / 知识点讲完后的收尾协议（教师分支注入）。
//
// 背景（docs/pending-fixes.md B-47）：一段讲完后 AI 不主动建议「收尾本段 → 生成交接 →
// 开下一段」，交接与下一段的衔接容易被遗忘；且收尾只应由学生点「收尾本段」触发。
//
// 本脚本钉住 buildCourseInjection 教师分支的注入形状（运行期行为由模型消费，无 DOM 可断言；
// nextOpenSegmentBrief 依赖 readProgressFile 等宿主态，纯逻辑随静态断言锁结构）：
//   ① 本段进度（当前聚焦第 X/N）
//   ② 段内收尾协议：不得自动收尾（负向断言）· 知识点讲完先问去向 · 最后一个讲完且学生
//      确认后主动建议「收尾本段 → 本段夹《交接.md》→ 左栏开下一段」
//   ③ 已收尾段的同会话引导：不继续讲课 · 不再建议收尾 · 看交接 · 开下一段（含下一段元信息）
//   ④ open / ended 两分支互斥
//
// 运行（项目根目录）：
//   node .AGENT/scripts/ai-teaching/verify-segment-wrapup.mjs
// 期望：[OK] 全部通过 且 exit=0

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const src = stripComments(readFileSync(join(repo, 'electron/lib/aiTeachingCourse.ts'), 'utf8').replace(/\r\n/g, '\n'))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 本段进度注入（B-47 ①） ===')
ok(/本段进度：当前聚焦第 \$\{activeIdx\}\/\$\{ids\.length\} 个知识点/.test(src),
  'A1 注入「当前聚焦第 X/N 个知识点」')
ok(/已讲到哪、还有哪些没讲，结合本段对话自行判断/.test(src),
  'A2 已讲口径由模型结合对话史判断（无 per-unit 状态可注入，不虚构）')

console.log('\n=== B. 段内收尾协议（B-47 ②③，open 分支） ===')
ok(/段内收尾协议：/.test(src), 'B1 注入「段内收尾协议」段')
ok(/你在任何情况下都\*\*不得自动收尾\*\*/.test(src) || /你在任何情况下都不得自动收尾/.test(src),
  'B2 负向断言：任何情况下不得自动收尾')
ok(/也不要替学生调用任何收尾 \/ finalize 动作/.test(src), 'B3 负向断言：不替学生调 finalize')
ok(/当前知识点讲完、学生没有追问时，先问「继续本段下一个知识点，还是先收尾本段」/.test(src),
  'B4 知识点讲完且无追问 → 先问「继续下一个 / 先收尾」')
ok(/本段最后一个知识点也讲完、学生确认没有问题后，再主动建议：点「收尾本段」→ 系统会在本段夹生成《交接\.md》→ 到左栏开下一段/.test(src),
  'B5 最后一个知识点讲完且确认 → 建议收尾本段 → 交接.md → 左栏开下一段')
ok(/收尾只由学生点右上角「收尾本段」触发/.test(src), 'B6 收尾入口唯一（学生动作）')

console.log('\n=== C. 已收尾段的同会话引导（B-47 ④） ===')
ok(/本段收尾协议：本段已收尾（只读）/.test(src), 'C1 ended 分支注入「本段已收尾（只读）」')
ok(/不要继续讲课、不要引入新知识点、不要再建议「收尾本段」/.test(src), 'C2 不续讲 · 不再建议收尾')
ok(/交接文档已生成（本段夹《交接\.md》），请看交接并到左栏开下一段/.test(src), 'C3 看交接 → 开下一段')
ok(/下一段：第\$\{next\.order\}段，覆盖 \$\{next\.cover\}/.test(src), 'C4 有下一段时注入其序号与覆盖面')
ok(/本章的段已全部收尾，可到左栏看是否要章末复习/.test(src), 'C5 无下一段时指向章末复习')

console.log('\n=== D. 分支互斥与下一段取数 ===')
ok(/if \(curLesson\.status === 'ended'\) \{[\s\S]*?本段收尾协议：[\s\S]*?\} else \{[\s\S]*?交接纪律：[\s\S]*?段内收尾协议：/.test(src),
  'D1 ended / open 两分支互斥（if-else 结构）')
ok(/function nextOpenSegmentBrief\(/.test(src), 'D2 nextOpenSegmentBrief 助手存在')
ok(/x\.lesson\.status === 'open' && \(Number\(x\.lesson\.order\) \|\| 0\) > \(Number\(curLesson\.order\) \|\| 0\)/.test(src),
  'D3 下一段 = 同章 order 更大的 open 段')
ok(/chapterSegments\(s\.lessons, chapterUnitIds\)/.test(src), 'D4 复用 chapterSegments 取同章段列')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
