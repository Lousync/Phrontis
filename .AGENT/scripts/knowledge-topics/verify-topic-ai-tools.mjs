// 契约验证：笔记主题的 AI 工具（v3.28.0 B 批，docs/knowledge-feed-topics-plan.md §5）。
//
// 为什么需要：这两个工具的危险点不在"能不能跑"，而在**边界悄悄被放宽**——
//   · 写工具本该只改成员关系，某天有人为了"顺手"在 handler 里加了移动文件；
//   · 写工具本该进确认模式的可暂存白名单，漏登记后 confirm 模式下它会**从模型视野消失**
//     （表现为「AI 说没有这个能力」，不是报错）；
//   · 读工具误挂 write，或写工具误标 readOnly，权限系统会整个失效；
//   · 名字 → 主题的桥两边各写一份判重口径，迟早建出「面试高频」和「面试高频 」两个主题。
//
// 覆盖：
//   静态 ① 注册面：readOnly / requires / tier / module / schema 体积
//   静态 ② 边界：写工具只调主题数据层、有广播、无移动 / 重命名 / 删除主题工具
//   静态 ③ 接线：STAGEABLE_WRITE_TOOLS、builtin.tool.request 清单、审计基线、AI 手册
//   运行时 ④ 真盘语义：名字桥幂等、成员增删幂等、source=ai、按路径加成员、不动 Markdown 文件
//
// 跑法（core 仓的无扩展名相对导入 Node 直接跑不了，必须先打包，同 verify-vocab-repo.mjs）：
//   ./node_modules/esbuild/bin/esbuild .AGENT/scripts/knowledge-topics/verify-topic-ai-tools.mjs \
//     --bundle --platform=node --format=esm --outfile=tmp/verify-topic-ai-tools.mjs
//   node tmp/verify-topic-ai-tools.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'
import { configureCore, setCurrentVault } from '../../../../phrontis-core/src/kbStore/vaultContext.ts'
import {
  vaultGetTopics, vaultResolveOrCreateTopic, vaultPatchTopicMembers,
} from '../../../../phrontis-core/src/kbStore/knowledgeTopicsRepo.ts'
import { getKnowledgeIndex } from '../../../../phrontis-core/src/kbStore/knowledgeIndex.ts'
import { STAGEABLE_WRITE_TOOLS } from '../../../electron/lib/aiAssistantStageable.ts'

const ROOT = process.cwd()
let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}${extra ? `  [${extra}]` : ''}`) } else { fail++; console.log(` FAIL  ${label}${extra ? `  [${extra}]` : ''}`) }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ===== 静态：切出每个 registerTool 块（与 ai-tools-audit 同口径，缩进 2 空格起止）=====
const lines = read('electron/lib/builtinTools.ts').split(/\r?\n/)
const starts = []
lines.forEach((l, i) => { if (/^ {2}registerTool\(\{$/.test(l)) starts.push(i) })
const closeOf = (from) => {
  for (let i = from + 1; i < lines.length; i++) if (/^ {2}\}\);?\s*$/.test(lines[i])) return i
  return lines.length - 1
}
const blockOf = (name) => {
  for (const s of starts) {
    const text = lines.slice(s, closeOf(s) + 1).join('\n')
    if (new RegExp(`name:\\s*'${name.replace(/\./g, '\\.')}'`).test(text)) return text
  }
  return ''
}
const schemaChars = (text) => {
  const at = text.indexOf('inputSchema:')
  if (at < 0) return 0
  const start = text.indexOf('{', at)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1).split(/\r?\n/)
          .filter((l) => !/^\s*\/\//.test(l))
          .map((l) => l.trim()).join('').length
      }
    }
  }
  return 0
}
const allToolNames = starts.map((s) => (lines.slice(s, closeOf(s) + 1).join('\n').match(/name:\s*'([^']+)'/) || [])[1]).filter(Boolean)

console.log('\n--- ① 注册面：读 / 写两个工具 ---')
const READ = 'builtin.knowledge.topics'
const WRITE = 'builtin.knowledge.topic.assign'
const readBlock = blockOf(READ)
const writeBlock = blockOf(WRITE)
const readCode = stripComments(readBlock)
const writeCode = stripComments(writeBlock)
ok(!!readBlock, '① 注册读工具 builtin.knowledge.topics')
ok(!!writeBlock, '① 注册写工具 builtin.knowledge.topic.assign')
ok(/readOnly:\s*true/.test(readCode) && !/requires:\s*'write'/.test(readCode), '① 读工具 readOnly、不要求 write')
ok(/readOnly:\s*false/.test(writeCode) && /requires:\s*'write'/.test(writeCode), '① 写工具 requires=write')
ok(/tier:\s*'ondemand'/.test(readCode) && /tier:\s*'ondemand'/.test(writeCode), '① 两个都 tier=ondemand（铁律 16 新工具默认折叠）')
ok(/module:\s*'knowledge'/.test(readCode) && /module:\s*'knowledge'/.test(writeCode), '① 都挂 knowledge 模块（受该模块权限档约束）')
ok(['topic', 'pageId', 'includeMembers'].every((k) => new RegExp(`\\b${k}:\\s*\\{`).test(readCode)),
  '① 读工具入参 = topic / pageId / includeMembers')
ok(['topicId', 'name', 'add', 'remove'].every((k) => new RegExp(`\\b${k}:\\s*\\{`).test(writeCode)),
  '① 写工具入参 = topicId / name / add / remove')
ok(schemaChars(readBlock) > 0 && schemaChars(readBlock) <= 800, '① 读工具 schema ≤800 字符', `schema=${schemaChars(readBlock)}`)
ok(schemaChars(writeBlock) > 0 && schemaChars(writeBlock) <= 800, '① 写工具 schema ≤800 字符', `schema=${schemaChars(writeBlock)}`)

console.log('\n--- ② 边界：只改成员关系 ---')
ok(/vaultGetTopics\(\)/.test(readCode), '② 读工具走数据层 vaultGetTopics')
ok(/vaultResolveOrCreateTopic/.test(writeCode) && /vaultPatchTopicMembers/.test(writeCode), '② 写工具走名字桥 + 成员补丁')
ok(/broadcastDataChanged\('knowledge'\)/.test(writeCode), '② 写工具写后广播 knowledge（铁律 1）')
ok(!/broadcastDataChanged/.test(readCode), '② 读工具不广播')
ok(!/vaultMove|handleTreeMove|vaultRename|handleTreeRename|trashWorkspacePath|unlinkSync/.test(writeCode),
  '② 负数：写工具不移动 / 重命名 / 删除任何文件')
ok(!allToolNames.some((n) => /^builtin\.knowledge\.topic\.(delete|rename|create)$/.test(n)),
  '② 负数：没有 AI 建 / 删 / 改名主题的工具（只允许人工）')
ok(!/move|rename/i.test(WRITE), '② 工具名只表达"整理成员"，不暗示搬文件')

console.log('\n--- ③ 接线：暂存白名单 / 工具清单 / 基线 / 手册 ---')
ok(STAGEABLE_WRITE_TOOLS.has(WRITE), '③ 写工具在 STAGEABLE_WRITE_TOOLS（confirm 模式可预览、不被隐藏）')
ok(!STAGEABLE_WRITE_TOOLS.has(READ), '③ 读工具不该进写白名单')
const requested = blockOf('builtin.tool.request')
ok(requested.includes('knowledge.topics') && requested.includes('knowledge.topic.assign'),
  '③ builtin.tool.request 的 description 已列出两个工具（否则模型不知道能申请）')
const audit = read('.AGENT/scripts/ai-tools-audit/out-schema-baseline.txt')
ok(audit.includes(READ) && audit.includes(WRITE), '③ 审计基线已重新生成（含两个工具）')
const helpAi = read('resources/help/AI 权限与工具边界.md')
ok(/71 个内置工具/.test(helpAi), '③ AI 手册工具数已更新为 71')
ok(/只改成员关系/.test(helpAi) && /不移动文件/.test(helpAi), '③ AI 手册写明「主题只改成员、不移动文件」')
ok(/AI 也能整理/.test(read('resources/help/笔记 · 主题与总览.md')), '③ 主题手册给出 AI 整理入口')

// ===== 运行时：真盘语义（临时仓库）=====
console.log('\n--- ④ 运行时：名字桥 / 幂等 / 不动文件 ---')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-ai-'))
const vaultRoot = path.join(tmp, 'vault')
fs.mkdirSync(vaultRoot, { recursive: true })
configureCore({ userDataDir: tmp })
setCurrentVault({ rootId: 'test', name: 'test', rootPath: vaultRoot })

const mdA = path.join(vaultRoot, '计网', 'TCP.md')
const mdB = path.join(vaultRoot, '算法', '排序.md')
fs.mkdirSync(path.dirname(mdA), { recursive: true })
fs.mkdirSync(path.dirname(mdB), { recursive: true })
fs.writeFileSync(mdA, '---\nid: page-a\ntitle: TCP\n---\n\nTCP 正文\n', 'utf8')
fs.writeFileSync(mdB, '---\nid: page-b\ntitle: 排序\n---\n\n排序正文\n', 'utf8')
const beforeA = fs.readFileSync(mdA, 'utf8')
const beforeB = fs.readFileSync(mdB, 'utf8')
getKnowledgeIndex(true)

ok(vaultGetTopics().length === 0, '④ 空仓库没有主题')
const r1 = vaultResolveOrCreateTopic('  面试高频  ')
ok(r1.created && r1.topic.name === '面试高频', '④ 名字桥：不存在则新建，名字 trim')
const r2 = vaultResolveOrCreateTopic('面试高频')
ok(!r2.created && r2.topic.id === r1.topic.id, '④ 名字桥：同名不重复建（返回同一 id）')

const t1 = vaultPatchTopicMembers(r1.topic.id, { add: ['page-a'], source: 'ai' })
ok(t1.members.length === 1 && t1.members[0].source === 'ai', '④ 按 id 加成员，source 记 ai')
const t2 = vaultPatchTopicMembers(r1.topic.id, { add: ['page-a'], source: 'ai' })
ok(t2.members.length === 1, '④ 重复 add 幂等（不重复入列）')
const t3 = vaultPatchTopicMembers(r1.topic.id, { add: ['算法/排序.md'] })
ok(t3.members.length === 2 && t3.members.some((m) => m.pageId === 'page-b'), '④ 按仓库相对路径加成员也认')
const t4 = vaultPatchTopicMembers(r1.topic.id, { remove: ['page-a'] })
ok(t4.members.length === 1 && !t4.members.some((m) => m.pageId === 'page-a'), '④ remove 只解散关系')
const t5 = vaultPatchTopicMembers(r1.topic.id, { remove: ['page-a'] })
ok(t5.members.length === 1, '④ 重复 remove 幂等（不报错）')

let threw = false
try { vaultPatchTopicMembers(r1.topic.id, { add: ['不存在的笔记.md'] }) } catch { threw = true }
ok(threw, '④ 加不存在的笔记当场报错（不静默吞掉）')

const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.knowbase', 'modules', 'knowledge', 'topics.json'), 'utf8'))
ok(Array.isArray(raw.topics) && raw.topics.length === 1, '④ 只写 topics.json 一处')
ok(fs.readFileSync(mdA, 'utf8') === beforeA && fs.readFileSync(mdB, 'utf8') === beforeB,
  '④ 负数：两篇 Markdown 一个字节都没变（不写 frontmatter、不搬文件）')
const vaultFiles = fs.readdirSync(vaultRoot).filter((n) => n !== '.knowbase').sort()
ok(vaultFiles.join(',') === '算法,计网', '④ 负数：仓库顶层没有多出文件（没有为归类搬目录）', vaultFiles.join(','))

console.log(`\n${fail ? `FAIL ${fail} 项失败` : 'PASS 全部通过'}（${pass}/${pass + fail}）`)
process.exit(fail ? 1 : 0)
