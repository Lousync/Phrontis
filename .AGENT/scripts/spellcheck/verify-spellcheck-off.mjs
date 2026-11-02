/**
 * 契约：全应用关闭拼写检查（v3.16.1 方案 B）。
 *
 * 失败模式：新增一个 BrowserWindow 忘了 `spellcheck: false`，或某个输入框显式打开
 * `spellCheck={true}` —— 红色波浪线只在一个角落冒出来，不报错、不崩，没人会发现。
 *
 * 锁五件事：
 *   ① 每个 `new BrowserWindow` 的 webPreferences 都含 `spellcheck: false`（数量对得上）；
 *   ② 根文档 `<html spellcheck="false">` 兜底；
 *   ③ 全仓没有显式开启拼写检查；
 *   ④ 截图位置（ShortAnswerCard）显式声明；
 *   ⑤ 扫描器本身有负向自测（漏写开关的 fixture 必须被判失败）。
 *
 * 跑法：node .AGENT/scripts/spellcheck/verify-spellcheck-off.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
const readCode = (p) => stripComments(read(p).replace(/\r\n/g, '\n'))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

/** 从 `{` 起按大括号配平取整段对象（跳过字符串里的括号对本用例足够） */
function objectAt(src, start) {
  let depth = 0
  let quote = ''
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

/**
 * 扫描一段源码里的 `new BrowserWindow({...})`：每个窗口是否在 webPreferences 里关了拼写检查。
 * 纯函数（无 fs），负向自测直接喂 fixture。
 */
export function scanBrowserWindows(src) {
  const out = []
  const re = /new\s+BrowserWindow\s*\(/g
  let m
  while ((m = re.exec(src))) {
    const argStart = src.indexOf('{', m.index + m[0].length)
    if (argStart < 0) continue
    const block = objectAt(src, argStart)
    const wpAt = block.search(/webPreferences\s*:\s*\{/)
    let okSpell = false
    if (wpAt >= 0) {
      const brace = block.indexOf('{', wpAt)
      const wp = objectAt(block, brace)
      okSpell = /spellcheck\s*:\s*false/.test(wp)
    }
    out.push({ block, ok: okSpell })
  }
  return out
}

console.log('=== A. 三个 BrowserWindow 都关掉拼写检查 ===')
{
  let windows = 0
  for (const file of walkSourceFiles(join(repo, 'electron/main'), { exts: ['.ts'] })) {
    const src = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    const found = scanBrowserWindows(src)
    windows += found.length
    const bad = found.filter((w) => !w.ok).length
    ok(bad === 0, `${file.slice(repo.length + 1)} 的 ${found.length} 个窗口都含 spellcheck: false`, bad ? `${bad} 个缺失` : '')
  }
  ok(windows >= 3, '扫描到的 BrowserWindow 数量 ≥ 3（主窗口 / 日程小窗 / 密码填充浮窗）', `实得 ${windows}`)
  ok(windows === (read('electron/main/index.ts').match(/new\s+BrowserWindow\s*\(/g) ?? []).length
    + (read('electron/main/dayPanelWindow.ts').match(/new\s+BrowserWindow\s*\(/g) ?? []).length
    + (read('electron/main/passwordFiller.ts').match(/new\s+BrowserWindow\s*\(/g) ?? []).length,
  '窗口数量与三个构造器文件逐一对得上（没有漏扫）')
}

console.log('\n=== B. 根文档兜底 ===')
ok(/<html[^>]*\bspellcheck="false"/.test(read('index.html')), 'index.html 的 <html> 含 spellcheck="false"')

console.log('\n=== C. 全仓没有显式开启 ===')
{
  const offenders = []
  const roots = [join(repo, 'src'), join(repo, 'electron')]
  for (const root of roots) {
    for (const file of walkSourceFiles(root, { exts: ['.ts', '.tsx'] })) {
      const src = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
      if (/spellCheck\s*=\s*\{?\s*true\s*\}?/.test(src) || /spellcheck\s*:\s*true/.test(src) || /spellcheck\s*=\s*["']true["']/.test(src)) {
        offenders.push(file.slice(repo.length + 1))
      }
    }
  }
  ok(offenders.length === 0, '负向：全仓没有 spellCheck={true} / spellcheck:"true" / spellcheck:true', offenders.join('、'))
}

console.log('\n=== D. 截图位置显式声明 ===')
{
  const card = readCode('src/components/shared/ShortAnswerCard.tsx')
  const at = card.indexOf('<textarea')
  ok(at >= 0 && /spellCheck=\{false\}/.test(card.slice(at, at + 600)),
    'ShortAnswerCard 的作答 textarea 显式 spellCheck={false}')
}

console.log('\n=== E. 扫描器负向自测 ===')
{
  const missing = `const w = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true } })`
  ok(scanBrowserWindows(missing).length === 1 && scanBrowserWindows(missing)[0].ok === false,
    'E1 漏写 spellcheck 的 fixture 必须被判失败')
  const good = `const w = new BrowserWindow({ webPreferences: { sandbox: true, spellcheck: false } })`
  ok(scanBrowserWindows(good)[0]?.ok === true, 'E2 正确写法判通过')
  const two = `${missing}\nconst x = new BrowserWindow({ webPreferences: { spellcheck: false } })`
  ok(scanBrowserWindows(two).filter((w) => w.ok).length === 1, 'E3 一段源码多个窗口时逐个判定（不是只看第一个）')
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
