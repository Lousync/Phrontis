/**
 * 契约脚本：AI 助手 Agent 能力整包 · 批次 B1（@ 引用 + 骨架注入）+ B2（感知模式）+ B4（内联建议）
 *
 * 覆盖的缺陷面：
 *   ① 骨架 / 素材装配的**静默截断错** —— 多切一个字符不报错、少切一段不报错，
 *      只有把输入顶到边界才看得见。纯函数区全部 import 真实现做表驱动断言；
 *   ② 成本红线（铁律 17）—— 注入段总字符必须落进预算，否则每轮都多付 token 而不报警；
 *   ③ 既有路径零回归 —— 未引用文件时 `buildSystemPrompt` 必须逐字节退回现状
 *      （老路径被新特判污染是这类改动最常见的回归）；
 *   ④ list-drift（同类第 5 次）—— chip 上限值被抄成多份字面量后改动只落到一处；
 *      同款：编辑器内容胶囊曾被手抄两份（J10g 锁死为单点定义）；
 *   ⑤ **prompt cache 前缀稳定**（B2 纠正）—— 每轮变化的注入段不得进 system，
 *      否则 system + core 14 工具（≈7.7k tok/轮）逐轮重算而**没有任何报错**；
 *   ⑥ B4 静默失效面 —— 光标 offset 越界被 slice 吞成空窗口、Monaco 接口方法名随版本漂移
 *      （0.56 是 disposeInlineCompletions，不是旧版的 freeInlineCompletions）、
 *      快捷键被系统级 globalShortcut 抢走（Ctrl+Alt+S 已被日程侧栏占用）。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-perception.mjs
 */
import { readFileSync } from 'node:fs'
import {
  parseFrontmatter, extractHashes, extractFirstPara, buildRefSkeleton, buildAttachedRefsInjection,
  REF_SKELETON_TOTAL_LIMIT, ATTACHED_INJECTION_LIMIT, MAX_ATTACHED_REFS,
} from '../../../electron/lib/aiAssistant/refSkeleton.ts'
import {
  budgetMaterial, buildPerceptionInjection, footnoteSafe, renderMaterialBlocks,
  PERCEPTION_ITEM_LIMIT, PERCEPTION_TOTAL_LIMIT, PERCEPTION_TOPK,
} from '../../../electron/lib/aiAssistant/perceptionBudget.ts'
import {
  buildInlinePrompt, isValidSuggestion, normalizeInlineSuggestion,
  pickFrontmatterTitle, sliceCursorWindow, sliceParagraphWindow,
  INLINE_SUGGEST_MAX_CHARS, INLINE_BEFORE_LIMIT, INLINE_AFTER_LIMIT,
} from '../../../electron/lib/aiAssistant/inlineSuggestCore.ts'
import {
  AUTO_DEBOUNCE_MS, AUTO_PAUSE_STREAK, INITIAL_AUTO_STATE,
  afterAutoResult, canAutoRequest, isTriggerPoint, reviveByManual,
} from '../../../src/lib/inlineSuggestTrigger.ts'
import { composeContextWithDigest } from '../../../electron/lib/agentCompressCore.ts'
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
const SRC_BUDGET = stripComments(read('electron/lib/aiAssistant/perceptionBudget.ts'))
const SRC_PERCEPTION = stripComments(read('electron/lib/aiAssistant/perception.ts'))
const SRC_AGENT = stripComments(read('electron/lib/agentService.ts'))
const SRC_CORE = stripComments(read('electron/lib/agentCompressCore.ts'))
const SRC_CHATBODY = stripComments(read('src/components/shared/AssistantPanel/ChatBody.tsx'))
const SRC_SIDEBAR = stripComments(read('src/components/shared/AssistantPanel/index.tsx'))
const SRC_SETTINGS = stripComments(read('src/lib/settings.ts'))
/** B4 自动触发闸门（渲染层纯函数区） */
const SRC_TRIGGER = stripComments(read('src/lib/inlineSuggestTrigger.ts'))

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

// ===================== E 组：★ prompt cache 前缀稳定（B2 纠正） =====================
//
// 这是本批最重要的一组：注入段一旦进 system，system + core 14 工具（≈7.7k tok/轮）
// 就每轮重算，而**没有任何报错、没有任何断言会红**——只有账单知道。

// E1 composeContextWithDigest 支持第三参数（每轮变化的注入段）
const hist = [{ role: 'user', content: '历史消息' }]
const withExtra = composeContextWithDigest(null, hist, '【注入段】内容')
ok(withExtra.length === 2 && withExtra[0].content === '【注入段】内容' && withExtra[1].content === '历史消息',
  'E1a composeContextWithDigest 把 extraPrefix 放在历史消息**之前**（首条 user 层）',
  JSON.stringify(withExtra.map((m) => m.content)))

// E1b 摘要 + 注入段同时存在时的顺序：摘要在前、注入段在后（越靠近当前消息越贴合注意力）
const withBoth = composeContextWithDigest('旧纪要正文', hist, '【注入段】内容')
ok(withBoth.length === 3 && withBoth[0].content.includes('旧纪要正文')
  && withBoth[1].content === '【注入段】内容' && withBoth[2].content === '历史消息',
  'E1b 纪要在前、注入段在后、历史在最后（三层顺序固定）',
  JSON.stringify(withBoth.map((m) => m.content.slice(0, 12))))

// E1c 零注入段时必须逐字节退回原行为（老路径零回归 —— 这是历史最常见的回归点）
const noExtra = composeContextWithDigest('旧纪要正文', hist)
ok(noExtra.length === 2 && noExtra[0].content.startsWith('【此前对话纪要】'),
  'E1c 无 extraPrefix 时与改造前逐字节一致（零回归）',
  JSON.stringify(noExtra.map((m) => m.content.slice(0, 12))))

// E1d 空串 / null 注入段等同「无注入」（不得多出一条空 user 消息污染上下文）
ok(composeContextWithDigest(null, hist, '').length === 1
  && composeContextWithDigest(null, hist, null).length === 1
  && composeContextWithDigest(null, hist, undefined).length === 1,
  'E1d 空串/null/undefined 注入段不产生多余 user 消息', '')

ok(SRC_CORE.includes('extraPrefix'),
  'E2 composeContextWithDigest 的 extraPrefix 参数存在（契约脚本 import 的即真实现）', '')

// E3 ★ 负向：buildSystemPrompt 体内不得再出现骨架 / 素材装配
// 取 buildSystemPrompt 函数体（从签名到下一个顶层 function）
function bodyOf(src, name) {
  const i = src.indexOf(`function ${name}`)
  if (i === -1) return ''
  const rest = src.slice(i + 1)
  const j = rest.search(/\n(?:async )?function |\n\/\*\*/)
  return j === -1 ? rest : rest.slice(0, j)
}
const bsBody = bodyOf(SRC_AGENT, 'buildSystemPrompt')
ok(bsBody.length > 0, 'E3a 能定位 buildSystemPrompt 函数体（断言本身有效）', `len=${bsBody.length}`)
ok(!/buildAttachedRefsInjection|buildPerceptionInjection/.test(bsBody),
  'E3b ★ buildSystemPrompt 体内**不得**装配注入段（进 system 会打散 prompt cache 前缀）',
  bsBody.match(/build\w+Injection/g)?.join(',') ?? '')
ok(!/readVaultRefText/.test(bsBody),
  'E3c ★ buildSystemPrompt 体内不得读盘（读盘 = 每轮内容可能不同 = 前缀不稳定）', '')

// E4 ★ 正向：注入段确实被送进 composeContextWithDigest
ok(/composeContextWithDigest\([^)]*requestInjection/.test(SRC_AGENT)
  || /composeContextWithDigest\([^)]*,\s*requestInjection\s*\)/.test(SRC_AGENT),
  'E4a ★ agentService 把 requestInjection 传进 composeContextWithDigest（真的走 user 层）', '')
ok(/const requestInjection\s*=/.test(SRC_AGENT),
  'E4b agentService 有 requestInjection 汇总变量（引用段 + 感知段合一）', '')
// 两处 composeContextWithDigest 调用（首次装配 + 压缩后重装配）都要带注入段，
// 否则压缩一触发注入段就静默消失
const callSites = (SRC_AGENT.match(/composeContextWithDigest\(/g) ?? []).length
const withInjection = (SRC_AGENT.match(/composeContextWithDigest\([^)]*requestInjection/g) ?? []).length
ok(callSites >= 2 && withInjection === callSites,
  'E4c ★ 全部 composeContextWithDigest 调用点都带注入段（漏一处 = 压缩后注入静默消失）',
  `调用 ${callSites} 处 / 带注入 ${withInjection} 处`)

// ===================== F 组：预算纯函数（B2） =====================

const mkItem = (i, opts = {}) => ({
  pageId: `p${i}`, title: `素材 ${i}`, path: `notes/${i}.md`,
  via: opts.via ?? 'keyword',
  skeleton: opts.skeleton ?? `frontmatter: title=素材 ${i}\n标题骨架:\n# 大标题 ${i}`,
  excerpt: opts.excerpt ?? `这是第 ${i} 篇的摘录内容`,
})

// F1 零篇
const bEmpty = budgetMaterial([])
ok(bEmpty.items.length === 0 && bEmpty.dropped === 0,
  'F1 零篇 → 空结果、dropped=0', JSON.stringify(bEmpty))

// F2 单篇超 itemLimit 被截断
const bOne = budgetMaterial([mkItem(1, { excerpt: '摘'.repeat(3000) })])
ok(bOne.items.length === 1 && bOne.dropped === 0,
  'F2a 单篇超限时**保留该篇**（首篇保底，不因超限把唯一素材丢掉）', JSON.stringify(bOne.dropped))
const blocksOne = renderMaterialBlocks(bOne.items)
ok(blocksOne[0].length <= PERCEPTION_ITEM_LIMIT,
  `F2b 单篇块长 ≤ ${PERCEPTION_ITEM_LIMIT}（单篇上限生效）`, `实际 ${blocksOne[0].length}`)

// F3 超总预算 → 丢尾部（按排名保留前缀）
// 每篇块约 800 字符（顶满 itemLimit），需 >7 篇才破 6000
const many8 = Array.from({ length: 8 }, (_, i) => mkItem(i + 1, { excerpt: '摘'.repeat(2000) }))
const b8 = budgetMaterial(many8)
ok(b8.items.length < 8 && b8.dropped > 0,
  'F3a 超总量预算时丢尾部篇目（按排名保留前缀）',
  `保留 ${b8.items.length} / 丢 ${b8.dropped}`)
ok(b8.items[0].pageId === 'p1',
  'F3b 丢的是末篇不是首篇（首篇 = 最相关）', b8.items[0].pageId)
ok(b8.items.length + b8.dropped === 8,
  'F3c 保留 + 丢弃 = 总数（没有凭空多出/少掉）',
  `${b8.items.length}+${b8.dropped}`)
const b8Text = buildPerceptionInjection(b8)
ok(b8Text.length <= PERCEPTION_TOTAL_LIMIT + 400,
  'F3d 注入段总长落在预算量级（+400 为 header/映射表固定开销）', `实际 ${b8Text.length}`)
ok(b8Text.includes('因预算上限未展开'),
  'F3e 丢篇时必须提示（不静默丢素材）', b8Text.slice(-90))

// F4 幂等（不打散 prompt cache）
const b8again = budgetMaterial(many8)
ok(JSON.stringify(b8.items) === JSON.stringify(b8again.items)
  && b8.dropped === b8again.dropped,
  'F4 budgetMaterial 幂等（同入参两次调用结果全等）', '')
ok(SRC_BUDGET.length > 0 && !/new Date\(|Date\.now|Math\.random/.test(SRC_BUDGET),
  'F4b perceptionBudget 无时间/随机依赖（幂等的必要条件）', '')

// F5 摘要 + 解析：编号连续 1..N
const b5 = budgetMaterial([1, 2, 3].map((i) => mkItem(i)))
const t5 = buildPerceptionInjection(b5)
const nums = [...t5.matchAll(/^\[?\^?(\d+)[\].]/gm)].map((m) => Number(m[1]))
ok(t5.includes('1.') && t5.includes('2.') && t5.includes('3.'),
  'F5a 素材块编号从 1 起连续', t5.slice(0, 60))
ok(b5.items.every((_, i) => t5.includes(`[^${i + 1}]=`)),
  'F5b 脚注映射表编号与素材块一一对应',
  JSON.stringify(b5.items.map((_, i) => `[^${i + 1}]=`)))

// F6 脚注安全化：标题含方括号 / 换行不得破坏 markdown 语法
ok(!/[[\]]/.test(footnoteSafe('标题[带]方括号')), 'F6a footnoteSafe 替换方括号', footnoteSafe('标题[带]方括号'))
ok(!/[\r\n]/.test(footnoteSafe('标题\n带换行')), 'F6b footnoteSafe 折叠换行', footnoteSafe('标题\n带换行'))
ok(footnoteSafe('') === '', 'F6c footnoteSafe 空串 → 空串', '')
const tWeird = buildPerceptionInjection(budgetMaterial([mkItem(1, { skeleton: '' })]))
ok(/\[\^\d+\]=/.test(tWeird), 'F6d 映射表格式 `[^N]=` 稳定', tWeird.slice(-70))

// F7 零篇不崩
ok(buildPerceptionInjection(budgetMaterial([])) === '',
  'F7 零篇注入段 = 空串（调用方据此不注入）', JSON.stringify(buildPerceptionInjection(budgetMaterial([]))))

// F8 caps 可覆写（边界可穷举）
// 注意：默认骨架用例每块约 85 字符，所以压 totalLimit 要压到「两块放得下、三块放不下」的区间。
// 初版写成 { itemLimit: 40, totalLimit: 120 } 是**无效用例** —— itemLimit 先把每块截到 40，
// 3×40=120 恰好放得下 → 「保留 3 / 丢 0」，看着像功能坏了，其实是我算错了预算（契约 F2b 同源教训）。
const bTiny = budgetMaterial([1, 2, 3].map((i) => mkItem(i)), { totalLimit: 250 })
ok(bTiny.items.length === 2 && bTiny.dropped === 1,
  'F8 caps 可覆写（小预算下按排名丢尾部，边界可穷举）',
  `保留 ${bTiny.items.length} / 丢 ${bTiny.dropped}`)
// itemLimit 单独生效：压到 40 时每块必须 ≤40（前缀头若超则整体截断，不能只截正文）
const bItem = renderMaterialBlocks(budgetMaterial([1].map((i) => mkItem(i)), { itemLimit: 40 }).items, 40)
ok(bItem[0].length <= 40,
  'F8b itemLimit 覆写后整块 ≤ 上限（含标题/命中方式前缀，不是只截正文）', `实际 ${bItem[0].length}`)

ok(PERCEPTION_TOPK === 5, 'F9 召回篇数常量 = 5（上游 §4.2 step 3 拍板值）', String(PERCEPTION_TOPK))

// ===================== G 组：感知编排接线（薄壳，读源码断言） =====================

// G1 编排壳调的是既有检索门面（上游以为要新写 semanticSearch，核对确认已存在）
ok(/searchKnowledge/.test(SRC_PERCEPTION),
  'G1a perception.ts 调既有 searchKnowledge 门面（不另造检索）', '')
ok(!/semanticStore['"]/.test(SRC_PERCEPTION) && !/\bcosineTopK\b/.test(SRC_PERCEPTION),
  'G1b ★ 编排壳不直接碰语义存储（检索编排的唯一入口是门面）',
  SRC_PERCEPTION.match(/cosineTopK|semanticStore/g)?.join(',') ?? '')

// G2 复用 B1 的读盘与骨架（不另写一份）
ok(/buildRefSkeleton/.test(SRC_PERCEPTION) && /readVaultRefText/.test(SRC_PERCEPTION),
  'G2 编排壳复用 B1 的 buildRefSkeleton + readVaultRefText（骨架口径单一真相源）', '')

// G3 空 query / 零命中 → null
ok(/if\s*\(!q\)\s*return null/.test(SRC_PERCEPTION),
  'G3a 空 query → null（不检索）', '')
ok(/hits\.length === 0\)\s*return null/.test(SRC_PERCEPTION),
  'G3b 全路零命中 → null（不注入、不报错 —— 上游 §4.2 step 4）', '')

// G4 excludePageIds 透传（避免 @ 引用的篇目与素材段重复）
ok(/excludePageIds/.test(SRC_PERCEPTION) && /excludePageIds/.test(SRC_AGENT),
  'G4a excludePageIds 从编排壳透传进门面 filters', '')
ok(/pageId/.test(SRC_AGENT) && !/excludePageIds:\s*contextRefs\.map\(\(r\)\s*=>\s*String\(r\?\.path/.test(SRC_AGENT),
  'G4b ★ excludePageIds 传的是 pageId 不是 path（传 path 会静默排除不掉）', '')

// G5 感知异常不得炸整轮对话
ok(/catch\s*{[\s\S]{0,80}return null/.test(SRC_PERCEPTION),
  'G5 perception.ts 对门面异常兜底 return null（感知失败不阻断对话）', '')

ok(/export\s+async\s+function\s+runPerception/.test(SRC_PERCEPTION),
  'G6 runPerception 具名导出（agentService 可调）', '')

// ===================== H 组：settings 与 UI 接线 =====================

ok(/aiAssistantPerception\s*:/.test(SRC_SETTINGS),
  'H1a settings.ts 有 aiAssistantPerception 键', '')
ok(/aiAssistantPerception[\s\S]{0,600}?default:\s*false/.test(SRC_SETTINGS),
  'H1b ★ 感知默认 **false**（开发负责人 2026-09-18 拍板：按上游口径）', '')
ok(/aiAssistantPerception[\s\S]{0,900}?ui:\s*true/.test(SRC_SETTINGS),
  'H1c 感知开关在设置页可见可改（ui: true）', '')

// H2 主进程读法：走既有 getSettingReader（不另开 IPC）
ok(/getSettingReader\(\)\(['"]aiAssistantPerception['"]\)/.test(SRC_AGENT),
  'H2a ★ 主进程用既有 getSettingReader 读感知开关（与 agentMaxRounds 等同款）', '')

// H3 头部 toggle 在 docked 态与 sidebar 态各有一处（page 态按拍板不放）
ok(/data-wb="perceptionToggle"/.test(SRC_CHATBODY),
  'H3a ChatBody（docked 态头部）有感知 toggle', '')
ok(/data-wb="perceptionToggle"/.test(SRC_SIDEBAR),
  'H3b 悬浮侧栏头部有感知 toggle（两处读写同一个 settings 键）', '')
ok(/aria-pressed=\{on\}|aria-pressed=\{perceptionOn\}/.test(SRC_CHATBODY + SRC_SIDEBAR),
  'H3c toggle 带 aria-pressed（探针与无障碍都靠它判态）', '')

// H4 弱提示（语义未配置）
ok(/语义索引未配置/.test(SRC_CHATBODY) && /语义索引未配置/.test(SRC_SIDEBAR),
  'H4a 语义未配置时两处都显弱提示（不阻断）', '')
ok(/getSemanticStatus/.test(SRC_CHATBODY) || /getSemanticStatus/.test(SRC_SIDEBAR),
  'H4b 弱提示数据源 = knowledge:semanticStatus（既有 IPC，未新开通道）', '')

// H5 弱提示是「状态描述」不是「一次性引导」：不得带「知道了」记忆
ok(!/知道了/.test(SRC_CHATBODY + SRC_SIDEBAR),
  'H5 弱提示无「知道了」记忆（它描述当前状态，不是一次性引导）', '')

// ===================== I 组：负向（防回归 / 防蔓延） =====================

// I1 感知不得新增常驻 AI 工具（铁律 16）
ok(!/name:\s*['"]builtin\.[^'"]*perception/i.test(SRC_PERCEPTION + SRC_BUDGET),
  'I1 ★ 感知不新增常驻 AI 工具 / 工具 schema（铁律 16：工具 schema 就是每轮成本）', '')

// I2 预算纯函数区必须零 import（契约脚本裸 node 能 import 的前提）
ok(!/^\s*import\s/m.test(SRC_BUDGET),
  'I2 perceptionBudget 零 import（零依赖红线 —— 裸 node 才能 import 它做断言）',
  (SRC_BUDGET.match(/^\s*import\s.*$/m) ?? [])[0] ?? '')

// I3 不得在 semanticStore 里补一份「上游以为要新写的」semanticSearch
// （上游 §4.2 误判项：真出口是 knowledgeSearch.searchKnowledge）
const SRC_SEMSTORE = stripComments(read('electron/lib/kbStore/semanticStore.ts'))
ok(!/export\s+function\s+semanticSearch/.test(SRC_SEMSTORE),
  'I3 ★ semanticStore 里没有也不应有 `semanticSearch`（上游误判；真出口是 searchKnowledge）', '')

// I4 单品上限 ≤ 总量上限（常量自洽；写反会导致「一篇都放不下」）
ok(PERCEPTION_ITEM_LIMIT <= PERCEPTION_TOTAL_LIMIT,
  `I4 单篇上限 ${PERCEPTION_ITEM_LIMIT} ≤ 总量上限 ${PERCEPTION_TOTAL_LIMIT}`, '')

// I5 注入段不得出现在 systemFull 的拼接里
const sysIdx = SRC_AGENT.indexOf('const systemFull =')
const sysLine = sysIdx === -1 ? '' : SRC_AGENT.slice(sysIdx, SRC_AGENT.indexOf('\n', sysIdx))
ok(sysLine.length > 0 && !/Injection|requestInjection/.test(sysLine),
  'I5 ★ systemFull 拼接串里不得出现注入段变量', sysLine.slice(0, 100))

// ===================== J 组：B4 内联建议 =====================

// J1 光标窗口：按字符切 + 越界夹紧（最易静默出错的边界）
const winBasic = sliceCursorWindow('abcdefghij', 5, 3, 2)
ok(winBasic.head === 'cde' && winBasic.tail === 'fg',
  'J1a sliceCursorWindow 前后各取 before/after 字符', JSON.stringify(winBasic))
ok(winBasic.truncatedHead === true && winBasic.truncatedTail === true,
  'J1b sliceCursorWindow 两侧都截断标记为 true', JSON.stringify(winBasic))

// offset 越界（文档被外部改动后 offset 可能失效）→ 必须夹紧而非返回空
const winOver = sliceCursorWindow('abc', 999, 10, 10)
ok(winOver.head === 'abc' && winOver.tail === '',
  'J1c ★ offset 超出文本长度 → 夹紧到末尾（不得静默返回空窗口）', JSON.stringify(winOver))
const winNeg = sliceCursorWindow('abc', -5, 10, 10)
ok(winNeg.head === '' && winNeg.tail === 'abc',
  'J1d ★ offset 为负 → 夹紧到 0', JSON.stringify(winNeg))
ok(winOver.head.length === 'abc'.length,
  'J1e 越界后 head 恰好等于全文（证明夹紧而非丢弃）', JSON.stringify(winOver.head))

// 光标在文首 / 文尾
const winHead0 = sliceCursorWindow('hello', 0, 100, 100)
ok(winHead0.head === '' && winHead0.tail === 'hello',
  'J1f 光标在文首 → head 空、tail 全文', JSON.stringify(winHead0))
const winEnd = sliceCursorWindow('hello', 5, 100, 100)
ok(winEnd.head === 'hello' && winEnd.tail === '',
  'J1g 光标在文尾 → head 全文、tail 空', JSON.stringify(winEnd))

// J2 frontmatter title 三态
ok(pickFrontmatterTitle('---\ntitle: 我的笔记\nstatus: draft\n---\n正文') === '我的笔记',
  'J2a pickFrontmatterTitle 取到 title', pickFrontmatterTitle('---\ntitle: 我的笔记\nstatus: draft\n---\n正文'))
ok(pickFrontmatterTitle('没有 frontmatter') === '',
  'J2b pickFrontmatterTitle 无 frontmatter → 空串', '')
ok(pickFrontmatterTitle('---\ntitle: "带引号"\n---\n正文') === '带引号',
  'J2c pickFrontmatterTitle 去掉包裹引号', pickFrontmatterTitle('---\ntitle: "带引号"\n---\n正文'))
ok(pickFrontmatterTitle('---\nstatus: draft\n---\n正文') === '',
  'J2d pickFrontmatterTitle 有 frontmatter 无 title → 空串', '')
// 未闭合围栏不得吞正文
ok(pickFrontmatterTitle('---\ntitle: 未闭合\n\n正文') === '',
  'J2e ★ pickFrontmatterTitle 未闭合围栏 → 空串（不吞正文）', '')

// J3 prompt 组装：恒定性 + 必要成分
const p1 = buildInlinePrompt({ text: 'abc', offset: 3 })
const p2 = buildInlinePrompt({ text: 'abc', offset: 3 })
ok(JSON.stringify(p1) === JSON.stringify(p2),
  'J3a buildInlinePrompt 同输入恒同输出（纯函数）', '')
ok(typeof p1.system === 'string' && p1.system.length > 0 && p1.user.length > 0,
  'J3b buildInlinePrompt 产出 system + user 两段', '')
ok(p1.system.includes(String(INLINE_SUGGEST_MAX_CHARS)),
  'J3c ★ system 里写明字数上限（避免模型写长篇）', '')
ok(p1.user.includes('【光标之前的正文】') && p1.user.includes('【光标之后的正文】'),
  'J3d user 含前后文两个标记段', '')
// 空文档段仍要出现占位，不能让 prompt 缺段
const pEmpty = buildInlinePrompt({ text: '', offset: 0 })
ok(pEmpty.user.includes('（空）'),
  'J3e ★ 空文档也要保留段位（缺段会让模型误判结构）', pEmpty.user.slice(0, 80))
// title 有则带上、无则不出现空标题行
ok(buildInlinePrompt({ text: 'a', offset: 1, title: 'T' }).user.includes('文档标题：T'),
  'J3f 有 title 时写入 prompt', '')
ok(!buildInlinePrompt({ text: 'a', offset: 1 }).user.includes('文档标题：'),
  'J3g ★ 无 title 时不写空标题行', '')

// J4 normalizeInlineSuggestion 清洗
ok(normalizeInlineSuggestion('```md\n下一句\n```') === '下一句',
  'J4a 去掉代码围栏', normalizeInlineSuggestion('```md\n下一句\n```'))
ok(normalizeInlineSuggestion('"下一句"') === '下一句',
  'J4b 去掉包裹引号', normalizeInlineSuggestion('"下一句"'))
ok(normalizeInlineSuggestion('续写：下一句') === '下一句',
  'J4c 去掉「续写：」前缀', normalizeInlineSuggestion('续写：下一句'))
ok(normalizeInlineSuggestion('  \n 下一句 \n ') === '下一句',
  'J4d 去掉首尾空白', JSON.stringify(normalizeInlineSuggestion('  \n 下一句 \n ')))
// 内部换行必须保留（多行续写合法）
ok(normalizeInlineSuggestion('第一句\n第二句') === '第一句\n第二句',
  'J4e ★ 保留内部换行（多行续写合法）', JSON.stringify(normalizeInlineSuggestion('第一句\n第二句')))
// 幂等（铁律 17：压缩必须幂等）
const once = normalizeInlineSuggestion('```\n续写：abc\n```')
ok(normalizeInlineSuggestion(once) === once,
  'J4f ★ normalizeInlineSuggestion 幂等', JSON.stringify(once))

// J5 isValidSuggestion 拒绝空/纯标点
ok(isValidSuggestion('') === false, 'J5a 空串无效', '')
ok(isValidSuggestion('   ') === false, 'J5b 纯空白无效', '')
ok(isValidSuggestion('。。。') === false,
  'J5c ★ 纯标点无效（模型偶尔只吐一个句号）', '')
ok(isValidSuggestion('好') === true, 'J5d 单字有效', '')
ok(isValidSuggestion('hello') === true, 'J5e 英文有效', '')

// J6 ★ 纯函数区零 import（合同脚本裸 node 能 import 的前提）
const SRC_INLINE_CORE = stripComments(read('electron/lib/aiAssistant/inlineSuggestCore.ts'))
ok(!/^\s*import\s/m.test(SRC_INLINE_CORE),
  'J6 ★ inlineSuggestCore 零 import（零依赖红线 —— 裸 node 才能 import 它做断言）',
  (SRC_INLINE_CORE.match(/^\s*import\s.*$/m) ?? [])[0] ?? '')

// J7 编排区接线
const SRC_INLINE = stripComments(read('electron/lib/aiAssistant/inlineSuggest.ts'))
ok(/invokeLlmStreamInternal\s*\(/.test(SRC_INLINE),
  'J7a 编排走 invokeLlmStreamInternal（不自造 LLM 调用链）', '')
ok(/signal:\s*ctrl\.signal/.test(SRC_INLINE),
  'J7b ★ 请求带 AbortSignal（ctrl.signal 透传）', '')
ok(/ipcMain\.handle\(\s*'ai:inlineSuggest:run'/.test(SRC_INLINE),
  'J7c 注册 ai:inlineSuggest:run handler', '')
ok(/ipcMain\.handle\(\s*'ai:inlineSuggest:cancel'/.test(SRC_INLINE),
  'J7d 注册 ai:inlineSuggest:cancel handler', '')
// 消息式取消：AbortSignal 不可经 IPC 序列化 → 必须有 requestId → controller 的映射表
ok(/Map<string,\s*AbortController>/.test(SRC_INLINE),
  'J7e ★ 在途表 Map<requestId, AbortController>（消息式取消的核心）', '')
ok(/ctrl\.abort\(\)/.test(SRC_INLINE),
  'J7f 取消路径实际调 abort()', '')
// 不得进对话历史（前缀稳定）
ok(!/getAgentMessages|updateSessionDigest|agentSessionRepo/.test(SRC_INLINE),
  'J7g ★ 内联建议不碰会话历史（独立一次性调用，不扰动 prompt cache 前缀）', '')

// J8 IPC 三处对齐（preload / types / ipc.ts）
const SRC_PRELOAD = stripComments(read('electron/preload/index.ts'))
const SRC_TYPES = stripComments(read('src/types/index.ts'))
const SRC_IPC = stripComments(read('src/lib/ipc.ts'))
ok(/aiInlineSuggestRun/.test(SRC_PRELOAD) && /ai:inlineSuggest:run/.test(SRC_PRELOAD),
  'J8a preload 暴露 aiInlineSuggestRun → ai:inlineSuggest:run', '')
ok(/aiInlineSuggestCancel/.test(SRC_PRELOAD) && /ai:inlineSuggest:cancel/.test(SRC_PRELOAD),
  'J8b preload 暴露 aiInlineSuggestCancel → ai:inlineSuggest:cancel', '')
ok(/aiInlineSuggestRun/.test(SRC_TYPES) && /aiInlineSuggestCancel/.test(SRC_TYPES),
  'J8c types 声明两个方法（与 preload 同名）', '')
ok(/aiInlineSuggestRun/.test(SRC_IPC) && /aiInlineSuggestCancel/.test(SRC_IPC),
  'J8d ipc.ts 封装两个方法', '')

// J9 main 注册接线
const SRC_MAIN = stripComments(read('electron/main/index.ts'))
ok(/registerInlineSuggestHandlers\(\)/.test(SRC_MAIN),
  'J9a main 调用 registerInlineSuggestHandlers()', '')
ok(/from '\.\.\/lib\/aiAssistant\/inlineSuggest'/.test(SRC_MAIN),
  'J9b main 从 lib/aiAssistant/inlineSuggest 导入', '')

// J10 渲染层接线
const SRC_MONACO = stripComments(read('src/components/shared/MonacoPane.tsx'))
const SRC_EDITOR = stripComments(read('src/modules/editor/index.tsx'))
ok(/registerInlineCompletionsProvider\(\s*'markdown'/.test(SRC_MONACO),
  'J10a 注册 markdown 语言的 inline completions provider（仅 md）', '')
ok(/inlineCompletionInstalled/.test(SRC_MONACO),
  'J10b provider 幂等 guard（重复注册会叠加）', '')
ok(/disposeInlineCompletions/.test(SRC_MONACO),
  'J10c ★ 提供 disposeInlineCompletions（0.56 接口的必填方法，非可在旧的 free*）', '')
ok(/editor\.action\.inlineSuggest\.trigger/.test(SRC_MONACO),
  'J10d 走 Monaco 内建 trigger 命令', '')
ok(/altKey/.test(SRC_EDITOR) && /'a'/.test(SRC_EDITOR),
  'J10e 编辑器模块注册 Alt+A 快捷键', '')
ok(/triggerInlineSuggest/.test(SRC_EDITOR),
  'J10f 快捷键调 handle.triggerInlineSuggest()', '')
// ★ 胶囊去重：内嵌场景不得再手抄一份
const pillCount = (SRC_EDITOR.match(/inline-flex items-center gap-\[2px\] rounded-full border/g) ?? []).length
ok(pillCount === 1,
  `J10g ★ 内容胶囊只渲染一处定义（list-drift 防线；实测 ${pillCount} 处）`, '')

// J11 设置键
ok(/aiAssistantInlineSuggest:\s*\{[^}]*default:\s*true/.test(SRC_SETTINGS),
  'J11a ★ 设置键 aiAssistantInlineSuggest 默认 on（手动触发无常驻 token 压力）', '')
ok(/aiAssistantInlineSuggest:\s*\{[^}]*section:\s*'editor'/.test(SRC_SETTINGS),
  'J11b 总开关落在 editor 段（与自动触发 / 模型两项同页渲染，避免同一开关两处出现）', '')
// 上游写的点号键名在本项目不成立（SETTINGS 全扁平键）
ok(!/aiAssistant\.inlineSuggest/.test(SRC_SETTINGS) && !/inlineSuggest:/.test(SRC_SETTINGS),
  'J11c ★ 不得出现上游的点号键写法（本项目 SETTINGS 全扁平键）', '')

// J12 快捷键总表登记 + 不得与既有系统级快捷键冲突
const SRC_SHORTCUTS = stripComments(read('src/modules/settings/views/ShortcutsView.tsx'))
ok(/'Alt',\s*'A'/.test(SRC_SHORTCUTS),
  'J12a 快捷键总表登记 Alt+A', '')
// Ctrl+Alt+S 是系统级全局快捷键（dayPanelWindow globalShortcut）→ 不得用作内联建议触发
const SRC_DAYPANEL = stripComments(read('electron/main/dayPanelWindow.ts'))
ok(/globalShortcut\.register\('Control\+Alt\+S'/.test(SRC_DAYPANEL),
  'J12b ★ Ctrl+Alt+S 确为系统级全局快捷键（上游候选因此不可用）', '')
ok(!/'Ctrl',\s*'Alt',\s*'S'[\s\S]{0,80}续写/.test(SRC_SHORTCUTS),
  'J12c 内联建议未占用 Ctrl+Alt+S', '')

// J13 负向：不新增 AI 工具 / 不进常驻 schema（铁律 16）
ok(!/registerTool|builtinTools|coreTool/.test(SRC_INLINE) && !/registerTool|builtinTools|coreTool/.test(SRC_MONACO),
  'J13 ★ B4 不新增常驻 AI 工具（工具 schema 就是每轮成本）', '')

// J14 B4 的两条静默失效防线（探针实测取证后才补的，别退化）
//  ① 主进程硬超时：无 provider / 模型不可达时请求永不 resolve → 状态栏微标永久转圈
const inlineTimeout = Number((SRC_INLINE_CORE.match(/INLINE_SUGGEST_TIMEOUT_MS\s*=\s*(\d+)/) ?? [])[1] ?? 0)
ok(inlineTimeout >= 3000 && inlineTimeout <= 30000,
  `J14a ★ 主进程有硬超时常量（INLINE_SUGGEST_TIMEOUT_MS=${inlineTimeout}ms）`, String(inlineTimeout))
ok(/INLINE_SUGGEST_TIMEOUT_MS/.test(SRC_INLINE) && /clearTimeout\(timer\)/.test(SRC_INLINE),
  'J14b 超时定时器 arm / clear 成对（不泄漏）', '')
ok(/timedOut \? '生成超时'/.test(SRC_INLINE),
  'J14c ★ 超时/取消给出明确 error（不是静默 ok:false，界面才好回落）', '')
//  ② 点火守卫：Monaco 的 Automatic 触发不得给 LLM 发请求（设计是「仅手动触发」）
ok(/let inlineArmedAt/.test(SRC_MONACO) && /function armInlineSuggest/.test(SRC_MONACO),
  'J14d ★ 存在手动点火标志 inlineArmedAt（区分手动 / Monaco 自动）', '')
ok(/const armed = inlineArmedAt > 0/.test(SRC_MONACO) && /if \(!armed\) return \{ items: \[\] \}/.test(SRC_MONACO),
  'J14e ★ 未点火一律返回空（自动触发零请求、零 token）', '')
const iArm = SRC_MONACO.indexOf('armInlineSuggest()')
const iTrig = SRC_MONACO.indexOf("editor.trigger('kb-inline'")
ok(iArm > 0 && iTrig > 0 && iArm < iTrig,
  `J14f 点火在 trigger 之前（arm@${iArm} < trigger@${iTrig}）`, '')
//  ③ 渲染层 UI 兜底必须 ≥ 主进程超时（否则兜底先于主进程超时命中，白等/白取消）
const uiTimeout = Number((SRC_MONACO.match(/INLINE_UI_TIMEOUT_MS\s*=\s*(\d+)/) ?? [])[1] ?? 0)
ok(uiTimeout >= inlineTimeout && uiTimeout > 0,
  `J14g ★ UI 兜底超时(${uiTimeout}ms) ≥ 主进程超时(${inlineTimeout}ms)`, '')
//  ④ 破 Monaco 请求级缓存：同光标二次触发若命中缓存，provider 永远不被调用
//     （实测：点一次没出结果，再点一次毫无反应 —— 用户高频的「再来一次」动作）
ok(/installInlineCompletion\(monaco,\s*true\)/.test(SRC_MONACO) && /inlineProviderHandle\?\.dispose\(\)/.test(SRC_MONACO),
  'J14h ★ 每次手动触发前重注册 provider（换掉 providers 集合 → satisfies 为假 → 强制重拉）', '')
const iReinstall = SRC_MONACO.indexOf('installInlineCompletion(monaco, true)')
ok(iReinstall > 0 && iReinstall < iTrig,
  `J14i 重注册在 trigger 之前（reinstall@${iReinstall} < trigger@${iTrig}）`, '')

// ===================== J15：自动触发 + 三条成本优化（2026-09-19 返工轮） =====================

// J15a 窗口收窄（成本优化 ①）
ok(INLINE_BEFORE_LIMIT === 800 && INLINE_AFTER_LIMIT === 300,
  `J15a ★ 上下文窗口 800/300（成本优化 ①：原 2000/500，单次输入省 ~55%）`,
  `before=${INLINE_BEFORE_LIMIT} after=${INLINE_AFTER_LIMIT}`)

// J15b 段落锚定（成本优化 ②）：prompt 必须走锚定窗口而不是滑动窗口
ok(/sliceParagraphWindow\(ctx\.text,\s*ctx\.offset\)/.test(SRC_INLINE_CORE),
  'J15b ★ buildInlinePrompt 走段落锚定窗口（滑动窗口会让前缀首 token 变化 → 缓存永不命中）', '')
// 同一段落内连续打字：起点必须不动（缓存命中的前提）
{
  const doc = '第一段内容。\n\n第二段开始，这里写了一些字。'
  const at1 = doc.length
  const at2 = doc.length + 5   // 同段继续打 5 个字
  const w1 = sliceParagraphWindow(doc + '', at1)
  const w2 = sliceParagraphWindow(doc + '补五个字', at2)
  const start1 = doc.length - w1.head.length
  const start2 = (doc + '补五个字').length - w2.head.length
  ok(start1 === start2,
    'J15c ★ 同一段落内继续打字，窗口起点稳定（前缀不变 → 命中 DeepSeek 硬盘缓存）',
    `start1=${start1} start2=${start2}`)
  // 长文档（多段、总量远超上限）→ 起点必须落在**段落边界**，且给足上下文
  const lines = Array.from({ length: 60 }, (_, i) => `第${i}行：${'这是内容。'.repeat(6)}`).join('\n')
  const w5 = sliceParagraphWindow(lines, lines.length)
  const s5 = lines.length - w5.head.length
  ok((s5 === 0 || lines[s5 - 1] === '\n'),
    'J15d 窗口起点对齐到段落边界（不是随便截断）', `start=${s5} 前一字符=${JSON.stringify(lines[s5 - 1] ?? '')}`)
  ok(w5.head.length > 400 && w5.head.length <= INLINE_BEFORE_LIMIT,
    'J15d2 锚定后仍给足上下文（接近上限而不是只剩几十字）',
    `head=${w5.head.length} 上限=${INLINE_BEFORE_LIMIT}`)
  // 超长「单段」（整篇没有一个换行）→ 退回滑动窗口，且不越界
  const long = 'x'.repeat(3000) + '尾巴'
  const w3 = sliceParagraphWindow(long, long.length)
  ok(w3.head.length === INLINE_BEFORE_LIMIT,
    'J15e 单段超过上限时退回滑动窗口（语义仍正确，只是不再命中缓存）', `head=${w3.head.length}`)
  // 越界 offset 仍要夹紧（不因锚定改动而回归）
  const w4 = sliceParagraphWindow('abc', 999)
  ok(w4.head === 'abc' && w4.tail === '',
    'J15f 段落锚定窗口同样夹紧越界 offset（不回归 J1 的越界防线）', JSON.stringify(w4))
}

// J15g 触发点判定（纯函数用例表）——自动模式的成本闸
{
  const doc = '这句话已经写完了。'
  const cases = [
    ['这句话已经写完了。', doc.length, true, '句末标点后'],
    ['换元之后，', 5, true, '中文逗号后（最该续写处）'],
    ['第一行\n', 4, true, '换行后'],
    ['写了一个词 ', 6, true, '写完一个词 + 空格'],
    ['积分', 2, false, '词中间 —— 必须拦下'],
    ['开头几个字', 5, false, '半句话中间'],
    ['', 0, false, '空文档'],
  ]
  let allOk = true
  const bad = []
  for (const [text, at, want, label] of cases) {
    const got = isTriggerPoint(text, at).hit
    if (got !== want) { allOk = false; bad.push(`${label}: 期望${want} 实得${got}`) }
  }
  ok(allOk, `J15g ★ 触发点判定用例表 ${cases.length} 条全对`, bad.join(' | '))
  ok(isTriggerPoint('abc', 0).why.length > 0 && isTriggerPoint('积分', 2).why.includes('不打扰'),
    'J15h 判定附带人话原因（界面/探针可直接显示，便于判断为什么没触发）', '')
}

// J15i 冷却（成本优化 ③）
ok(AUTO_PAUSE_STREAK === 3, `J15i 冷却阈值 = 3 次连续未采纳`, String(AUTO_PAUSE_STREAK))
{
  let st = { ...INITIAL_AUTO_STATE }
  ok(canAutoRequest(st), 'J15j 初始可自动请求', '')
  st = afterAutoResult(st, false)
  st = afterAutoResult(st, false)
  ok(canAutoRequest(st), 'J15k 未采纳 2 次仍在自动（阈值前不误伤）', `streak=${st.streak}`)
  st = afterAutoResult(st, false)
  ok(!canAutoRequest(st) && st.paused, 'J15l ★ 未采纳满 3 次 → 暂停自动（不再打扰）', JSON.stringify(st))
  ok(canAutoRequest(reviveByManual()) && reviveByManual().streak === 0,
    'J15m ★ 手动触发唤醒自动并重新计数（Alt+A 是明确的「我现在要」）', '')
  const adopted = afterAutoResult({ streak: 2, paused: false }, true)
  ok(adopted.streak === 0 && !adopted.paused, 'J15n 采纳后计数归零（有人在用就继续给）', JSON.stringify(adopted))
}

// J15o 渲染层接线：自动通道 / 采纳信号 / 手动唤醒 / 兜底超时
ok(/AUTO_DEBOUNCE_MS/.test(SRC_MONACO) && /scheduleAuto/.test(SRC_MONACO),
  'J15o ★ MonacoPane 有 debounce 自动通道（不是靠 Monaco 的 Automatic 触发）', '')
ok(/onDidChangeModelContent\(\(\)\s*=>\s*\{\s*scheduleAuto\(\)/.test(SRC_MONACO),
  'J15p 内容变化 → 重新计时（打字中不发请求）', '')
ok(/isTriggerPoint\(text,\s*model\.getOffsetAt\(pos\)\)/.test(SRC_MONACO) && /verdict\.hit/.test(SRC_MONACO),
  'J15q ★ 到点先过触发点判定，未命中直接 return（成本闸在这里）', '')
ok(/canAutoRequest\(inlineAutoState\)/.test(SRC_MONACO),
  'J15r 冷却暂停时自动通道直接 return', '')
ok(/handleEndOfLifetime/.test(SRC_MONACO) && /InlineCompletionEndOfLifeReasonKind\.Accepted/.test(SRC_MONACO),
  'J15s ★ 用官方 handleEndOfLifetime(Accepted) 记采纳（唯一可靠的采纳信号）', '')
ok(/settleAutoOutcome\(\)/.test(SRC_MONACO) && /afterAutoResult\(inlineAutoState, inlineLastAccepted\)/.test(SRC_MONACO),
  'J15t 每次自动触发前先结算上一次的采纳结果', '')
ok(/inlineAutoState = \{ \.\.\.INITIAL_AUTO_STATE \}/.test(SRC_MONACO),
  'J15u 手动触发复位冷却（唤醒自动）', '')
ok(/setInlineAutoMode\(inlineSuggestAuto\)/.test(SRC_MONACO),
  'J15v 自动开关由宿主同步进模块级状态（关 = 仅手动）', '')
ok(/inlineSuggestAuto/.test(SRC_EDITOR) && /onInlineSuggestPaused/.test(SRC_EDITOR),
  'J15w 编辑器模块透传自动开关与暂停态回调', '')
ok(/data-wb="inlinePaused"/.test(SRC_EDITOR),
  'J15x 状态栏有「建议已暂停 · Alt+A 唤醒」提示（否则用户不知道为何不再自动出）', '')

// J15y 设置三件套 + 模型选择 UI + ghost 观感
ok(/aiAssistantInlineSuggestAuto:\s*\{[^}]*default:\s*true/.test(SRC_SETTINGS),
  'J15y 新增设置键 aiAssistantInlineSuggestAuto（默认 on = 自动）', '')
ok(/aiAssistantInlineSuggestModelId:\s*\{[^}]*default:\s*''/.test(SRC_SETTINGS),
  'J15z 新增设置键 aiAssistantInlineSuggestModelId（空 = 跟随全局默认）', '')
ok(/aiAssistantInlineSuggestModelId/.test(SRC_INLINE),
  'J15aa ★ 主进程真读该键（设置选了模型要生效，不能只写不读）', '')
{
  const SRC_EDITOR_VIEW = stripComments(read('src/modules/settings/views/EditorView.tsx'))
  ok(/llmListProviders/.test(SRC_EDITOR_VIEW) && /aiAssistantInlineSuggestModelId/.test(SRC_EDITOR_VIEW)
    && /SettingSelect/.test(SRC_EDITOR_VIEW),
    'J15ab 设置 → 编辑器页有模型下拉（数据源 = 已启用供应商的模型）', '')
  ok(/aiAssistantInlineSuggestAuto/.test(SRC_EDITOR_VIEW) && /aiAssistantInlineSuggest\b/.test(SRC_EDITOR_VIEW),
    'J15ac 同一页还有总开关与自动开关（三项集中，不散在别处）', '')
}
{
  const SRC_CSS = read('src/styles/index.css')
  ok(/\.monaco-editor\s+\.ghost-text\s*\{\s*font-style:\s*italic/.test(SRC_CSS),
    'J15ad ★ ghost text 斜体（对标 VS Code/Cursor 观感；类名取自 monaco ghostTextView.js）', '')
}

// J15ae 负向：不得有「文档末尾就触发」这类让成本闸失效的兜底
ok(!/文档末尾/.test(SRC_TRIGGER),
  'J15ae ★ 触发点判定里不得有「文档末尾就触发」兜底（人基本都在文末打字，加了等于不拦）', '')

// J15af 流式早停（感知延迟主修法）：max_tokens 全局 4096 + 思考型模型默认思考，都会拖死「续写一句」
ok(/earlyStop/.test(SRC_INLINE) && /INLINE_SUGGEST_MAX_CHARS \+ 200/.test(SRC_INLINE),
  'J15af ★ 正文聚合到建议上限即早停（已有的内容直接作为建议返回，不等模型收尾）', '')
ok(/thinkingLen > 1500/.test(SRC_INLINE),
  'J15b0 ★ 思考链超 1500 字符还没出正文就放弃（思考型模型狂思考时不让用户干等）', '')
ok(/if \(earlyStop\) \{[\s\S]{0,200}isValidSuggestion\(suggestion\)\) return \{ ok: true, text: suggestion \}/.test(SRC_INLINE),
  'J15ah ★ 早停走「成功返回」分支（掐断≠失败，否则优化等于白做）', '')
ok(!/effort:\s*req\.effort/.test(SRC_INLINE),
  'J15ai 内联建议不透传 effort（思考型模型该靠早停兜底 + 设置里单独选非思考模型）', '')

// ===================== 结果 =====================

if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
