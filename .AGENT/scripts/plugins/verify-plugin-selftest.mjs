#!/usr/bin/env node
/**
 * 契约：`plugin://` 启动自测只挑**真有 UI 入口**的内置插件（2026-10-13，反馈 F-4）。
 *
 * 反馈原话：「现在为什么打开软件后控制台有报错之类的」—— 截图里那行是
 *   `[plugin://] self-test: knowbase.skill-pack/index.html -> HTTP 404`
 *
 * 已核根因：`electron/main/index.ts` 的启动自测**无条件取 `resources/builtin-plugins` 下第一个目录**
 * 去 fetch `<id>/index.html`。而两个内置插件都**没有** index.html：
 *   · `knowbase-skill-pack` —— `type: 'declarative'` 的纯技能包（只贡献 skills，没有 UI）；
 *   · `themes-collection`   —— 只有 icon.svg + plugin.json（主题包）。
 * ⇒ 只要内置插件目录存在，这行**必然 404**：不是插件坏了，是自测选错了对象（假报错）。
 *
 * 修法：按「有没有 index.html」挑；都没有就记一行 skipped 说明，不再报一个不存在的错。
 * 本契约同时做**真值断言**（直接看仓库里那两个内置插件的实际目录）—— 证明"假报错"的前提成立。
 *
 * 跑法：node .AGENT/scripts/plugins/verify-plugin-selftest.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

let failures = 0
const ok = (label, detail) => console.log(`  [OK]   ${label}${detail ? ' —— ' + detail : ''}`)
const bad = (label, detail) => { failures++; console.error(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
const check = (label, cond, detail) => (cond ? ok(label, detail) : bad(label, detail))

const MAIN = read('electron/main/index.ts')

console.log('\n§1 真值断言：内置插件到底有没有 index.html（证明"恒 404"的前提）')

const builtinDir = resolve(ROOT, 'resources/builtin-plugins')
const dirs = existsSync(builtinDir)
  ? readdirSync(builtinDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : []
check('内置插件目录存在且非空', dirs.length > 0, dirs.join('、') || '(空)')
const withIndex = dirs.filter((n) => existsSync(resolve(builtinDir, n, 'index.html')))
check('★ 现状：内置插件里**没有一个**有 index.html（所以旧写法必然 404）',
  withIndex.length === 0, `有 index.html 的：${withIndex.join('、') || '无'}；目录：${dirs.join('、')}`)
check('skill-pack 是 declarative 纯技能包（无 UI）', (() => {
  const p = resolve(builtinDir, 'knowbase-skill-pack/plugin.json')
  if (!existsSync(p)) return false
  try { return JSON.parse(readFileSync(p, 'utf8')).type === 'declarative' } catch { return false }
})())

console.log('\n§2 自测按「有没有 UI 入口」挑，并给跳过说明')

check('★ 挑选条件带 index.html 存在性判断',
  /dirs\.find\(d => existsSync\(join\(builtinDir, d\.name, 'index\.html'\)\)\)/.test(MAIN))
check('负向：不再是"无条件取第一个目录"（旧写法就是假报错的来源）',
  !/readdirSync\(builtinDir, \{ withFileTypes: true \}\)\.find\(d => d\.isDirectory\(\)\)/.test(MAIN))
check('★ 都没有 UI 入口时走 skipped 分支（一行说明，不再打 HTTP 404）',
  /self-test skipped: 内置插件都没有 index\.html/.test(MAIN))
check('skipped 也进 plugin-debug.log（诊断留痕不丢）',
  /pluginDebugLog\(`self-test skipped: 内置插件都没有 index\.html/.test(MAIN))
check('回归：真有 UI 入口时仍然照常 fetch 自测',
  /const testUrl = `plugin:\/\/\$\{manifestId\}\/index\.html`/.test(MAIN) && /net\.fetch\(testUrl\)/.test(MAIN))

console.log('')
if (failures === 0) {
  console.log('PASS  plugin:// 自测：只挑有 UI 入口的内置插件，没有就说明而不是报 404')
  process.exit(0)
}
console.error(`FAIL  ${failures} 项未通过`)
process.exit(1)
