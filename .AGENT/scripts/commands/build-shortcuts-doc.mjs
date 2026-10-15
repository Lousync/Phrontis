#!/usr/bin/env node
/**
 * 生成器：`resources/help/键盘快捷键.md` 的**表格区** ← 指令表真源（src/lib/commandRegistry.ts）
 *
 * 为什么只生成表格、不全量生成该篇：
 *   该篇的 frontmatter `keywords` 与各节散文是**手写且调过检索排序**的 ——
 *   2026-10-13 §43 记过一个实例：给《模块一览》加一个关键词 `快捷指令`，它就在用例
 *   「快捷键有哪些」上抢分超过正主《键盘快捷键》（同分 22 → 靠标题反查反超）。
 *   全量生成会把这类调优冲掉，而检索排序退化**没有任何报错**。故：表是数据（生成），
 *   散文与 keywords 是文案（手写）。
 *
 * 标记协议（每节一张表，节标题与散文都在标记之外）：
 *     <!-- GEN:keytable ids=kb-new,kb-close-tab,kb-next-tab -->
 *     | 快捷键 | 功能 |
 *     |--------|------|
 *     | `Ctrl` `N` | 新建知识页（文件树内联命名，落点跟随选中目录） |
 *     <!-- /GEN -->
 *
 * `ids` 是**编辑层面的归节决定**（手册的节 ≠ 设置页的组，见 docs/command-registry-plan.md §3.3），
 * 但它受契约约束：61 条命令 id 必须在全部标记里**恰好各出现一次**（完整划分）——所以
 * 「漏了一条」「被两条节重复收录」都跑不过契约，编辑自由不会退化成漏登记。
 *
 * 不用时间戳（重跑必须零 diff，同铁律 24 的 CHANGELOG → data.ts）。
 *
 * 用法：
 *   node .AGENT/scripts/commands/build-shortcuts-doc.mjs           # 写盘
 *   node .AGENT/scripts/commands/build-shortcuts-doc.mjs --check   # 只比对，不一致则非零退出
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { COMMANDS, commandById, altsToMarkdown } from '../../../src/lib/commandRegistry.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const DOC = resolve(ROOT, 'resources/help/键盘快捷键.md')

const START = /^<!--\s*GEN:keytable\s+ids=([^>]*?)\s*-->$/
export const END = '<!-- /GEN -->'

/** 从标记里取出 id 列表（保持声明顺序，去空、去重保序） */
export function parseIds(raw) {
  const seen = new Set()
  const out = []
  for (const t of raw.split(',')) {
    const id = t.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 一节的表：表头 + 分隔 + 每行「键帽 | 说明」 */
export function tableFor(ids) {
  const rows = ids.map((id) => {
    const c = commandById(id)
    if (!c) throw new Error(`真源里没有命令 id：${id}（生成器拒绝写出半张表）`)
    return `| ${altsToMarkdown(c.keys)} | ${c.desc} |`
  })
  return ['| 快捷键 | 功能 |', '|--------|------|', ...rows]
}

/**
 * 纯函数：把一篇 md 里的表格区重写成真源的投影。
 * 返回 { text, ids, markers, missing } —— 不碰磁盘，便于契约直接 import 比对。
 */
export function renderShortcutsDoc(md, { commands = COMMANDS } = {}) {
  const eol = md.includes('\r\n') ? '\r\n' : '\n'
  const lines = md.split(/\r?\n/)
  const out = []
  const ids = []
  let markers = 0
  let i = 0
  while (i < lines.length) {
    const m = START.exec(lines[i])
    if (!m) { out.push(lines[i]); i++; continue }
    markers++
    const list = parseIds(m[1])
    ids.push(...list)
    out.push(lines[i])
    i++
    // 跳过旧表体（含旧标记内的全部内容），直到结束标记
    while (i < lines.length && lines[i].trim() !== END) i++
    out.push(...tableFor(list))
    if (i < lines.length) { out.push(lines[i]); i++ }   // 补回结束标记
  }
  const used = new Set(commands.map((c) => c.id))
  const missing = commands.map((c) => c.id).filter((id) => !ids.includes(id))
  const unknown = ids.filter((id) => !used.has(id))
  return { text: out.join(eol), ids, markers, missing, unknown, eol }
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const check = process.argv.includes('--check')
  const before = readFileSync(DOC, 'utf8')
  let res
  try {
    res = renderShortcutsDoc(before)
  } catch (e) {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
  }
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const inSync = norm(before) === norm(res.text)

  console.log('')
  console.log(`  标记 ${res.markers} 处 · 声明 id ${res.ids.length} 条 · 真源命令 ${COMMANDS.length} 条`)
  if (res.missing.length) console.log(`  [警告] 未被任何标记收录：${res.missing.join(', ')}`)
  if (res.unknown.length) console.log(`  [警告] 标记里引用了不存在的 id：${res.unknown.join(', ')}`)

  if (check) {
    if (inSync && !res.missing.length && !res.unknown.length) {
      console.log('PASS  手册表格区与真源一致')
      process.exit(0)
    }
    console.log('FAIL  手册表格区与真源不一致 —— 跑 `node .AGENT/scripts/commands/build-shortcuts-doc.mjs` 重新生成')
    if (!inSync) {
      const a = norm(before).split('\n')
      const b = norm(res.text).split('\n')
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`  首个差异在第 ${i + 1} 行：`)
          console.log(`    盘上: ${a[i] ?? '(无)'}`)
          console.log(`    应为: ${b[i] ?? '(无)'}`)
          break
        }
      }
    }
    process.exit(1)
  }

  if (res.missing.length || res.unknown.length) {
    console.log('FAIL  标记的完整划分不成立，拒绝写盘（否则会静默漏登记）')
    process.exit(1)
  }
  if (inSync) {
    console.log('PASS  已是最新，无需写盘（重跑零 diff）')
    process.exit(0)
  }
  writeFileSync(DOC, res.text, 'utf8')
  console.log('OK    已生成 resources/help/键盘快捷键.md')
}
