/**
 * 契约脚本：AI 助手 Agent 能力整包 · 批次 B1（@ 引用 + 骨架注入）
 *
 * 覆盖的缺陷面：
 *   ① 骨架装配的**静默截断错** —— 多切一个字符不报错、少切一段不报错，
 *      只有把输入顶到边界才看得见。纯函数区全部 import 真实现做表驱动断言；
 *   ② 成本红线（铁律 17）—— 注入段总字符必须落进预算，否则每轮都多付 token 而不报警；
 *   ③ 既有路径零回归 —— 未引用文件时 `buildSystemPrompt` 必须逐字节退回现状
 *      （老路径被新特判污染是这类改动最常见的回归）；
 *   ④ list-drift（同类第 5 次）—— chip 上限值被抄成多份字面量后改动只落到一处。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-perception.mjs
 */
import { readFileSync } from 'node:fs'
import {
  parseFrontmatter, extractHashes, extractFirstPara, buildRefSkeleton, buildAttachedRefsInjection,
  REF_SKELETON_TOTAL_LIMIT, ATTACHED_INJECTION_LIMIT, MAX_ATTACHED_REFS,
} from '../../../electron/lib/aiAssistant/refSkeleton.ts'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = 'E:/Projects/KnowledgeRecorder'
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

const SRC_REF = stripComments(read('electron/lib/aiAssistant/refSkeleton.ts'))
const SRC_AGENT = stripComments(read('electron/lib/agentService.ts'))
const SRC_CHATBODY = stripComments(read('src/components/shared/AssistantPanel/ChatBody.tsx'))

// ===================== A 组：纯函数 =====================

// ---- A1 parseFrontmatter 三态 ----
const fmFull = '---\ntitle: 我的笔记\nstatus: draft\ntags: [考研, 数学]\n---\n\n正文内容'
ok(JSON.stringify(parseFrontmatter(fmFull)) === JSON.stringify(['title=我的笔记', 'status=draft', 'tags=[考研, 数学]']),
  'A1a parseFrontmatter 收标量与数组形式', JSON.stringify(parseFrontmatter(fmFull)))
ok(parseFrontmatter('没有 frontmatter 的正文').length === 0,
  'A1b parseFrontmatter 无 frontmatter → 空数组', JSON.stringify(parseFrontmatter('没有 frontmatter 的正文')))
ok(parseFrontmatter('---\ntitle: 未闭合\n\n正文').length === 0,
  'A1c parseFrontmatter 未闭合围栏 → 空数组（不吞正文）', JSON.stringify(parseFrontmatter('---\ntitle: 未闭合\n\n正文')))
// 嵌套对象起始行（`key:` 后无值）跳过，不产生 `key=undefined`
ok(!parseFrontmatter('---\nmeta:\n  a: 1\n---\n正文').some((s) => s.endsWith('=')),
  'A1d parseFrontmatter 跳过 `key:` 后为空的嵌套起始行', JSON.stringify(parseFrontmatter('---\nmeta:\n  a: 1\n---\n正文')))

// ---- A2 extractHashes ----
const headRaw = '# 一级\n\n正文\n\n## 二级\n### 三级\n'
ok(JSON.stringify(extractHashes(headRaw)) === JSON.stringify(['# 一级', '## 二级', '### 三级']),
  'A2a extractHashes 摘出 1-6 级标题并保序', JSON.stringify(extractHashes(headRaw)))
ok(extractHashes('---\n# 注释不是标题\n---\n\n# 真标题').length === 1,
  'A2b extractHashes 不误收 frontmatter 内的 `#` 注释行', JSON.stringify(extractHashes('---\n# 注释不是标题\n---\n\n# 真标题')))
ok(extractHashes('#没有空格不是标题').length === 0,
  'A2c extractHashes 要求 `#` 后必须有空白（`#foo` 不算标题）', JSON.stringify(extractHashes('#没有空格不是标题')))
ok(extractHashes('####### 七级\n# 一级').length === 1,
  'A2d extractHashes 只认 1-6 级（七级井号不算）', JSON.stringify(extractHashes('####### 七级\n# 一级')))

// ---- A3 extractFirstPara ----
ok(extractFirstPara(fmFull) === '正文内容',
  'A3a extractFirstPara 跳过 frontmatter 取首段', JSON.stringify(extractFirstPara(fmFull)))
ok(extractFirstPara('# 标题\n\n第一段话\n\n第二段话') === '第一段话',
  'A3b extractFirstPara 跳过标题与空行，遇空行即止', JSON.stringify(extractFirstPara('# 标题\n\n第一段话\n\n第二段话')))
ok(extractFirstPara('# 标题\n\n```js\ncode()\n```\n\n正文') === '正文',
  'A3c extractFirstPara 跳过代码围栏块', JSON.stringify(extractFirstPara('# 标题\n\n```js\ncode()\n```\n\n正文')))
ok(extractFirstPara('只有标题\n') === '' || extractFirstPara('') === '',
  'A3d extractFirstPara 无正文段落 → 空串', JSON.stringify(extractFirstPara('')))

// ---- A4 buildRefSkeleton 总长硬上限 ----
const huge = '---\ntitle: T\n---\n\n' + '# ' + 'H'.repeat(400) + '\n\n' + 'P'.repeat(2000) + '\n'
const skHuge = buildRefSkeleton({ title: '超长笔记', path: 'a/b.md', raw: huge })
ok(skHuge.text.length <= REF_SKELETON_TOTAL_LIMIT,
  `A4a buildRefSkeleton 单篇总长 ≤ ${REF_SKELETON_TOTAL_LIMIT} 硬上限`,
  `实际 ${skHuge.text.length}`)
ok(skHuge.text.includes('标题骨架'),
  'A4b 超长时标题骨架仍在（截断顺序正确：先砍首段）', skHuge.text.slice(0, 80))
ok(skHuge.text.includes('H'),
  'A4c 超长时标题首行内容仍在（最高价值信息不被砍空）', skHuge.text.slice(0, 80))

// ---- A5 幂等（不打散 prompt cache，铁律 17） ----
const skA = buildRefSkeleton({ title: 'X', path: 'p.md', raw: huge })
const skB = buildRefSkeleton({ title: 'X', path: 'p.md', raw: huge })
ok(skA.text === skB.text,
  'A5 buildRefSkeleton 幂等（同输入两次调用结果全等）', `${skA.text.length} vs ${skB.text.length}`)

// ---- A6 无 raw（读文件失败）降级 ----
const skNoRaw = buildRefSkeleton({ title: '读不到的笔记', path: 'gone.md' })
ok(skNoRaw.text === '' && skNoRaw.hashes.length === 0,
  'A6 无 raw → 骨架为空串（逐篇容错，不炸整轮）', JSON.stringify(skNoRaw.text))

// ===================== B 组：成本红线 =====================

const four = [1, 2, 3, 4].map((i) => ({
  title: `第 ${i} 篇`,
  path: `notes/${i}.md`,
  raw: `---\ntitle: 第 ${i} 篇\ntags: [a, b]\n---\n\n# 大标题 ${i}\n## 小节\n\n${'正'.repeat(3000)}`,
}))
const inj4 = buildAttachedRefsInjection(four)
ok(inj4.length <= ATTACHED_INJECTION_LIMIT,
  `B1 四篇满额注入 ≤ ${ATTACHED_INJECTION_LIMIT} 字符（成本红线，铁律 17）`,
  `实际 ${inj4.length}`)
ok(inj4.includes('第 1 篇') && inj4.includes('notes/1.md'),
  'B2 注入段含篇目标题与 path（模型可据此 fileRead）', inj4.slice(0, 120))
ok(inj4.includes('文件读取工具'),
  'B3 注入段告知模型按需 fileRead', '')

ok(buildAttachedRefsInjection([]) === '',
  'B4 零篇 → 空串（调用方据此退回现状行为）', JSON.stringify(buildAttachedRefsInjection([])))

// 极端场景：单篇骨架就顶满预算 → kept 为空时仍必须报出「有引用」这一事实
const oneHuge = buildAttachedRefsInjection([{ title: '超大篇', path: 'big.md', raw: '# H\n\n' + 'X'.repeat(20000) }])
ok(oneHuge.length <= ATTACHED_INJECTION_LIMIT,
  'B8 单篇超大时注入 ≤ 预算', `实际 ${oneHuge.length}`)
ok(oneHuge.includes('big.md'),
  'B9 极端截断下仍报出引用文件的 path（不静默丢引用）', oneHuge.slice(0, 120))
// 注意：篇数要足够多才触发丢篇 —— 单篇骨架被 PARA_LIMIT=200 先截住（约 230 字/篇），
// 需 >26 篇才越过 6000 预算。20 篇是无效用例（改回会让 B6「看似 PASS 实则没测到」）
const many = Array.from({ length: 40 }, (_, i) => ({
  title: `篇 ${i + 1}`,
  path: `n/${i + 1}.md`,
  raw: `# 标题\n\n${'内'.repeat(2000)}`,
}))
const injMany = buildAttachedRefsInjection(many)
ok(injMany.length <= ATTACHED_INJECTION_LIMIT,
  'B5 超篇数时注入仍 ≤ 预算（末篇整篇丢弃）', `实际 ${injMany.length}`)
ok(injMany.includes('因预算上限未展开'),
  'B6 丢弃篇目时给出提示（不静默丢）', injMany.slice(-80))
ok(/— 1\./.test(injMany),
  'B7 超篇数时首篇仍保留（丢的是末篇不是首篇）', injMany.slice(0, 100))

// ===================== C 组：负向（防回归 / 防蔓延） =====================

ok(!/registerTool|inputSchema|listTools\(\)\.push/.test(SRC_REF),
  'C1 refSkeleton 不新增 AI 常驻工具 / 工具 schema（铁律 16 成本红线）', '')

const countMaxLiteral = (SRC_CHATBODY.match(/\bMAX_ATTACHED_REFS\b/g) ?? []).length
ok(countMaxLiteral >= 1,
  'C2 ChatBody 的 chip 上限读常量而非硬编码 4（list-drift 防线）',
  `MAX_ATTACHED_REFS 出现 ${countMaxLiteral} 次`)
ok(!/length\s*>=\s*4\b/.test(SRC_CHATBODY),
  'C3 ChatBody 无裸 `length >= 4` 字面量上限（同概念不得两份值）', '')

ok(/attachedFiles/.test(SRC_AGENT),
  'C4 agentService 已接 attachedFiles 特判（骨架注入的前提）', '')

// ===================== D 组：接线存在性 =====================

ok(MAX_ATTACHED_REFS === 4,
  'D1 chip 上限常量值 = 4（上游 §3.1 拍板值）', String(MAX_ATTACHED_REFS))

const countPopFiles = (SRC_CHATBODY.match(/pop\s*===\s*'files'/g) ?? []).length
ok(countPopFiles >= 1,
  'D2 @ 唤起复用既有 `pop===\'files\'` 浮层状态（不与 📎 各造一套）',
  `出现 ${countPopFiles} 次`)

ok(/onKeyDown|onKeyUp/.test(SRC_CHATBODY),
  'D3 输入框挂了键事件（@ 唤起的触发位）', '')

// ===================== 结果 =====================

if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
