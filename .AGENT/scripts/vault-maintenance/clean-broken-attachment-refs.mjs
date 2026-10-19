#!/usr/bin/env node
/**
 * 清理仓库里「无效的 attachment:// 图片引用」。
 *
 * 背景：PDF→Markdown 导入曾把图片写成 `attachment://image.png` 这类**没有附件 id** 的引用，
 * 文件也从未落到附件区 —— 渲染时只会得到一个破图（Windows / Linux 都一样）。
 *
 * 处理：删除无效的图片语法（markdown `![](...)` 与 `<img src="...">`），
 * 保留同一行的其它文字；若整行只剩图片则连空行一起去掉。
 *
 * 只认「合法」引用：
 *   - `attachment://<uuid>/...`（台账附件）
 *   - `attachment://vault/<pageId>/<file>`（知识包图片）
 * 其余 `attachment://<文件名>` 一律视为坏引用。
 *
 * 用法（默认 dry-run，不改文件）：
 *   node .AGENT/scripts/vault-maintenance/clean-broken-attachment-refs.mjs --vault "/path/to/vault"
 *   node .AGENT/scripts/vault-maintenance/clean-broken-attachment-refs.mjs --vault "..." --apply --backup /tmp/refs-backup
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function parseArgs(argv) {
  const out = { vault: '', apply: false, backup: '', includeCache: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--vault') out.vault = argv[++i] || ''
    else if (a === '--apply') out.apply = true
    else if (a === '--backup') out.backup = argv[++i] || ''
    else if (a === '--skip-cache') out.includeCache = false
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

export function walkMarkdown(dir, includeCache, out) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (name === '.git' || name === 'node_modules') continue
      if (!includeCache && (name === '.cache' || name.endsWith('-md-backup-cache'))) continue
      walkMarkdown(p, includeCache, out)
    } else if (name.toLowerCase().endsWith('.md')) {
      out.push(p)
    }
  }
}

/** 合法引用：uuid 开头（可带 ?thumb=1）或 vault/<pageId>/<file> */
export function isLegal(target) {
  if (UUID_RE.test(target)) return true
  if (target.startsWith('vault/')) return true
  return false
}

export function cleanText(text) {
  const crlf = text.includes('\r\n')
  const lines = text.split(/\r?\n/)
  let removed = 0
  const kept = []
  let skipBlank = false
  for (const line of lines) {
    if (skipBlank) {
      skipBlank = false
      if (line.trim() === '') continue
    }
    let next = line
    let lineRemoved = 0
    next = next.replace(/!\[[^\]]*\]\(\s*<?attachment:\/\/([^)\s<>]+)>?\s*\)/g, (m, target) => {
      if (isLegal(target)) return m
      removed++
      lineRemoved++
      return ''
    })
    next = next.replace(/<img\b[^>]*\bsrc\s*=\s*["']attachment:\/\/([^"']+)["'][^>]*>/gi, (m, target) => {
      if (isLegal(target)) return m
      removed++
      lineRemoved++
      return ''
    })
    if (lineRemoved > 0 && next.trim() === '' && line.trim() !== '') {
      // 整行只有坏图：删行；若上一条已保留为空行，顺带吞掉下一条空行，避免连续空行
      if (kept.length > 0 && kept[kept.length - 1].trim() === '') skipBlank = true
      continue
    }
    kept.push(next)
  }
  return { text: kept.join(crlf ? '\r\n' : '\n'), removed }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help || !args.vault) {
    console.log('用法: node .AGENT/scripts/vault-maintenance/clean-broken-attachment-refs.mjs --vault <仓库> [--apply] [--backup <目录>] [--skip-cache]')
    process.exit(args.help ? 0 : 2)
  }
  const vault = resolve(args.vault)
  if (!existsSync(join(vault, '.knowbase'))) {
    console.log(`[FAIL] 不是仓库（缺少 .knowbase）: ${vault}`)
    process.exit(1)
  }

  const files = []
  walkMarkdown(vault, args.includeCache, files)
  const hits = []
  let total = 0
  for (const file of files) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    if (!text.includes('attachment://')) continue
    const result = cleanText(text)
    if (result.removed === 0) continue
    const before = text
    total += result.removed
    hits.push({ file, removed: result.removed, after: result.text, before })
  }

  if (hits.length === 0) {
    console.log(`PASS  没有无效 attachment 引用（扫描 ${files.length} 个 md）`)
    process.exit(0)
  }

  console.log(`${args.apply ? '清理' : '发现'} ${hits.length} 个文件 / ${total} 处无效引用`)
  for (const h of hits) console.log(`  ${h.removed}  ${relative(vault, h.file)}`)

  if (!args.apply) {
    console.log('\n[dry-run] 未修改文件。确认后加 --apply（建议同时给 --backup <目录>）。')
    process.exit(0)
  }

  let written = 0
  for (const h of hits) {
    if (args.backup) {
      const dest = join(resolve(args.backup), relative(vault, h.file))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(h.file, dest)
    }
    writeFileSync(h.file, h.after, 'utf8')
    written++
  }
  console.log(`\n[OK] 已清理 ${written} 个文件 / ${total} 处引用${args.backup ? `；备份: ${resolve(args.backup)}` : ''}`)
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) main()
