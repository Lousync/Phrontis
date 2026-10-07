/**
 * 契约：`.kb-fit` 容器查询退化机制（窄容器隐文字）的接线自洽（N-6 台账缺口补齐）。
 *
 * 为什么要有它：这套机制**漏接 = 静默失效** —— 类名写错、`container-name` 抄漏改、
 * `@container` 规则与定义脱节、挂了 `.kb-fit` 却无 `.kb-l*` 可隐 —— 全都不报错，
 * 只在**窄容器**下表现为「文字挤成竖排」（N-6 就是这么来的：面板当初根本没接）。
 * 本脚本把它做成通用断言，此后新增消费方自动被覆盖。
 *
 * 锁四类：
 *   ① 定义 ↔ `@container` 规则双向齐：有定义必有规则（否则容器是死的）、有规则必有定义
 *      （否则规则是孤儿）、`container-name` 必须与类名后缀一致（防复制粘贴漏改名 →
 *      新消费方继承别的容器的阈值）；
 *   ② 定义 ↔ 使用双向齐：CSS 定义的必须有人用（死定义）、src 里用的必须有定义（错字/死类）；
 *   ③ 阈值序：同一容器内 `l1 ≥ l2 ≥ l3`（l1 最先隐 ⇒ max-width 最大）；
 *   ④ N-6 接线快照：ChatBody 根挂 `.kb-fit .kb-fit-aichat`；会话消耗挂 `.kb-l1`、
 *      动作钮文字挂 `.kb-l2`；两档阈值在位；负向：动作行不得回退成裸文字。
 *
 * ★ 判据一律先剥注释（共享 strip-comments）：`bookshelf/index.tsx` 的注释里就提到
 *   `.kb-fit-pdfread`，不剥会把「注释提及」算成「代码使用」。
 *
 * 跑法（仓库根）：node --experimental-strip-types --no-warnings .AGENT/scripts/shared/verify-kb-fit.mjs
 */
import { stripComments, walkSourceFiles } from './strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? `  [${extra}]` : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? `  [${extra}]` : '')) }
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const css = stripComments(read('src/styles/index.css'))

// ---- ① 定义 ↔ @container 规则 ----
console.log('[1] 定义 ↔ @container 规则双向齐 + name 与类名一致')
const defs = [...css.matchAll(/\.kb-fit-([a-z0-9]+)\s*\{\s*container-name:\s*([a-z0-9-]+)\s*;\s*\}/g)]
  .map((m) => ({ cls: m[1], name: m[2] }))
const rules = [...css.matchAll(/@container\s+([a-z0-9-]+)\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{\s*\.kb-l(\d)\s*\{\s*display:\s*none;?\s*\}\s*\}/g)]
  .map((m) => ({ name: m[1], px: Number(m[2]), level: Number(m[3]) }))

ok(defs.length > 0, '抠到 .kb-fit-* 定义', `${defs.length} 个：${defs.map((d) => d.cls).join(',')}`)
const nameMismatch = defs.filter((d) => d.name !== `kb-${d.cls}`)
ok(nameMismatch.length === 0,
  '①a container-name 与类名后缀一致（防复制粘贴漏改名 → 继承别的容器阈值）',
  nameMismatch.map((d) => `.kb-fit-${d.cls} → ${d.name}`).join(' '))
for (const d of defs) {
  const rs = rules.filter((r) => r.name === d.name)
  ok(rs.length > 0, `①b .kb-fit-${d.cls} 有 @container ${d.name} 规则（否则容器是死的）`)
}
const orphanRules = [...new Set(rules.map((r) => r.name))].filter((n) => !defs.some((d) => d.name === n))
ok(orphanRules.length === 0, '①c 无孤儿 @container 规则（规则引用的容器都有定义）', orphanRules.join(','))

// ---- ② 定义 ↔ 使用 ----
console.log('[2] 定义 ↔ 使用双向齐（错字 / 死定义）')
const files = walkSourceFiles(join(ROOT, 'src')).filter((f) => /\.tsx?$/.test(f))
const usedFits = new Map() // name → [files]
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'))
  for (const m of src.matchAll(/kb-fit-([a-z0-9]+)/g)) {
    const rel = relative(ROOT, f).replace(/\\/g, '/')
    if (!usedFits.has(m[1])) usedFits.set(m[1], new Set())
    usedFits.get(m[1]).add(rel)
  }
}
const unknownUsed = [...usedFits.keys()].filter((n) => !defs.some((d) => d.cls === n))
ok(unknownUsed.length === 0,
  '②a 用到的 kb-fit-* 都有 CSS 定义（错字/漏定义 = 静默不生效）',
  unknownUsed.map((n) => `${n} @ ${[...usedFits.get(n)].join(',')}`).join(' '))
const unusedDefs = defs.filter((d) => !usedFits.has(d.cls))
ok(unusedDefs.length === 0, '②b 无死定义（CSS 里定义了却没人挂）', unusedDefs.map((d) => d.cls).join(','))

// ---- ③ 阈值序 ----
console.log('[3] 阈值序：同容器内 l1 ≥ l2 ≥ l3（l1 最先隐）')
for (const d of defs) {
  const rs = rules.filter((r) => r.name === d.name).sort((a, b) => a.level - b.level)
  const desc = rs.map((r) => `l${r.level}=${r.px}`).join(' ')
  let okOrder = true
  for (let i = 1; i < rs.length; i++) if (rs[i - 1].px < rs[i].px) okOrder = false
  ok(okOrder, `③ ${d.cls} 阈值单调（${desc}）`)
}

// ---- ④ N-6 接线快照 ----
console.log('[4] N-6：AI 助手面板接线（ChatBody 根 + 消耗 l1 + 钮文字 l2）')
const chatBody = stripComments(read('src/components/shared/AssistantPanel/ChatBody.tsx'))
const msgList = stripComments(read('src/components/shared/AssistantPanel/MessageList.tsx'))
ok(/className="kb-fit kb-fit-aichat[^"]*"/.test(chatBody),
  '④a ChatBody 根挂 .kb-fit .kb-fit-aichat（三处宿主共用同一容器）')
ok(/className="kb-l1 text-\[var\(--text-muted\)\]"/.test(msgList),
  '④b 会话消耗（TokensOf）挂 .kb-l1 —— 窄容器先隐它')
ok((msgList.match(/<span className="kb-l2">/g) ?? []).length === 4,
  '④c 四个动作钮文字各挂 .kb-l2（复制 / 编辑 / 重新生成 / 删除）',
  `实得 ${(msgList.match(/<span className="kb-l2">/g) ?? []).length} 处`)
const aichatRules = rules.filter((r) => r.name === 'kb-aichat')
ok(aichatRules.some((r) => r.level === 1 && r.px === 360) && aichatRules.some((r) => r.level === 2 && r.px === 245),
  '④d 两档阈值在位（l1=360 / l2=245，实测标定值；改值须重跑 tmp/measure-aichat-actionrow.mjs）',
  aichatRules.map((r) => `l${r.level}=${r.px}`).join(' '))
// 负向：动作行不得回退成裸文字（本轮修的就是「文字直接当 text node → 被压成竖排」）
ok(!/<Pencil size=\{10\} \/> 编辑/.test(msgList) && !/<RefreshCw size=\{10\} \/> 重新生成/.test(msgList)
  && !/<Trash2 size=\{10\} \/> 删除/.test(msgList),
  '④e 负向：动作钮文字仍是裸文本节点（无 .kb-l2 包裹）的写法已移除')
// 同容器扫尾：流式气泡的「停止」也是同一容器的裸文字（流式态下的操作行），一并挂 l2
const streamBubble = stripComments(read('src/components/shared/AssistantPanel/StreamBubble.tsx'))
ok(/<Square size=\{9\} className="fill-current" \/> <span className="kb-l2">停止<\/span>/.test(streamBubble),
  '④f 同容器扫尾：流式气泡「停止」钮文字也挂 .kb-l2（不是裸文本节点）')

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
