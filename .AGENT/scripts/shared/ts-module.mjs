/**
 * TS 纯模块载入器（契约脚本共用）。
 *
 * 为什么需要：契约脚本要**直接跑真实实现**（而不是复刻一份规则），但源码是 TS 且带
 * 相对 import。此前各脚本各写一段 `stripTypeScriptTypes` + 临时目录，遇到跨文件依赖
 * （如 aiFilePolicyPure → aiTextExts）就只能改写成字符串切片，脆且易漏。
 *
 * 做法：递归把 TS 文件转成 mjs 落到临时目录，并把相对 import 改写到临时文件，
 * 返回最后一个模块的 URL。零第三方依赖。
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

/**
 * 临时产物落在仓库 `tmp/`（.gitignore 已忽略）：必须留在仓库内，
 * 否则第三方依赖（ignore / electron stub 等）的 node 解析会从 /tmp 一路找空。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TMP_BASE = join(REPO_ROOT, 'tmp')

/**
 * @param {string} entryAbs 入口 TS 文件绝对路径
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.stubs] 裸模块名 → 替换后的 import 说明符（如 electron / fs）
 * @param {(src:string, file:string)=>string} [opts.transform] 载入前改写源码（剥注释等）
 * @param {string} [opts.tmpDir] 复用临时目录
 * @returns {Promise<{ mod: any, dir: string }>}
 */
export async function loadTsModule(entryAbs, opts = {}) {
  const tmpDir = opts.tmpDir ?? mkdtempSync(join(TMP_BASE, 'kb-ts-'))
  mkdirSync(tmpDir, { recursive: true })
  const seen = new Map()

  const emit = (abs) => {
    if (seen.has(abs)) return seen.get(abs)
    const outPath = join(tmpDir, `${seen.size}-${abs.replace(/[\\/]/g, '_').replace(/\.ts$/, '')}.mjs`)
    seen.set(abs, outPath)
    let src = readFileSync(abs, 'utf8')
    if (opts.transform) src = opts.transform(src, abs)
    // 相对 import → 递归转换后的临时文件
    src = src.replace(/(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, head, q, spec) => {
      const target = resolve(dirname(abs), spec)
      const resolved = existsSync(`${target}.ts`) ? `${target}.ts` : existsSync(join(target, 'index.ts')) ? join(target, 'index.ts') : null
      if (!resolved) return m
      return `${head}${q}${pathToFileURL(emit(resolved)).href}${q}`
    })
    // 裸模块名 stub
    if (opts.stubs) {
      for (const [from, to] of Object.entries(opts.stubs)) {
        src = src.replace(new RegExp(`(['"])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g'), JSON.stringify(to))
      }
    }
    writeFileSync(outPath, stripTypeScriptTypes(src, { mode: 'transform' }))
    return outPath
  }

  const entryOut = emit(entryAbs)
  const mod = await import(pathToFileURL(entryOut).href)
  return { mod, dir: tmpDir }
}

let pass = 0
let fail = 0
const fails = []

export function ok(name, cond, extra = '') {
  if (cond) pass++
  else { fail++; fails.push(name + (extra ? ` — ${extra}` : '')) }
}

export function report(title) {
  console.log(`\n${title}`)
  console.log(`  PASS ${pass} / FAIL ${fail}`)
  if (fails.length) {
    for (const f of fails) console.log(`  - ${f}`)
    process.exitCode = 1
  }
  return fail === 0
}
