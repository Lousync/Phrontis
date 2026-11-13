#!/usr/bin/env node
/**
 * 契约验证：AI教学「分层要求」写作规范（`electron/lib/constraintAuthoring.ts`）
 *
 * 方案：2026-11-13 拍板 A+B（常驻提示 + 工具契约，纯提示词，不改功能）。
 * 断言口径：
 *   · A 段（常驻提示）含判定 / 忠实转写 / 去重 / 预算 / 回执关键词；
 *   · B 段（工具契约）含一行一条 / 动词开头 / 可判定 / 内容边界关键词；
 *   · 四层 level 提示齐全且各含区分词；
 *   · 消费方必须 import 常量，**不得**再复制一份字面量（单一真相源）；
 *   · `course.constraints.write` 的 inputSchema 仍 ≤800 字符（AGENTS.md#16）。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-constraint-authoring.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const includesAll = (text, words) => words.every((w) => String(text).includes(w))

// ---- 1. 加载真实常量（strip 类型后 import）----
const REL = 'electron/lib/constraintAuthoring.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constraint-authoring-'))
const tmpFile = path.join(tmpDir, 'constraintAuthoring.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const {
  CONSTRAINT_AUTHORING_PROMPT,
  CONSTRAINT_AUTHORING_TOOL_RULES,
  CONSTRAINT_AUTHORING_TEXT_PARAM,
  CONSTRAINT_LAYER_HINTS,
} = await import(pathToFileURL(tmpFile).href)

check('A 段存在且长度合理', typeof CONSTRAINT_AUTHORING_PROMPT === 'string'
  && CONSTRAINT_AUTHORING_PROMPT.length >= 120
  && CONSTRAINT_AUTHORING_PROMPT.length <= 400, String(CONSTRAINT_AUTHORING_PROMPT?.length ?? 0))
check('A 段含判定 / 忠实 / 去重 / 预算 / 回执关键词', includesAll(CONSTRAINT_AUTHORING_PROMPT, [
  '规则清单', '不擅自加码', '先问', '读同层', '同义条目', '≤8 条', '≤50 字', 'items/chars/truncated', '回执',
]))
check('B 段含形式 / 边界关键词', includesAll(CONSTRAINT_AUTHORING_TOOL_RULES, [
  '一行一条', '动词开头', '可判定', '不写背景', '抬头', '系统硬边界',
]))
check('text 参数说明含只写规则 / 单条上限', includesAll(CONSTRAINT_AUTHORING_TEXT_PARAM, [
  '只写规则', '不写说明', '≤50 字',
]))
check('四层 level 提示齐全', JSON.stringify(Object.keys(CONSTRAINT_LAYER_HINTS).sort())
  === JSON.stringify(['global', 'segment', 'unit', 'workspace']))
check('四层提示各含区分词', includesAll(CONSTRAINT_LAYER_HINTS.global, ['跨课程'])
  && includesAll(CONSTRAINT_LAYER_HINTS.workspace, ['本课程'])
  && includesAll(CONSTRAINT_LAYER_HINTS.unit, ['本知识点'])
  && includesAll(CONSTRAINT_LAYER_HINTS.segment, ['本次对话']))

// ---- 2. 消费方接线 ----
const agentSrc = fs.readFileSync(path.join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
const toolSrc = fs.readFileSync(path.join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')

check('agentService 导入并引用 A 段', agentSrc.includes('CONSTRAINT_AUTHORING_PROMPT')
  && /constraintsToolHint[\s\S]{0,2000}CONSTRAINT_AUTHORING_PROMPT/.test(agentSrc))
check('builtinTools 导入并引用 B 段三件套', toolSrc.includes('CONSTRAINT_AUTHORING_TOOL_RULES')
  && toolSrc.includes('CONSTRAINT_AUTHORING_TEXT_PARAM')
  && toolSrc.includes('CONSTRAINT_LAYER_HINTS'))
check('A 段未复制到 agentService（单一真相源）', !agentSrc.includes(CONSTRAINT_AUTHORING_PROMPT))
check('B 段未复制到 builtinTools（单一真相源）', !toolSrc.includes(CONSTRAINT_AUTHORING_TOOL_RULES))

// ---- 3. 工具 schema 体积（AGENTS.md#16：单工具 ≤800 字符）----
const findToolBlock = (source, name) => {
  const lines = source.split(/\r?\n/)
  const nameIdx = lines.findIndex((l) => l.includes(`name: '${name}'`))
  if (nameIdx < 0) return null
  let start = -1
  for (let i = nameIdx; i >= 0; i--) {
    if (/^\s{2}registerTool\(\{/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\}\);?\s*$/.test(lines[i])) { end = i; break }
  }
  return end < 0 ? null : lines.slice(start, end + 1).join('\n')
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
        return text.slice(start, i + 1)
          .split(/\r?\n/)
          .filter((l) => !/^\s*\/\//.test(l))
          .map((l) => l.trim())
          .join('').length
      }
    }
  }
  return 0
}

const writeBlock = findToolBlock(toolSrc, 'course.constraints.write')
check('course.constraints.write 工具块可定位', !!writeBlock)
const writeSchemaChars = writeBlock ? schemaChars(writeBlock) : 0
check('course.constraints.write inputSchema <= 800 字符', writeSchemaChars > 0 && writeSchemaChars <= 800, String(writeSchemaChars))

// ---- 输出 ----
let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} PASS`)
process.exit(failed ? 1 : 0)
