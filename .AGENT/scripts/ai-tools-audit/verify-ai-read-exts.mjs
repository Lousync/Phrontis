// 契约脚本：条目 ⑨「AI 能读仓库内代码/网页文件」——读白名单放开 + 三处清单合一 + 搜索忽略目录
// 对应 DP `Phrontis/更新计划/v3.2.0.md` 条目 9 的实现方案与验证①④。
//
// 规矩：切片真实实现（stripTypeScriptTypes transform + 临时 .mjs import），只 stub 副作用，绝不复刻逻辑。
// 负向 / 计数断言必须先剥注释（感知字符串字面量）。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const NODE = process.execPath

/** 逐字符状态机剥注释（感知 ' " ` 三种字符串字面量，含模板串） */
function stripComments(src) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i++; continue }
      if (c === '/' && n === '*') { state = 'block'; i++; continue }
      if (c === "'") { state = 'sq'; out += c; continue }
      if (c === '"') { state = 'dq'; out += c; continue }
      if (c === '`') { state = 'tpl'; out += c; continue }
      out += c
      continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } continue }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++ } continue }
    if (c === '\\') { out += c + (n ?? ''); i++; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'
      out += c
      continue
    }
    out += c
  }
  return out
}

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) { pass++ } else { fail++; fails.push(name + (extra ? ` — ${extra}` : '')) }
}

// ── 读真实源码 ────────────────────────────────────────────────────────────────────
const pExts = resolve(ROOT, 'src/lib/aiTextExts.ts')
const pTools = resolve(ROOT, 'electron/lib/builtinTools.ts')
const pSources = resolve(ROOT, 'electron/lib/aiTeachingSources.ts')
const pTeach = resolve(ROOT, 'src/modules/ai-teaching/index.tsx')
const rawTools = readFileSync(pTools, 'utf8')
const srcTools = stripComments(rawTools)
const srcSources = stripComments(readFileSync(pSources, 'utf8'))
const srcTeach = stripComments(readFileSync(pTeach, 'utf8'))

// ── ① 单一真相源：清单 28 项、配置类五项不在、关键扩展在 ─────────────────────────
const tmpBase = mkdtempSync(join(tmpdir(), 'verify-ai-read-exts-'))
try {
  const exTs = readFileSync(pExts, 'utf8')
  const exMjs = stripTypeScriptTypes(exTs, { mode: 'transform' })
  const exPath = join(tmpBase, 'aiTextExts.mjs')
  writeFileSync(exPath, exMjs)
  const ex = await import(pathToFileURL(exPath).href)

  ok('清单恰 28 项（33 − 5 配置类）', ex.AI_TEXT_CODE_EXTS.length === 28, `实际 ${ex.AI_TEXT_CODE_EXTS.length}`)
  for (const bad of ['json', 'yml', 'yaml', 'toml', 'ini']) {
    ok(`配置类 .${bad} 不在清单`, !ex.AI_TEXT_CODE_EXT_SET.has(bad))
  }
  for (const need of ['html', 'js', 'py', 'css', 'ts', 'vue']) {
    ok(`关键扩展 .${need} 在清单`, ex.AI_TEXT_CODE_EXT_SET.has(need))
  }

  // ── ② 行为面：切片真实 isAiReadableFile（连 vaultRelParts / isModulesJson / childAiAllowed）──
  // ⚠️ 锚点必须用代码不能注释（本脚本先剥注释）：
  // 切片 1 = VAULT_DOT_DIR 常量起，到 SEARCH_IGNORE_DIRS（walkAiFiles 前的最后一个代码声明）止
  const start = srcTools.indexOf("const VAULT_DOT_DIR = '.knowbase'")
  const end = srcTools.indexOf('const SEARCH_IGNORE_DIRS')
  ok('能定位白名单切片（VAULT_DOT_DIR → SEARCH_IGNORE_DIRS）', start > 0 && end > start, `start=${start} end=${end}`)
  let readFn = null
  let slice1Code = null
  if (start > 0 && end > start) {
    slice1Code = stripTypeScriptTypes(srcTools.slice(start, end), { mode: 'transform' })
    const mjs = [
      "import { relative, sep, extname } from 'node:path'",
      `import { AI_TEXT_CODE_EXT_SET } from ${JSON.stringify(pathToFileURL(exPath).href)}`,
      slice1Code,
    ].join('\n')
    const fnPath = join(tmpBase, 'readWhitelist.mjs')
    writeFileSync(fnPath, mjs)
    readFn = await import(pathToFileURL(fnPath).href)
  }
  if (readFn) {
    // 真实文件系统夹具（对应 DP 实测场景：web/04-list.html 等）
    const root = join(tmpBase, 'vault')
    const mk = (rel) => {
      const f = join(root, rel)
      mkdirSync(dirname(f), { recursive: true })
      if (rel.endsWith('/') || !rel.includes('.')) { mkdirSync(f, { recursive: true }); return f }
      writeFileSync(f, 'x')
      return f
    }
    mk('web/04-list.html'); mk('web/05-link-img.html'); mk('web/img/修改软件图标.png')
    mk('config.yml'); mk('app.ini'); mk('settings.toml'); mk('data.json')
    mk('.knowbase/modules/quiz/quiz.json'); mk('.knowbase/cache/graph.json')
    mk('笔记/内存管理.md'); mk('notes.txt'); mk('UPPER.TXT')
    mk('script.py'); mk('style.css'); mk('App.tsx')
    mk('node_modules/dep.js')
    const R = (rel) => readFn.isAiReadableFile(root, join(root, rel))
    ok('web/04-list.html 可读（本条目主场景）', R('web/04-list.html') === true)
    ok('web/05-link-img.html 可读', R('web/05-link-img.html') === true)
    ok('script.py 可读', R('script.py') === true)
    ok('style.css 可读', R('style.css') === true)
    ok('App.tsx 可读', R('App.tsx') === true)
    ok('.md/.txt 仍可读（含大写扩展名）', R('笔记/内存管理.md') && R('notes.txt') && R('UPPER.TXT'))
    ok('.knowbase/modules/*.json 只读可见', R('.knowbase/modules/quiz/quiz.json') === true)
    ok('图片拒绝', R('web/img/修改软件图标.png') === false)
    ok('配置类拒绝：yml/ini/toml', R('config.yml') === false && R('app.ini') === false && R('settings.toml') === false)
    ok('普通 .json 拒绝（非 modules）', R('data.json') === false)
    ok('.knowbase 非 modules 拒绝', R('.knowbase/cache/graph.json') === false)
    ok('AI 明确给路径时 node_modules 内文件可读（忽略只作用于 search 遍历）', R('node_modules/dep.js') === true)
  }

  // ── ③ 行为面：切片真实 walkAiFiles —— 依赖/产物目录不进搜索预算 ─────────────────
  // 切片 2 = SEARCH_IGNORE_DIRS 起，到 isAiWritableFile（walkAiFiles 的下一个代码声明）止
  const start2 = srcTools.indexOf('const SEARCH_IGNORE_DIRS')
  const end2 = srcTools.indexOf('export function isAiWritableFile')
  ok('能定位 walkAiFiles 切片', start2 > 0 && end2 > start2, `start=${start2} end=${end2}`)
  if (start2 > 0 && end2 > start2) {
    const slice = stripTypeScriptTypes(srcTools.slice(start2, end2), { mode: 'transform' })
    // walkAiFiles 依赖切片 1 里的 childAiAllowed / isAiReadableFile → 两个切片拼进同一模块
    const mjs = [
      "import { join as pjoin, relative, sep, extname } from 'node:path'",
      "import { readdirSync, lstatSync } from 'node:fs'",
      `import { AI_TEXT_CODE_EXT_SET } from ${JSON.stringify(pathToFileURL(exPath).href)}`,
      'const join = pjoin',
      slice1Code ?? '',
      slice,
      'export { walkAiFiles }',
    ].join('\n')
    const fnPath = join(tmpBase, 'walkAi.mjs')
    writeFileSync(fnPath, mjs)
    const walk = await import(pathToFileURL(fnPath).href)
    const root = join(tmpBase, 'vault2')
    const mk = (rel) => {
      const f = join(root, rel)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, 'content')
    }
    mk('web/04-list.html'); mk('.knowbase/modules/q/quiz.json')
    mk('node_modules/dep.js'); mk('node_modules/sub/x.html')
    mk('dist/a.js'); mk('out/b.js'); mk('build/c.js'); mk('其他.md')
    const out = []
    const budget = { count: 0 }
    walk.walkAiFiles(root, root, out, budget)
    const rels = out.map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
    ok('搜索命中可读文件（web html + modules json + 其他.md）', rels.includes('web/04-list.html') && rels.includes('.knowbase/modules/q/quiz.json') && rels.includes('其他.md'), JSON.stringify(rels))
    ok('node_modules 不进搜索结果', !rels.some((r) => r.startsWith('node_modules/')), JSON.stringify(rels))
    ok('dist/out/build 不进搜索结果', !rels.some((r) => r.startsWith('dist/') || r.startsWith('out/') || r.startsWith('build/')))
    ok('预算计数只计可读文件', budget.count === out.length && out.length === 3, `count=${budget.count} len=${out.length}`)
    ok('忽略名单含 node_modules/dist/out/build', ['node_modules', 'dist', 'out', 'build'].every((d) => srcTools.includes(`'${d}'`) && slice.includes(d)))
  }
} finally {
  rmSync(tmpBase, { recursive: true, force: true })
}

// ── ④ 写边界一字未动 ─────────────────────────────────────────────────────────────
ok('isAiWritableFile 仍是仅 .md/.txt（写边界不破）',
  /return ext === 'md' \|\| ext === 'txt'/.test(srcTools) &&
  !/AI_TEXT_CODE_EXT_SET/.test(srcTools.slice(srcTools.indexOf('/** 写白名单'), srcTools.indexOf('/** 文档白名单'))))

// ── ⑤ 三处清单合一（结构断言）──────────────────────────────────────────────────
ok('builtinTools 引入单一真相源', srcTools.includes("from '../../src/lib/aiTextExts'") && srcTools.includes('AI_TEXT_CODE_EXT_SET.has(ext)'))
ok('isAiReadableFile 的 json 分支未放宽（仍 isModulesJson）', srcTools.includes("if (ext === 'json') return isModulesJson(parts)"))
ok('旧白名单写法已消失（return ext === md || txt 直接返回）',
  !/const ext = extname\(abs\)\.slice\(1\)\.toLowerCase\(\)\s*\n\s*if \(ext === 'json'\) return isModulesJson\(parts\)\s*\n\s*return ext === 'md' \|\| ext === 'txt'/.test(srcTools))
ok('素材库 CODE_EXTS 改为引用同一份', srcSources.includes("from '../../src/lib/aiTextExts'") && srcSources.includes('new Set<string>(AI_TEXT_CODE_EXTS)'))
ok('素材库旧 33 项硬编码清单已消失', !srcSources.includes("new Set(['js', 'ts'"))
ok('前端 inferSrcType 改用同一份（AI_TEXT_CODE_EXT_SET.has）', srcTeach.includes("from '../../lib/aiTextExts'") && srcTeach.includes('AI_TEXT_CODE_EXT_SET.has(ext)'))
ok('前端旧 33 项硬编码清单已消失', !srcTeach.includes("'swift', 'kt'"))
ok('前端 AI 教学 import 路径正确（src/lib）', existsSync(pExts))

// ── ⑥ 文案同步 4 处（工具 description ×3 + 错误提示 ×1）──────────────────────────
ok('vault.list 提及可读代码文件', srcTools.includes('（目录与可读文本/代码文件）'))
ok('vault.read 提及文本类代码文件', srcTools.includes('文本类代码文件（.html/.js/.py 等）'))
ok('vault.search 提及文本类代码文件', srcTools.includes('（.md/.txt/文本类代码文件与 .knowbase/modules/*.json）'))
ok('vault.read 错误提示同步（含「配置」拒绝说明）', srcTools.includes('仅支持 .md/.txt 与文本类代码文件（仓库内）') && srcTools.includes('图片、配置与保护区拒绝'))
ok('工具 description 均未超 800 字符红线（抽三处改动的）', [
  '列当前知识仓库某目录下的条目',
  '读取仓库内文件：.md/.txt 与文本类代码文件',
  '在当前知识仓库内按关键词搜索可读文本文件',
].every((s) => {
  const i = srcTools.indexOf(s)
  if (i < 0) return false
  const seg = srcTools.slice(i, srcTools.indexOf("',", i))
  return seg.length <= 800
}))

console.log(`\nverify-ai-read-exts: ${pass} PASS / ${fail} FAIL`)
if (fail) { console.log('\n失败项：'); for (const f of fails) console.log('  ✗ ' + f) }
process.exit(fail ? 1 : 0)
