#!/usr/bin/env node
/**
 * 契约验证：设置 → 快捷键「指令表」的**渲染等价**（真组件 SSR）。
 *
 * 为什么需要它：数据层契约（.AGENT/scripts/commands/verify-commands-registry.mjs）只能证明
 * 「真源里的数据是对的」，断不到「真源投影到 DOM 之后还是对的」——
 *   · 组件把 chords 写成 keys 了 / 少套一层 map → 键帽挤成一串或整组空掉；
 *   · 组间分隔符条件写错（gi > 0 写成 gi >= 0）→ 每行多一个 `/`；
 *   · 真源里多一组、组件没渲染 / 渲染了两次 → 锚点集合或顺序不对；
 *   · undefined 漏进 DOM（组 id 打错时最典型）。
 *
 * ★ 期望值**从真源算出来**（不是手写数字）：组的锚点序列、每组行数、每组键帽序列、组间分隔符
 *   个数，全部由 COMMAND_GROUPS / COMMANDS 投影得到。所以这不是「拿 61 去比 61」，
 *   而是「DOM 必须逐字等于真源的投影」—— 真源改了，这条断言自动跟着改，不会变成过期数字。
 *
 * 沙箱约束：受限会话里 node 用**管道** stdio 拉子进程会被拒（spawn EPERM），
 * 故两次子进程（esbuild / 内层 node）一律 stdio:'inherit'，不做输出捕获。
 *
 * 用法：node .AGENT/scripts/commands/verify-commands-render.mjs
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { COMMANDS, COMMAND_GROUPS, commandsOfGroup } from '../../../src/lib/commandRegistry.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const TMP = join(ROOT, 'tmp', 'commands-render')
const ENTRY = join(TMP, '.render-entry.tsx')
const OUT = join(TMP, '.render-out.mjs')
const ESBUILD = join(ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')

/** 真源 → DOM 的期望投影（顺序即渲染顺序） */
const EXPECT = {
  anchors: COMMAND_GROUPS.map((g) => g.anchor),
  rowsTotal: COMMANDS.length,
  groups: COMMAND_GROUPS.map((g) => {
    const rows = commandsOfGroup(g.id)
    return {
      anchor: g.anchor,
      label: g.label,
      rows: rows.length,
      // 该组全部键帽（按行序、组序摊平）与组间分隔符个数
      chips: rows.flatMap((c) => c.keys.flat()),
      seps: rows.reduce((n, c) => n + (c.keys.length - 1), 0),
    }
  }),
}

const entry = `
import { renderToStaticMarkup } from 'react-dom/server'
// 相对路径（不是绝对路径）：内层 node 跑的是 esbuild 产物，而 Windows 绝对路径在 ESM 里
// 必须是 file:// URL，直接写 E:/… 会被解析成协议 'e:' 而报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
import { ShortcutsView } from '../../src/modules/settings/views/ShortcutsView'

const EXPECT = ${JSON.stringify(EXPECT)} as {
  anchors: string[]
  rowsTotal: number
  groups: { anchor: string; label: string; rows: number; chips: string[]; seps: number }[]
}

let pass = 0
const fails: string[] = []
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { pass++; return }
  fails.push(label + (detail ? '  -> ' + detail : ''))
}

let html = ''
try {
  html = renderToStaticMarkup(<ShortcutsView />)
} catch (e: any) {
  fails.push('R0 SSR 渲染抛异常：' + (e?.stack || e))
}

if (html) {
  // ★ 设置页的键帽是 <span>（不是 <kbd>）—— 与工作台空态那几行不同。首版断言按 <kbd> 写，
  //   于是「数到 0 枚键帽」被报成失败：组件没问题，是检查写错了。按 class 里的 min-w-[20px] 认。
  const chipsOf = (s: string) => [...s.matchAll(/min-w-\\[20px\\][^>]*>([^<]*)</g)].map((m) => m[1])
  // ★ 分隔符必须按 **class** 认，不能按「大于号 斜杠 小于号」这种文本认：Ctrl+斜杠（切换预览）
  //   那枚键帽的文本恰好也是一个斜杠，按文本数会把键帽当成分隔符 —— kbEditor 组因此被数成 2 个
  //   （1 真 + 1 假），首版就是这么假报的。分隔符 class 里有 px-0.5，键帽里有 min-w-[20px]。
  //   （本注释刻意不写反引号：它在**外层模板字面量**里会直接把模板结束掉，首版栽过一次。）
  const sepsOf = (s: string) => (s.match(/class="px-0\\.5[^>]*>\\/<\\/span>/g) || []).length
  const anchorAt = (a: string) => html.indexOf('data-setting-anchor="' + a + '"')

  const anchors = [...html.matchAll(/data-setting-anchor="([^"]+)"/g)].map((m) => m[1])
  ok(anchors.join('|') === EXPECT.anchors.join('|'),
    'R1 渲染出的组锚点序列逐字等于真源（' + EXPECT.anchors.length + ' 组）',
    '实际 ' + anchors.join(','))

  const rows = (html.match(/justify-between py-1\\.5/g) || []).length
  ok(rows === EXPECT.rowsTotal, 'R2 渲染行数 = 真源命令数（' + EXPECT.rowsTotal + '）', '实际 ' + rows)

  // 逐组：块内行数 / 键帽序列 / 分隔符个数 / 组标题
  for (let i = 0; i < EXPECT.groups.length; i++) {
    const g = EXPECT.groups[i]
    const from = anchorAt(g.anchor)
    const to = i + 1 < EXPECT.groups.length ? anchorAt(EXPECT.groups[i + 1].anchor) : html.length
    if (from < 0 || to <= from) { fails.push('R3-' + g.anchor + ' 区块切不出来'); continue }
    const block = html.slice(from, to)
    const gotChips = chipsOf(block)
    ok(block.indexOf(g.label) > -1, 'R3-' + g.anchor + ' 组标题出现', g.label)
    ok(gotChips.join('|') === g.chips.join('|'),
      'R4-' + g.anchor + ' 键帽序列逐字等于真源（' + g.chips.length + ' 枚）',
      '实际 ' + gotChips.join('|'))
    const seps = sepsOf(block)
    ok(seps === g.seps, 'R5-' + g.anchor + ' 组间分隔符个数 = 真源（' + g.seps + '）', '实际 ' + seps)
  }

  // 那行「三选一」单独点名：7 枚键帽 + 2 个分隔符才是「三组同效」，不是一长串
  const iSearch = html.indexOf('全局搜索（左栏搜索态')
  ok(iSearch > -1, 'R6 有「全局搜索（左栏搜索态…）」这一行')
  if (iSearch > -1) {
    const rowStart = html.lastIndexOf('py-1.5', iSearch)
    const searchRow = html.slice(rowStart, html.indexOf('</div>', iSearch))
    const sChips = chipsOf(searchRow)
    const seps = sepsOf(searchRow)
    // 反引号在**外层模板字面量**里必须绕开（本注释本身也不能出现该字符）：写「两个反斜杠 +
    // 反引号」会被解析成「转义反斜杠 + 结束模板」，整个检查脚本直接语法错，连 esbuild 都跑不到。
    const TICK = String.fromCharCode(96)
    ok(sChips.join('|') === ['Ctrl', 'P', 'Ctrl', TICK, 'Ctrl', 'Shift', 'F'].join('|'),
      'R7 ★ 三选一那行键位 = Ctrl P / Ctrl 反引号 / Ctrl Shift F', sChips.join('|'))
    ok(seps === 2, 'R8 ★ 该行恰 2 个 / 分隔符（3 组 - 1）', '实际 ' + seps)
  }

  // 内容级抽查（数据层契约管不到的可见文案）
  ok(!/保存全部/.test(html), 'R9 页面上无「保存全部」（Ctrl+Shift+S 死键）')
  ok(!/可在设置改键/.test(html), 'R10 页面上无「可在设置改键」（密码本那句不实描述）')
  ok(/密码填充弹窗开关（系统级）/.test(html), 'R11 密码本行文案 = 密码填充弹窗开关（系统级）')
  ok(!/undefined/.test(html) && !/NaN/.test(html), 'R12 无 undefined / NaN 漏进 DOM')
  ok((html.match(/Ctrl<\\/span>/g) || []).length > 10, 'R13 键帽确实是 span 形态（本文件断言口径的前提）')
}

console.log('')
if (fails.length === 0) {
  console.log('PASS  ShortcutsView 渲染等价：' + pass + ' 项断言（期望值全部由真源投影得到）')
  process.exit(0)
}
console.log('FAIL  ' + fails.length + ' 项未通过（PASS ' + pass + '）：')
for (const f of fails) console.log('  - ' + f)
process.exit(1)
`
if (!existsSync(ESBUILD)) {
  console.log(`FAIL  找不到 esbuild：${ESBUILD}`)
  process.exit(1)
}
mkdirSync(TMP, { recursive: true })
writeFileSync(ENTRY, entry, 'utf8')

const b = spawnSync(ESBUILD, [
  ENTRY, '--bundle', `--outfile=${OUT}`, '--format=esm', '--platform=node', '--jsx=automatic',
  '--packages=external',
], { stdio: 'inherit' })
if (b.status !== 0) {
  console.log(`FAIL  esbuild 打包失败（exit ${b.status}）`)
  rmSync(ENTRY, { force: true })
  process.exit(1)
}

const r = spawnSync(process.execPath, [OUT], { stdio: 'inherit' })

rmSync(ENTRY, { force: true })
rmSync(OUT, { force: true })
process.exit(r.status ?? 1)
