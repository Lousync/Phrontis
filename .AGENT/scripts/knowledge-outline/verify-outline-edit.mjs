// 契约验证：笔记编辑态左栏大纲（v3.43.0，docs/knowledge-edit-outline-plan.md）。
//
// 为什么需要：大纲此前只在阅读态出现（`outlineMode` 里有 `activePreview`），编辑态退回文件列表。
// 这次把它改成「阅读 / 编辑都保持大纲 + 150ms 防抖实时刷新 + 按页定位跳转」。
// 这几条都只体现在源码门控与事件 detail 上，界面看着都能跑；没有断言就容易被后来的
// 「优化一下条件」悄悄改回去（最典型：把 activePreview 加回 outlineMode）。
//
// 覆盖：
//   ① 判定：编辑态不再被踢回列表；manualFeed / 非 md 的边界不漂移
//   ② 刷新：150ms 防抖 + 切页清空 + 装载占位
//   ③ 跳转：事件带 pageId；主栏 / 副栏 / 博客三处消费者按页过滤
//   ④ 面板：loading 占位与空态并存，搜索框不因刷新换实例
//   ⑤ 文档 / 帮助手册口径同步
//
// 运行（项目根目录）：
//   node .AGENT/scripts/knowledge-outline/verify-outline-edit.mjs

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const mod = stripComments(read('src/modules/knowledge/index.tsx'))
const panel = stripComments(read('src/components/shared/OutlinePanel.tsx'))
const editor = stripComments(read('src/modules/knowledge/components/PageEditor.tsx'))
const blog = stripComments(read('src/modules/blog/components/MarkdownEditor.tsx'))
const help = read('resources/help/笔记 · 主题与总览.md')
const helpModules = read('resources/help/模块一览.md')

console.log('\n--- ① 判定：阅读 / 编辑都保持大纲 ---')
check('① outlineMode 不再要求 activePreview', !/const outlineMode = [^\n]*activePreview/.test(mod))
check('① outlineMode 仍以 md + manualFeed 为边界', /const outlineMode = [^\n]*activeIsMd[^\n]*manualFeed/.test(mod))
check('① 非 md 仍走文件列表（activeIsMd 唯一判据保留）', /const activeIsMd = .*fileType/.test(mod))
check('① 「返回列表」仍能退出自动大纲', /setManualFeed\(true\)/.test(mod) && /outlineMode \?/.test(mod))
check('① 换页仍复位 manualFeed / 阅读态判定', /setManualFeed\(false\)[\s\S]{0,60}setActivePreview\(true\)/.test(mod))

console.log('\n--- ② 刷新：防抖 / 切页 / 装载占位 ---')
check('② 编辑态 150ms 防抖后再解析标题', /setTimeout\(\(\) => setOutlineMd\(outlineSource\), 150\)/.test(mod))
check('② 阅读态直接跟随（不额外延迟）', /if \(readingMode \|\| activePreview\) \{ setOutlineMd\(outlineSource\); return \}/.test(mod))
check('② 解析只吃防抖快照，不再直接吃 liveContent', /parseHeadings\(outlineMd\)/.test(mod) && !/parseHeadings\(liveContent/.test(mod))
check('② 切页立即清空快照（不显示上一篇标题）', /setOutlineMd\(''\)[\s\S]{0,80}\[activePageId\]/.test(mod))
check('② livePageId 校验正文归属', /liveContentReady = .*livePageId === activePageId/.test(mod))
check('② 装载占位有超时兜底（读取失败不永远转圈）', /outlineLoadTimedOut/.test(mod))
check('② 左栏大纲拿到 loading', /<OutlinePanel[\s\S]{0,400}?loading=\{outlineLoading\}/.test(mod))

console.log('\n--- ③ 跳转：按页定位（分屏不串栏） ---')
check('③ 跳转事件 detail 带 pageId', /navigateToHeading\(line: number, id: string, pageId\?: string\)/.test(panel)
  && /detail: \{ line, id, pageId \}/.test(panel))
check('③ 面板把 pageId 传给行点击与回车定位', /navigateToHeading\(node\.line, node\.id, pageId\)/.test(panel)
  && /navigateToHeading\(first\.line, first\.id, pageId\)/.test(panel))
check('③ 两处 OutlinePanel 都传 pageId（普通左栏 + 沉浸）', (mod.match(/pageId=\{/g) || []).length >= 2)
check('③ PageEditor 只处理发给自己那页的跳转', /targetPageId !== pageIdRef\.current/.test(editor))
check('③ 博客编辑器忽略带 pageId 的知识库事件', /if \(pageId\) return/.test(blog))

console.log('\n--- ④ 面板：空态 / 加载态 / 搜索框不换实例 ---')
check('④ 面板有 loading 占位与「大纲内容为空」空态', /loading \?/.test(panel) && panel.includes('正在加载正文…') && panel.includes('大纲内容为空'))
check('④ 搜索框与树同属一个面板实例（headings 只换 prop）', !/key=\{[^}]*headings/.test(mod))

console.log('\n--- ⑤ 文档 / 帮助手册口径 ---')
check('⑤ 帮助手册写明编辑态也保持大纲', /编辑态/.test(help) && /大纲/.test(help))
check('⑤ 模块一览同步（不再是「阅读时」单一口径）', /编辑/.test(helpModules) && /大纲/.test(helpModules))
check('⑤ 实现方案文档存在并记录取舍', read('docs/knowledge-edit-outline-plan.md').includes('150ms')
  && read('docs/knowledge-feed-topics-plan.md').includes('编辑'))

console.log(`\n${pass ? 'PASS 全部通过' : 'FAIL 有失败项'}`)
process.exit(pass ? 0 : 1)
