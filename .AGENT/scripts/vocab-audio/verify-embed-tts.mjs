#!/usr/bin/env node
/**
 * 契约：嵌入版读单词 = 系统 TTS（免网）
 *
 * 背景：vocab:// 的 CSP 只放行自身资源，有道云端 mp3 结构性不可达；旧实现把发音 hook
 * 整个换成 noop，表象是「按钮点了没反应」。现在的约定是：
 *   1. 补丁脚本在 embed 分支调用 useEmbedPronunciationSound（不是 noop）；
 *   2. 该 hook 只用 speechSynthesis，不做 fetch / new Audio（不联网）；
 *   3. 没有可用语音时静默（拿 getVoices 判空），不冒险触发音频栈；
 *   4. 云端音频白名单不得被放开（media-src 不出现 dict.youdao.com）；
 *   5. 按键音仍保持嵌入模式关闭。
 *
 * 用法：node .AGENT/scripts/vocab-audio/verify-embed-tts.mjs
 * 说明：vendor / resources/vocab 未构建时只跑源码侧断言并给出 SKIP。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PATCH = join(ROOT, 'scripts', 'vocab', 'patch-upstream.mjs')
const UPSTREAM = join(ROOT, 'vendor', 'qwerty-learner')
const HOOK = join(UPSTREAM, 'src', 'hooks', 'useEmbedPronunciation.ts')
const PRON = join(UPSTREAM, 'src', 'hooks', 'usePronunciation.ts')
const MAIN = join(ROOT, 'electron', 'main', 'index.ts')
const BUILD_ASSETS = join(ROOT, 'resources', 'vocab', 'assets')

let pass = 0
let fail = 0
let skip = 0

function read(p) {
  return readFileSync(p, 'utf8')
}

function ok(name) {
  pass++
  console.log(`[PASS] ${name}`)
}

function bad(name, detail) {
  fail++
  console.log(`[FAIL] ${name}${detail ? `\n       ${detail}` : ''}`)
}

function skipped(name, why) {
  skip++
  console.log(`[SKIP] ${name}（${why}）`)
}

function assert(cond, name, detail) {
  if (cond) ok(name)
  else bad(name, detail)
}

function assertIncludes(text, needle, name) {
  assert(text.includes(needle), name, `未找到：${needle}`)
}

function assertExcludes(text, needle, name) {
  assert(!text.includes(needle), name, `不应出现：${needle}`)
}

// ---------- 1. 补丁脚本 ----------
{
  const text = read(PATCH)
  assertIncludes(text, 'useEmbedPronunciationSound(word, isLoop)', '补丁：embed 分支调用系统 TTS hook')
  assertExcludes(
    text,
    'if (isEmbed()) return { play: noop, stop: noop, isPlaying: false }',
    '补丁：不再把嵌入版发音换成 noop',
  )
  assertIncludes(text, "import { isEmbed } from '@/utils/phrontisBridge'", '补丁：usePronunciation 仍引入 isEmbed（预取门禁用）')
  assertIncludes(text, 'if (isEmbed()) return [noop, noop, noop]', '补丁：按键音在嵌入模式仍关闭')
}

// ---------- 2. 补丁后的上游源码（vendor 存在时） ----------
if (existsSync(HOOK)) {
  const hook = read(HOOK)
  assertIncludes(hook, 'window.speechSynthesis', 'hook：使用 speechSynthesis')
  assertIncludes(hook, 'new SpeechSynthesisUtterance', 'hook：构造 utterance')
  assertIncludes(hook, 'getVoices()', 'hook：读取系统语音列表')
  assertIncludes(hook, 'localService', 'hook：优先本地语音（离线可用）')
  assertIncludes(hook, 'kk-KZ', 'hook：哈萨克语 → kk-KZ / ru-RU 回退')
  assertIncludes(hook, 'romajiToHiragana', 'hook：罗马音转假名后朗读')
  assertExcludes(hook, 'new Audio(', 'hook：不新建 Audio（不走网络音频）')
  assertExcludes(hook, 'fetch(', 'hook：不做网络请求')
  assertIncludes(hook, 'voices.length', 'hook：无可用语音时静默')

  const pron = read(PRON)
  assertIncludes(pron, 'if (isEmbed()) return useEmbedPronunciationSound(word, isLoop)', '源码：embed 分支指向 TTS hook')
  assertIncludes(pron, 'if (!word || isEmbed()) return', '源码：云端音频预取在 embed 仍关闭')
} else {
  skipped('vendor 源码断言', 'vendor/qwerty-learner 未就绪，跳过')
}

// ---------- 3. 构建产物 ----------
if (existsSync(BUILD_ASSETS)) {
  const files = readdirSync(BUILD_ASSETS).filter((f) => f.endsWith('.js'))
  const texts = files.map((f) => read(join(BUILD_ASSETS, f)))
  const joined = texts.join('\n')
  const ttsBundle = texts.find((t) => t.includes('kk-KZ') && t.includes('new SpeechSynthesisUtterance'))
  assert(Boolean(ttsBundle), '产物：主包内含系统 TTS 实现（kk-KZ + SpeechSynthesisUtterance）')
  assert(joined.includes('getVoices'), '产物：保留系统语音探测（getVoices）')
  assertExcludes(joined, 'play:ts,stop:ts', '产物：发音不再被 noop 替换')
} else {
  skipped('构建产物断言', 'resources/vocab 未构建，跳过')
}

// ---------- 4. 宿主侧安全与接线 ----------
{
  const main = read(MAIN)
  assertExcludes(main, "media-src 'self' data: https://dict.youdao.com", 'CSP：未放开有道云端音频')
  const iframe = read(join(ROOT, 'src', 'modules', 'vocab', 'index.tsx'))
  assertIncludes(iframe, 'embed=1', '接线：iframe 以 embed=1 加载（embed 分支才会生效）')
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail} / SKIP ${skip}`)
if (fail > 0) process.exit(1)
