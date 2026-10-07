#!/usr/bin/env node
/**
 * 契约验证：帮助手册（resources/help）的**检索质量与结构** —— 手册重编的逐篇验收闸门。
 *
 * 背景：手册的唯一消费者实际上是 AI（`builtin.help.search` → helpService 检索），
 * 用户极少直接阅读。所以「审核通过」的判定标准不是「读了觉得行」，而是
 * **真实新手问句检索必中**。手册是 md 纯文本、每查每读，错了也不报错 ——
 * 措辞改坏一个关键词，AI 就开始编造软件用法，没有任何报错能拦住。
 *
 * 验证两件事：
 *   §1 结构与上限 —— frontmatter 合法（title 必有）、keywords 非空、正文 ≤4000 字符
 *      （id 精读模式只返回前 4000 字符，超长 = 后半篇 AI 永远读不到）；
 *   §2 检索用例表 —— 每篇手册审核通过时登记 3~5 条「典型问句 → 应命中本篇（前 top 名内）」，
 *      用例直接跑 helpRetrieval 的**真实检索算法**（零依赖纯模块，非抄写实现）。
 *
 * 手册重编流程见 .AGENT/help-rewrite/CHECKLIST.md。
 *
 * 运行（任意目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/help-kb/verify-help-retrieval.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrontmatter, parseList, searchHelpIn } from '../../../electron/lib/helpRetrieval.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const HELP_DIR = join(ROOT, 'resources', 'help')

let failures = 0
let warnings = 0
const pass = (m) => console.log(`  \u2705 ${m}`)
const fail = (m) => { failures++; console.error(`  \u274c ${m}`) }
const warn = (m) => { warnings++; console.warn(`  \u26a0\ufe0f  ${m}`) }

// ---- 与 helpService.loadHelpDocs 同规则读盘（CRLF 归一、单篇失败跳过）----
function loadDocs() {
  let files = []
  try { files = readdirSync(HELP_DIR).filter(f => f.toLowerCase().endsWith('.md')) } catch { return [] }
  const out = []
  for (const f of files) {
    try {
      const parsed = parseFrontmatter(readFileSync(join(HELP_DIR, f), 'utf8'))
      if (!parsed) continue
      out.push({
        id: f.replace(/\.md$/i, ''),
        title: parsed.meta.title || f.replace(/\.md$/i, ''),
        hasTitle: Boolean(parsed.meta.title),
        category: parsed.meta.category || '未分类',
        keywords: parseList(parsed.meta.keywords),
        body: parsed.body,
      })
    } catch { /* 单篇失败不影响其它 */ }
  }
  return out
}

// ============================================================
// §1 结构与上限
// ============================================================
console.log('\n§1 结构与上限（frontmatter / keywords / 正文长度）')
const docs = loadDocs()
if (docs.length === 0) {
  fail(`resources/help 下没有可解析的手册（${HELP_DIR}）`)
} else {
  pass(`读到 ${docs.length} 篇手册`)
}
for (const d of docs) {
  const raw = readFileSync(join(HELP_DIR, `${d.id}.md`), 'utf8')
  if (!parseFrontmatter(raw)) fail(`《${d.id}》frontmatter 缺失或格式非法（必须以 --- 块开头）`)
  if (!d.hasTitle) warn(`《${d.id}》frontmatter 缺 title（回退为文件名，检索标题分拿不到）`)
  if (d.keywords.length === 0) warn(`《${d.id}》keywords 为空（口语别名是检索命中率的第一杠杆）`)
  if (d.body.length > 4000) warn(`《${d.id}》正文 ${d.body.length} 字符 > 4000 —— id 精读只返回前 4000，超出部分 AI 读不到`)
}

// ============================================================
// §2 检索用例表
// ============================================================
/**
 * 用例格式：{ q: 用户可能的问句原话, id: 应命中的手册 id, top: 允许的名次上限（默认 1） }
 * 登记纪律：每篇手册**审核通过**时，把该篇最典型的 3~5 个新手问句登记进来；
 * 用例失败时脚本会打印实际排名前 3 的命中（含得分），据此判断是文档措辞问题还是用例本身有误。
 */
const CASES = [
  { q: '快捷键有哪些', id: '键盘快捷键' },
  { q: '番茄钟怎么用', id: '番茄钟' },
  { q: '习惯打卡怎么用', id: '习惯打卡' },
  { q: '密码本忘了主密码怎么办', id: '密码本', top: 2 },
  // —— 《快速上手》2026-09-28 审核通过，登记用例 ——
  { q: '第一次用怎么上手', id: '快速上手' },
  { q: '数据存在哪里', id: '快速上手' },
  { q: '怎么写第一篇笔记', id: '快速上手' },
  { q: '软件怎么用', id: '快速上手', top: 2 },
  // —— 《AI 权限与工具边界》2026-09-28 审核通过，登记用例（原放宽的 top:3 收紧回 top:1）——
  { q: 'AI 能动我哪些数据', id: 'AI 权限与工具边界' },
  { q: 'AI 能做什么', id: 'AI 权限与工具边界' },
  { q: 'AI 权限怎么设置', id: 'AI 权限与工具边界' },
  { q: '怎么让 AI 帮我改文件', id: 'AI 权限与工具边界' },
  { q: '知识库为什么看不到我的文件', id: '读写分工与草稿机制', top: 2 },
  { q: '怎么备份数据', id: '常见问题', top: 2 },
  { q: '博客怎么写', id: '博客写作' },
  // —— 《工作台左栏与文件树模式》2026-09-29 随「文件树模式功能化」新增（v3.4.0）——
  { q: '文件树模式怎么用', id: '工作台左栏与文件树模式' },
  { q: '左栏那个树按钮是干嘛的', id: '工作台左栏与文件树模式', top: 2 },
  { q: '怎么在左栏新建文件', id: '工作台左栏与文件树模式', top: 2 },
  { q: '空白处右键没反应', id: '工作台左栏与文件树模式', top: 2 },
  { q: '在资源管理器改了文件软件会更新吗', id: '工作台左栏与文件树模式' },
  // —— 《记账》2026-10-05 新模块，登记用例 ——
  { q: '记账怎么用', id: '记账' },
  { q: '怎么做记账', id: '记账', top: 2 },
  { q: '怎么用手机生成账单导入', id: '记账', top: 2 },
  { q: '余额怎么算', id: '记账' },
  { q: '怎么隐藏余额', id: '记账' },
]

console.log('\n§2 检索用例表（典型问句 → 应命中手册）')
let caseFail = 0
for (const c of CASES) {
  const { hits } = searchHelpIn(docs, c.q, 5)
  const topN = c.top ?? 1
  const rank = hits.findIndex(h => h.id === c.id)
  const ok = rank >= 0 && rank < topN
  if (ok) {
    pass(`「${c.q}」→ 《${c.id}》${rank > 0 ? `（第 ${rank + 1} 名，上限 ${topN}）` : ''}`)
  } else {
    caseFail++
    const actual = hits.slice(0, 3).map(h => `《${h.id}》(${h.score})`).join(' ＞ ') || '（无命中）'
    fail(`「${c.q}」未进前 ${topN} 的《${c.id}》—— 实际：${actual}`)
  }
}
if (caseFail > 0) fail(`检索用例 ${caseFail}/${CASES.length} 条未过`)

// ============================================================
console.log(`\n${failures === 0 ? '\u2705 PASS' : '\u274c FAIL'} —— 结构警告 ${warnings} 条；用例 ${CASES.length - caseFail}/${CASES.length} 通过`)
process.exit(failures === 0 ? 0 : 1)
