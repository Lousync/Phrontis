#!/usr/bin/env node
/**
 * 契约：AI 教学讲课口径 + 理工科画图 Skill 资产。
 *
 * 背景：基础人设的「简洁直接」会让讲课退化成总结；CONSTRAINTS.md 每层
 * 只有 12 行 / 1200 字符，不能把完整讲课细则塞进去。故：
 *   - agentService 只对 aiTeaching 注入 teachStyleHint（覆盖基础口径）；
 *   - 完整细则放课程级《教学运行手册.md》；
 *   - 画图走 stem-diagram / math-plot Skill。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-teach-style.mjs
 * 输出纯 ASCII（禁 emoji）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

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

console.log('\n[讲课口径] agentService.ts')
const agent = read('electron/lib/agentService.ts')
check('定义 teachStyleHint', agent.includes('const teachStyleHint'))
check('只对 aiTeaching 注入', /const teachStyleHint = source === 'aiTeaching'/.test(agent))
check('systemFull 拼入 teachStyleHint', agent.includes('+ courseHint + teachStyleHint +'))
check('ruleChars 统计 teachStyleHint', agent.includes('outlineRuleHint.length + teachStyleHint.length'))
check('覆盖基础「简洁直接」', agent.includes('基础规则里的「简洁直接」只适用于事务性回答'))
check('禁止要点列表代替推导', agent.includes('禁止用要点列表代替推导'))
check('素材不足要明说', agent.includes('素材只有标题/摘要时明确说“素材不足”'))
check('通用知识补讲标 AI 补充', agent.includes('用通用知识补讲要标“AI 补充”'))

console.log('\n[注入上限] scopePrompt.ts')
const scope = read('electron/lib/scopePrompt.ts')
check('每层仍限 12 条', /SCOPE_LAYER_MAX_ITEMS = 12/.test(scope))
check('每层仍限 1200 字符', /SCOPE_LAYER_MAX_CHARS = 1200/.test(scope))
check('截断追加标记', scope.includes('SCOPE_TRUNCATED_MARK'))

console.log('\n[画图 Skill] resources/skills')
const skills = [
  ['resources/skills/stem-diagram/SKILL.md', 'stem-diagram', '理工科示意图'],
  ['resources/skills/math-plot/SKILL.md', 'math-plot', '数学函数图'],
]
for (const [rel, id, title] of skills) {
  const abs = join(ROOT, rel)
  check(`${rel} 存在`, existsSync(abs))
  if (!existsSync(abs)) continue
  const text = read(rel)
  check(`${id} frontmatter id`, new RegExp(`^id:\\s*${id}\\s*$`, 'm').test(text))
  check(`${id} frontmatter title`, text.includes(`title: ${title}`))
  check(`${id} 提示词 <= 6000 字符（显式注入上限）`, text.length <= 6000, `actual=${text.length}`)
  check(`${id} 引用 visual.html`, text.includes('visual.html'))
  check(`${id} 禁止自由摆坐标/手画`, text.includes('不要手画') || text.includes('不要自由摆坐标'))
}

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
