#!/usr/bin/env node
/**
 * 契约验证：AI教学 · 分层要求注入串（`electron/lib/scopePrompt.ts`）
 * 方案：`E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md` §五 verify-scope-injection
 *
 * A. 纯函数真实实现执行 —— strip 类型后直接 import `electron/lib/scopePrompt.ts`（零 import，专为此）：
 *    顺序（全局 → 工作区 → 知识点 → 课时）· 每层上限（条数 / 字符）· **空层不输出标题行**（负向）·
 *    知识点级要求确实进串。
 * B. agentService 接线静态断言（剥注释）：四层来源齐全、旧三段内联拼装已下线。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-scope-injection.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- A. 纯函数真实实现
console.log('\n=== 1. buildScopePrompt：顺序 / 分层标注 / 知识点层进串 ===')
const PURE_REL = 'electron/lib/scopePrompt.ts'
const pureSrc = read(PURE_REL)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-prompt-'))
const tmpFile = path.join(tmpDir, 'scopePrompt.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const mod = await import(pathToFileURL(tmpFile).href)
const { buildScopePrompt, cutScopeLayer, SCOPE_LAYER_MAX_ITEMS, SCOPE_LAYER_MAX_CHARS, SCOPE_TRUNCATED_MARK } = mod

const full = buildScopePrompt({
  global: '- 全局条目一',
  workspace: '- 工作区条目一',
  unit: '- 知识点条目一',
  lesson: '- 课时条目一',
})
const atGlobal = full.indexOf('全局要求')
const atWorkspace = full.indexOf('工作区要求')
const atUnit = full.indexOf('知识点要求')
const atLesson = full.indexOf('课时要求')
check('四层标题齐全', atGlobal >= 0 && atWorkspace >= 0 && atUnit >= 0 && atLesson >= 0, `g=${atGlobal} w=${atWorkspace} u=${atUnit} l=${atLesson}`)
check('顺序 = 全局 → 工作区 → 知识点 → 课时', atGlobal < atWorkspace && atWorkspace < atUnit && atUnit < atLesson, `g=${atGlobal} w=${atWorkspace} u=${atUnit} l=${atLesson}`)
check('知识点级要求确实进串（内容而非仅标题）', full.includes('- 知识点条目一'), '')
check('课时层内容进串（存量课时夹口径不迁移）', full.includes('- 课时条目一'), '')
check('注入串以换行开头（与既有各 hint 拼接口径一致）', full.startsWith('\n\n'), JSON.stringify(full.slice(0, 4)))
check('每层标题带分层标注（含优先级说明）', full.includes('最细一层，优先级最高') && full.includes('覆盖以上两层'), '')

console.log('\n=== 2. 空层不输出标题行（负向）===')
const onlyUnit = buildScopePrompt({ unit: '- 只有这一条' })
check('只有知识点层时，不含全局/工作区/课时标题', !onlyUnit.includes('全局要求') && !onlyUnit.includes('工作区要求') && !onlyUnit.includes('课时要求'), onlyUnit.replace(/\n/g, '\\n').slice(0, 120))
check('只有知识点层时，仍输出知识点标题与内容', onlyUnit.includes('知识点要求') && onlyUnit.includes('- 只有这一条'), '')
const onlyLesson = buildScopePrompt({ lesson: '- 只有课时这一条' })
check('只有课时层时，不含更粗三层标题', !onlyLesson.includes('全局要求') && !onlyLesson.includes('工作区要求') && !onlyLesson.includes('知识点要求'), '')
check('空白层 = 空层（负向：全空白 → 空串）', buildScopePrompt({ global: '   \n\n', workspace: '\r\n', unit: '', lesson: '  ' }) === '', '')
check('缺省/undefined 入参安全 → 空串', buildScopePrompt({}) === '' && buildScopePrompt(undefined) === '', '')
check('单层无内容时不出现抬头', onlyUnit.includes('【分层要求（AI教学）】'), '抬头只应出现在有层时')

console.log('\n=== 3. 每层上限：条数 / 字符（超出截断并加标记）===')
check(`条数上限 = ${SCOPE_LAYER_MAX_ITEMS}`, SCOPE_LAYER_MAX_ITEMS === 12, String(SCOPE_LAYER_MAX_ITEMS))
check(`字符上限 = ${SCOPE_LAYER_MAX_CHARS}`, SCOPE_LAYER_MAX_CHARS === 1200, String(SCOPE_LAYER_MAX_CHARS))
const many = Array.from({ length: 20 }, (_, i) => `- 条目${i + 1}`).join('\n')
const cut = buildScopePrompt({ unit: many })
check('20 条时保留前 12 条', cut.includes('- 条目12') && !cut.includes('- 条目13'), '')
check('截断处追加「已截断」标记', cut.includes(SCOPE_TRUNCATED_MARK), '')
check('未截断时**不**出现标记（负向）', !buildScopePrompt({ unit: '- 甲\n- 乙' }).includes(SCOPE_TRUNCATED_MARK), '')
const longLine = `- ${'甲'.repeat(3000)}`
const cutChar = cutScopeLayer(longLine)
check('超长单层按字符截断', cutChar.truncated && cutChar.text.length <= SCOPE_LAYER_MAX_CHARS, String(cutChar.text.length))
check('恰好在限内不截断（12 条 / 短行）', cutScopeLayer(Array.from({ length: 12 }, () => '- x').join('\n')).truncated === false, '')
check('截断后不残留孤立代理项（不切半个 emoji）', !/[\uD800-\uDBFF]$/.test(cutScopeLayer(`- ${'a'.repeat(1199)}\u{1F600}`).text), '')
check('CRLF 输入不崩且被归一（无 \\r 残留）', !buildScopePrompt({ unit: '- a\r\n- b\r\n' }).includes('\r'), '')

// ---------------------------------------------------------------- B. agentService 接线
console.log('\n=== 4. agentService 接线（剥注释后静态断言）===')
const agent = stripComments(read('electron/lib/agentService.ts'))
check('agentService import 了 buildScopePrompt', agent.includes("from './scopePrompt'") && agent.includes('buildScopePrompt'), '')
check('agentService import 了知识点层读点', agent.includes('readUnitConstraintsForSession'), '')
check('四层来源齐全（global/workspace/unit/lesson）', /global:[\s\S]{0,200}workspace:[\s\S]{0,200}unit:[\s\S]{0,200}lesson:/.test(agent), '')
check('全局层读点仍是 readGlobalConstraints', agent.includes('readGlobalConstraints(getSettingReader())'), '')
check('工作区层读点仍是 readWorkspaceConstraintsForSession', agent.includes('readWorkspaceConstraintsForSession(sessionId, getSettingReader())'), '')
check('课时层读点仍是 resolveConstraintsForInjection（存量课时夹，不迁移）', agent.includes('resolveConstraintsForInjection(sessionId, getSettingReader())'), '')
check('systemFull 拼进 scopeInstHint', agent.includes('+ scopeInstHint +'), '')
check('旧三段内联拼装已下线（负向：globalInstHint / wsInstHint / instHint）', !/\bglobalInstHint\b/.test(agent) && !/\bwsInstHint\b/.test(agent) && !/\binstHint\b/.test(agent), '')
check('教学会话注入统计仍上报 constraintChars', agent.includes('constraintChars:'), '')
check('助手侧独立要求通道未被本改动波及（本会话要求 仍在）', agent.includes('本会话要求'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
