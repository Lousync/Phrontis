#!/usr/bin/env node
/**
 * 契约验证：离线词典（划词翻译的单词模式）
 *
 * 背景：离线词典的数据文件由 extraResources 落到 `process.resourcesPath/dict`，
 * 而查询算法在 electron/lib/dictionaryCore.ts（零 Electron 依赖）。历史上这里出过
 * 两个「静默失效、无任何报错」的坑，用户只能看到「离线词典未收录」：
 *   §1 打包路径 —— dictionaryService 的打包分支多拼了一层 `resources`，
 *      所有安装版词典加载失败，**每个单词**（包括 the / is）都查不到；
 *   §2 查询覆盖 —— 文章里的缩写（it's / don't / they're）在任何词库分支里都不存在，
 *      即使资源正常也一律「未收录」。
 *
 * 验证两件事：
 *   §1 打包布局契约 —— package.json 的 extraResources 映射与 dictionaryService 的
 *      打包分支必须指向同一位置（直接断言源码里的解析表达式）；
 *   §2 查询用例表 —— 直接跑**真实查询算法**（dictionaryCore.lookupInDict + 真实词库），
 *      覆盖直接命中 / lemma / 规则变形 / 缩写 / 弯撇号 / 首尾标点 / 未收录。
 *
 * 运行（任意目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/translate/verify-dict-lookup.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lookupInDict } from '../../../electron/lib/dictionaryCore.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const DICT_PATH = join(ROOT, 'resources', 'dict', 'ecdict-exam.json')
const SERVICE_PATH = join(ROOT, 'electron', 'lib', 'dictionaryService.ts')

let failures = 0
const pass = (m) => console.log(`  [OK]   ${m}`)
const fail = (m) => { failures++; console.error(`  [FAIL] ${m}`) }

// ---- §1 打包布局契约 ----
console.log('[1] packaged resource layout')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
const extra = pkg?.build?.extraResources ?? []
const dictEntry = extra.find((e) => typeof e === 'object' && e && e.from === 'resources/dict')
if (dictEntry && dictEntry.to === 'dict') pass("extraResources: resources/dict -> 'dict'")
else fail(`extraResources 映射应为 resources/dict -> 'dict'，实际 ${JSON.stringify(dictEntry)}`)

const serviceSrc = readFileSync(SERVICE_PATH, 'utf-8')
const expectedExpr = "join(process.resourcesPath, 'dict', 'ecdict-exam.json')"
if (serviceSrc.includes(expectedExpr)) pass(`dictionaryService packaged branch: ${expectedExpr}`)
else fail('dictionaryService 打包分支未指向 process.resourcesPath/dict（多拼 resources 会让安装版词典永远为空）')
if (/resourcesPath,\s*'resources'/.test(serviceSrc)) fail("打包分支出现 resourcesPath + 'resources' 的重复拼接")
else pass('打包分支没有重复拼接 resources')

// ---- §2 查询用例表 ----
console.log('[2] lookup cases')
const dict = JSON.parse(readFileSync(DICT_PATH, 'utf-8'))
const wordCount = Object.keys(dict.words).length
if (wordCount > 20000) pass(`dictionary loaded: ${wordCount} words`)
else fail(`词库条数异常: ${wordCount}`)

const CASES = [
  // [查询词, 期望命中, 期望词条原形, 说明]
  ['the', true, 'the', '极简高频词'],
  ['abandon', true, 'abandon', '考纲词'],
  ['  “Word,”  ', true, 'word', '首尾标点/引号'],
  ['children', true, 'child', 'lemma 不规则复数'],
  ['went', true, 'go', 'lemma 不规则过去式'],
  ['scrolling', true, 'scroll', '规则变形兜底（词库无该词形）'],
  // 词形表优先级：lemma.en.txt 末尾的低频同形词条（wa/ha/doe）曾覆盖正确映射
  ['is', true, 'be', 'lemma 优先级（曾错到 i）'],
  ['was', true, 'be', 'lemma 优先级（曾指向 wa 查不到）'],
  ['has', true, 'have', 'lemma 优先级（曾错到 ha）'],
  ['does', true, 'do', 'lemma 优先级（曾错到 doe/母鹿）'],
  ["don't", true, 'do', "缩写 n't"],
  ["isn't", true, 'be', "缩写 n't（base 走 lemma）"],
  ["won't", true, 'will', '不规则缩写'],
  ["can't", true, 'can', '不规则缩写'],
  ["it's", true, 'it', "缩写 's"],
  ['It’s', true, 'it', '弯撇号（PDF/排版）'],
  ["they're", true, 'they', "缩写 're"],
  ["we've", true, 'we', "缩写 've"],
  ["let's", true, 'let', "缩写 's（let's）"],
  ["I'm", true, 'i', "缩写 'm（单字母原形）"],
  ["couldn't", true, 'could', "缩写 n't"],
  ['students’', true, 'student', '所有格撇号 + 复数'],
  ['zzzzqqq', false, '', '未收录'],
]

for (const [input, wantFound, wantWord, label] of CASES) {
  const r = lookupInDict(dict, input)
  if (r.found !== wantFound) {
    fail(`${label}: "${input}" 期望 found=${wantFound}，实际 found=${r.found}`)
    continue
  }
  if (!wantFound) { pass(`${label}: "${input}" 未收录`); continue }
  const got = r.entry?.word
  if (got === wantWord) pass(`${label}: "${input}" -> ${got}`)
  else fail(`${label}: "${input}" 期望原形 ${wantWord}，实际 ${got}`)
}

// 还原来源标注（UI 显示「xx 的词形还原」）
const inflected = lookupInDict(dict, "They're")
if (inflected.entry?.inflectedFrom === "they're") pass('inflectedFrom 标记还原来源')
else fail(`inflectedFrom 应为 "they're"，实际 ${JSON.stringify(inflected.entry?.inflectedFrom)}`)

console.log('')
if (failures > 0) {
  console.error(`FAIL (${failures} 项)`)
  process.exit(1)
}
console.log('PASS')
