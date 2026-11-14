// 契约验证：组合输入框「只画一道框」（2026-11-14，docs/input-field-pattern.md）。
//
// 背景：全局 `input, textarea, select` 自带 1px 边框（src/styles/index.css）。
// 组合框（图标 + 输入 + 清除）若外壳再画一道框，就会出现「框中框」细线 ——
// 用户已报障一次。本契约锁住三件事：
//   ① 工具类存在且语义正确（外壳画框 / 内部控件归零）
//   ② 已迁移的组合框内部控件都带 .kb-field-control
//   ③ 规范文档与 AGENTS 指针存在（新代码能找到画法）
//
// 运行：
//   node .AGENT/scripts/input-field/verify-input-field.mjs

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

console.log('\n--- ① 工具类（src/styles/index.css）---')
const css = read('src/styles/index.css')
check('① .kb-field 定义（外壳画边框 + 背景）', /\.kb-field\s*\{[^}]*border:\s*1px solid var\(--border-color\)[^}]*background:\s*var\(--input-bg\)/.test(css))
check('① .kb-field:focus-within 焦点画在外壳', /\.kb-field:focus-within\s*\{[^}]*border-color:\s*var\(--accent\)/.test(css))
check('① .kb-field-control 把边框 / 圆角 / 背景 / 焦点框归零',
  /\.kb-field-control,[\s\S]{0,160}?border:\s*0;[\s\S]{0,120}?border-radius:\s*0;[\s\S]{0,120}?background:\s*transparent;[\s\S]{0,120}?outline:\s*none;[\s\S]{0,120}?box-shadow:\s*none;/.test(css))

console.log('\n--- ② 已迁移的组合框 ---')
const migrated = [
  ['知识库左栏搜索', 'src/modules/knowledge/index.tsx', ['kb-field', 'kb-field-control']],
  ['日程 · 今日添加任务', 'src/modules/schedule/views/TodayView.tsx', ['kb-field-control']],
  ['日程 · 任务清单添加', 'src/modules/schedule/views/TaskListView.tsx', ['kb-field-control']],
  ['AI 助手 · 范围面板搜索', 'src/modules/ai-assistant/ScopePane.tsx', ['kb-field-control']],
  ['书市 · 搜索', 'src/modules/bookmarket/DiscoverView.tsx', ['kb-field-control']],
  ['插件市场 · 搜索', 'src/modules/plugins/index.tsx', ['kb-field', 'kb-field-control']],
  ['设置 · 数值输入', 'src/modules/settings/components/fields/NumberField.tsx', ['kb-field-control']],
]
for (const [label, file, classes] of migrated) {
  const src = existsSync(join(ROOT, file)) ? read(file) : ''
  check(`② ${label}`, classes.every((c) => src.includes(c)), file)
}
const know = read('src/modules/knowledge/index.tsx')
check('② 知识库搜索内部 input 不再自带 bg-transparent / outline-none（外壳负责）', !/placeholder="搜索笔记"[\s\S]{0,220}?className="[^"]*\bbg-transparent\b/.test(know))

console.log('\n--- ③ 规范文档与指针 ---')
check('③ docs/input-field-pattern.md 存在', existsSync(join(ROOT, 'docs/input-field-pattern.md')))
if (existsSync(join(ROOT, 'docs/input-field-pattern.md'))) {
  const doc = read('docs/input-field-pattern.md')
  check('③ 文档写清两种形态（单控件 / 组合框）', doc.includes('单控件') && doc.includes('组合控件'))
  check('③ 文档写明「内部控件必须 .kb-field-control」', doc.includes('.kb-field-control') && doc.includes('框中框'))
  check('③ 文档含焦点 / 错误 / 禁用态与自检清单', doc.includes('焦点态') && doc.includes('错误') && doc.includes('自检清单'))
}
check('③ AGENTS 文档指针已收录', read('AGENTS.md').includes('docs/input-field-pattern.md'))

console.log(`\n${pass ? 'PASS 全部通过' : 'FAIL 有失败项'}`)
process.exit(pass ? 0 : 1)
