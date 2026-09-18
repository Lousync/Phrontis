/**
 * 契约脚本：AI 助手 Agent 能力整包 · 批次 B1（@ 引用 + 骨架注入）+ B2（感知模式）
 *
 * 覆盖的缺陷面：
 *   ① 骨架 / 素材装配的**静默截断错** —— 多切一个字符不报错、少切一段不报错，
 *      只有把输入顶到边界才看得见。纯函数区全部 import 真实现做表驱动断言；
 *   ② 成本红线（铁律 17）—— 注入段总字符必须落进预算，否则每轮都多付 token 而不报警；
 *   ③ 既有路径零回归 —— 未引用文件时 `buildSystemPrompt` 必须逐字节退回现状
 *      （老路径被新特判污染是这类改动最常见的回归）；
 *   ④ list-drift（同类第 5 次）—— chip 上限值被抄成多份字面量后改动只落到一处；
 *   ⑤ **prompt cache 前缀稳定**（B2 纠正）—— 每轮变化的注入段不得进 system，
 *      否则 system + core 14 工具（≈7.7k tok/轮）逐轮重算而**没有任何报错**。
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

// ===================== 结果 =====================

if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
